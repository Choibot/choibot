// server/chief/queue/store.ts — one JSON file per queue item at <dir>/<id>.json
// (spec §4.3), with the two queue locks of spec §5.4:
// - the store-wide add lock serializes add(): the pr dedup is a
//   read-then-write across items, and the relay and an agent can add one URL
//   at once. It covers only the dedup check and the new file's write;
// - the item lock (withItem) covers every read-modify-write of one item.
// The two never nest, and add() calls onChange only after its lock is free.
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, onChain } from "../files.js";
import { newItemId, type QueueItem } from "./types.js";

export type NewItem = Omit<QueueItem, "id" | "createdAt" | "updatedAt" | "status" | "history" | "answerSeq">;

export const ITEM_ID_RE = /^q[0-9a-z]{8}$/;
const FILE_RE = /^(q[0-9a-z]{8})\.json$/;
const KINDS = ["pr", "choice", "preview", "question", "deploy", "limit"] as const satisfies readonly QueueItem["kind"][];
const STATUSES = ["open", "answered", "auto", "undone", "withdrawn", "snoozed"] as const satisfies readonly QueueItem["status"][];
const NEW_ID_TRIES = 10;

type Opts = { onChange?: (item: QueueItem) => void; now?: () => number; newId?: () => string; log?: (s: string) => void };

// The stored shape, as far as readers dereference it: every object a reader
// opens is an object, every array an array, every id or key the right type.
// Leaf values a reader only compares (checks, mergeable, state, awaiting …)
// stay loose, and unknown keys pass, so a valid item is never dropped. A
// hand-edited file that fails is skipped like a torn one, so it never breaks
// the API, the scanner, dedup or the card index at boot.
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const answerShape = obj({ value: z.string(), by: z.string(), via: z.string(), at: z.number(), ruleIds: z.array(z.string()).optional(),
  images: z.array(obj({ name: z.string(), path: z.string() })).optional() });
const deliveryShape = obj({ msgId: z.string(), state: z.string(), attempts: z.number() });
const storedItem = obj({
  id: z.string(), kind: z.enum(KINDS), status: z.enum(STATUSES),
  agentId: z.string(), createdBy: obj({ agentId: z.string(), kind: z.string() }),
  repo: z.string(), area: z.string(), title: z.string(), body: z.string(),
  createdAt: z.number(), updatedAt: z.number(), closedAt: z.number().optional(),
  snoozedUntil: z.number().optional(), blocking: z.boolean(),
  pr: z.union([
    obj({ url: z.string(), number: z.number() }),
    obj({ local: obj({ repo: z.string(), branch: z.string(), aheadAtAdd: z.boolean().optional() }) }),
  ]).optional(),
  choice: obj({ options: z.array(obj({ key: z.string(), label: z.string(), detail: z.string().optional() })) }).optional(),
  preview: obj({ images: z.array(z.string()), url: z.string().optional() }).optional(),
  html: obj({ bytes: z.number(), height: z.number().optional() }).optional(),
  share: obj({ docId: z.string(), link: z.string(), at: z.number(), device: z.string(), checked: z.boolean() }).optional(),
  deploy: obj({
    live: z.string(), target: z.string(), count: z.number(), more: z.number(), note: z.string().optional(),
    prs: z.array(obj({ number: z.number(), title: z.string() })),
    run: obj({
      id: z.string(), via: z.string(), phase: z.enum(["running", "done", "failed"]), step: z.string(), startedAt: z.number(),
      from: z.string(), to: z.string(), error: z.string().optional(), tail: z.string().optional(),
    }).optional(),
  }).optional(),
  limit: obj({
    rows: z.array(obj({
      agentId: z.string(), key: z.string(), tag: z.string(), name: z.string(), login: z.string(), loginName: z.string(),
      until: z.number().nullable(), room: z.boolean(), state: z.string(),
    })),
    to: obj({ id: z.string(), name: z.string() }).optional(),
    quietAt: z.number().optional(),
  }).optional(),
  rule: obj({ id: z.string() }).optional(),
  recommend: obj({ value: z.string(), why: z.string(), ruleIds: z.array(z.string()), by: z.string(), at: z.number() }).optional(),
  answer: answerShape.optional(), history: z.array(answerShape),
  delivery: deliveryShape.optional(), withdrawal: deliveryShape.optional(),
  telegram: obj({ cardMessageId: z.number().optional(), mediaMessageIds: z.array(z.number()).optional(), extraMessageIds: z.array(z.number()).optional(),
    postFailed: z.boolean().optional(), renderHash: z.string().optional(),
    autoMessageId: z.number().optional(), autoCleared: z.boolean().optional(), mediaFailed: z.boolean().optional() }).optional(),
  lastError: z.string().optional(), answerSeq: z.number(),
}).refine((i) => (i.kind !== "pr" || i.pr !== undefined)
  && (i.kind !== "choice" || i.choice !== undefined)
  && (i.kind !== "preview" || i.preview !== undefined)
  && (i.kind !== "deploy" || i.deploy !== undefined)
  && (i.kind !== "limit" || i.limit !== undefined));

function isItem(v: unknown, id: string): v is QueueItem {
  return storedItem.safeParse(v).success && (v as QueueItem).id === id;
}

// The dedup key of a pr item: its URL, or repo + branch for a local one.
function prKey(item: Pick<QueueItem, "pr">): string | null {
  const pr = item.pr;
  if (!pr) return null;
  return "url" in pr ? `url ${pr.url}` : `local ${pr.local.repo}\n${pr.local.branch}`;
}

const blocksDedup = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";

export class QueueStore {
  private readonly onChange?: (item: QueueItem) => void;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (s: string) => void;
  private readonly addKey: string;
  private readonly badLogged = new Set<string>();

  constructor(readonly dir: string, opts: Opts = {}) {
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? newItemId;
    this.log = opts.log ?? ((s) => console.warn(s));
    this.addKey = `queue-add:${dir}`;
  }

  async get(id: string): Promise<QueueItem | null> {
    if (!ITEM_ID_RE.test(id)) return null;
    const r = await this.load(id);
    return r === "bad" ? null : r;
  }

  // Every readable item, oldest first. A torn, hand-edited or unreadable file
  // is skipped and logged once.
  async list(): Promise<QueueItem[]> {
    return this.readAll(await this.ids());
  }

  // Dedup: a pr item whose URL (or local repo + branch) matches an open or
  // snoozed item returns that item's id and writes nothing.
  // `opts.id` is a pre-assigned id (a preview's media folder is named by it
  // before the item exists); it must be free, else add throws.
  async add(input: NewItem, opts: { id?: string } = {}): Promise<{ id: string; created: boolean }> {
    const r = await onChain(this.addKey, async (): Promise<{ id: string; item?: QueueItem }> => {
      const ids = await this.ids();
      const key = prKey(input);
      if (key) {
        const dup = (await this.readAll(ids)).find((i) => blocksDedup(i) && prKey(i) === key);
        if (dup) return { id: dup.id };
      }
      const taken = new Set(ids);
      let id = opts.id ?? this.newId();
      if (opts.id !== undefined) {
        this.file(id); // rejects a malformed id
        if (taken.has(id)) throw new Error(`queue: item id ${id} is taken`);
      } else {
        for (let i = 1; taken.has(id); i++) {
          if (i >= NEW_ID_TRIES) throw new Error("queue: no free item id");
          id = this.newId();
        }
      }
      const now = this.now();
      const item: QueueItem = { ...input, id, createdAt: now, updatedAt: now, status: "open", history: [], answerSeq: 0 };
      await atomicWrite(this.file(id), JSON.stringify(item, null, 2));
      return { id, item };
    });
    // The add lock is released here, so the hub event may take the item lock.
    if (r.item) this.emit(r.item);
    return { id: r.id, created: r.item !== undefined };
  }

  // The item lock. Not re-entrant: fn must not call withItem for the same id
  // (it would wait on itself forever), nor await add() (the add lock and the
  // item lock never nest, spec §5.4).
  withItem<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return onChain(`queue-item:${id}`, fn);
  }

  // Call inside withItem(item.id) only. Writes the item with a new updatedAt,
  // sets the same updatedAt on the caller's object once the file is written
  // (a failed write leaves it unchanged), and calls onChange.
  async write(item: QueueItem): Promise<void> {
    const next: QueueItem = { ...item, updatedAt: this.now() };
    await atomicWrite(this.file(item.id), JSON.stringify(next, null, 2));
    item.updatedAt = next.updatedAt;
    this.emit(next);
  }

  // Where an item's preview images live: <dir>/media/<id>/<n>.<ext>.
  get mediaDir(): string { return join(this.dir, "media"); }

  // The stored copy of an item's rich part (types.ts `html`): <dir>/media/<id>/page.html. The
  // media route never serves it (its name is not an image name); only GET /api/queue/:id/page
  // reads it, and checks it again (rich.ts).
  pagePath(id: string): string {
    this.file(id); // rejects a malformed id
    return join(this.mediaDir, id, "page.html");
  }

  // Call inside withItem(id) only. Also deletes the item's media folder.
  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
    await rm(join(this.mediaDir, id), { recursive: true, force: true });
  }

  private file(id: string): string {
    if (!ITEM_ID_RE.test(id)) throw new Error(`bad queue item id: ${String(id).slice(0, 40)}`);
    return join(this.dir, `${id}.json`);
  }

  // Item ids with a file in the dir (tmp files and other names excluded).
  private async ids(): Promise<string[]> {
    let names: string[];
    try { names = await readdir(this.dir); } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw err;
    }
    return names.flatMap((n) => FILE_RE.exec(n)?.[1] ?? []);
  }

  private async readAll(ids: string[]): Promise<QueueItem[]> {
    const all = await Promise.all(ids.map(async (id) => {
      let r: QueueItem | null | "bad";
      let why = "torn or not a queue item";
      try { r = await this.load(id); } catch (err) { r = "bad"; why = String((err as Error).message ?? err); }
      if (r === "bad") {
        if (!this.badLogged.has(id)) { this.badLogged.add(id); this.log(`queue: skipped ${id}.json: ${why}`); }
        return null;
      }
      if (r) this.badLogged.delete(id);
      return r;
    }));
    return all.filter((i): i is QueueItem => i !== null).sort((a, b) => a.createdAt - b.createdAt);
  }

  // null: no file (missing, or removed since readdir). "bad": torn JSON or
  // not a queue item. Other read errors (EACCES, EIO) throw.
  private async load(id: string): Promise<QueueItem | null | "bad"> {
    let v: unknown;
    try { v = JSON.parse(await readFile(this.file(id), "utf8")); } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      if (err instanceof SyntaxError) return "bad";
      throw err;
    }
    return isItem(v, id) ? v : "bad";
  }

  private emit(item: QueueItem): void {
    try { this.onChange?.(item); } catch (err) { this.log(`queue: onChange failed for ${item.id}: ${String((err as Error).message ?? err)}`); }
  }
}
