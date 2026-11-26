// server/chief/queue/share.ts — "Share outside" on a ticket (the user's ask of 2026-11-20: a page
// for the user stays in the ticket; the share service is for a page the user gives to another
// person, and that is one press). Four routes (api.ts), all USER only (gateUser):
//   GET  /api/queue/:id/share        what goes out and what the share tool's check found
//   POST /api/queue/:id/share        { accept: [hit texts] }: check again, then the tool's `add`
//   POST /api/queue/:id/share/stop   the tool's `remove`: the link stops working
//   GET  /api/queue/:id/share/file   the same file, as a download (the action with no share tool)
// The file is built here from the queue's stored, checked copy (shareDoc.ts): the browser sends a
// ticket id and the hits it said yes to, never HTML and never a path. A hit the user did not say
// yes to refuses the publish. The password and the one-tap link are in the answer of the publish
// only: the ticket keeps the plain link, the page id, when and by which device. One log line per
// publish and per removal, with no password.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { buildShareFile } from "./shareDoc.js";
import {
  checkLink, parseAdd, parseRemove, parseScan, SHARE_TIMEOUT_MS, toolProblem, toolRunner, type Hit, type RunTool,
} from "./shareTool.js";
import type { QueueStore } from "./store.js";
import type { QueueItem } from "./types.js";

export type ShareState = NonNullable<QueueItem["share"]>;
export type ShareResult = { code: number; body: Record<string, unknown> };
// What the confirm step shows (GET).
export type ShareView = {
  tool: boolean; shared: ShareState | null;
  what: { title: string; body: boolean; page: boolean };
  hits: Hit[];
};

export type QueueShareDeps = {
  store: QueueStore;
  // The share tool now (Settings → Share outside changes it with no restart). null = not set.
  tool: () => string | null;
  // Tests: a fake run of the tool, and of the console's own look at a link.
  run?: (tool: string) => RunTool;
  check?: (url: string) => Promise<boolean>;
  toolProblem?: (path: string) => Promise<string | null>;
  log?: (s: string) => void;
  now?: () => number;
};

const acceptBody = z.object({ accept: z.array(z.string().max(400)).max(60).default([]) }).strict();
const NO_TOOL = "No share tool is set. Set one in Settings, Share outside.";

export class QueueShare {
  private readonly running = new Set<string>();
  private readonly log: (s: string) => void;
  private readonly now: () => number;

  constructor(private readonly d: QueueShareDeps) {
    this.log = d.log ?? ((s) => console.warn(s));
    this.now = d.now ?? Date.now;
  }

  async view(id: string): Promise<ShareResult> {
    const item = await this.d.store.get(id);
    if (!item) return { code: 404, body: { error: "not found" } };
    const what = { title: item.title, body: item.body.trim() !== "", page: !!item.html };
    const tool = this.d.tool();
    if (item.share || !tool) return { code: 200, body: { tool: !!tool, shared: item.share ?? null, what, hits: [] } satisfies ShareView };
    const r = await this.withFile(item, async (file, run) => parseScan(await run(["scan", file], SHARE_TIMEOUT_MS.scan)));
    if ("code" in r) return r;
    if (!r.ok) return { code: 502, body: { error: r.error } };
    return { code: 200, body: { tool: true, shared: null, what, hits: r.hits } satisfies ShareView };
  }

  // The publish (POST). `device`: the paired device that pressed (the log line, the ticket).
  async publish(id: string, body: unknown, device: string): Promise<ShareResult> {
    const b = acceptBody.safeParse(body ?? {});
    if (!b.success) return { code: 400, body: { error: "The request was not understood." } };
    return this.once(id, async () => {
      const item = await this.d.store.get(id);
      if (!item) return { code: 404, body: { error: "not found" } };
      if (item.share) return { code: 409, body: { error: "This ticket is already shared. Stop sharing it first.", reason: "shared", item } };
      if (!this.d.tool()) return { code: 409, body: { error: NO_TOOL, reason: "no-tool" } };
      const r = await this.withFile(item, async (file, run) => {
        // The check runs again on the file that goes out: a hit the user did not say yes to stops it.
        const scan = parseScan(await run(["scan", file], SHARE_TIMEOUT_MS.scan));
        if (!scan.ok) return { code: 502, body: { error: scan.error } };
        const yes = new Set(b.data.accept);
        const open = scan.hits.filter((h) => !yes.has(h.text));
        if (open.length) return { code: 409, body: { error: "The check found something you did not say yes to. Look again.", reason: "hits", hits: scan.hits } };
        return parseAdd(await run(scan.hits.length ? ["add", file, "--allow-sensitive"] : ["add", file], SHARE_TIMEOUT_MS.add));
      });
      if ("code" in r) return r;
      if (!r.ok) {
        this.log(`[queue] ${id}: share outside failed (device ${device})`);
        return { code: 502, body: { error: r.error } };
      }
      // The tool did not check its work (it exited with an error after the link): the console looks once.
      const checked = r.checked || (await (this.d.check ?? checkLink)(r.link));
      const share: ShareState = { docId: r.docId, link: r.link, at: this.now(), device, checked };
      let saved: QueueItem | null = null;
      try {
        saved = await this.d.store.withItem(id, async () => {
          const cur = await this.d.store.get(id);
          if (!cur) return null;
          const next = { ...cur, share };
          await this.d.store.write(next);
          return next;
        });
      } catch (e) {
        this.log(`[queue] ${id}: shared outside as ${r.docId} by device ${device}, but the ticket was not updated: ${e instanceof Error ? e.message : String(e)}`);
        return { code: 500, body: { error: `The page is out (id ${r.docId}), but the ticket could not keep it. Remove it with your share tool.` } };
      }
      this.log(`[queue] ${id}: shared outside as ${r.docId} by device ${device}${checked ? "" : " (the link did not open from this server)"}`);
      if (!saved) return { code: 404, body: { error: `The ticket is gone. The page is out (id ${r.docId}): remove it with your share tool.` } };
      return { code: 200, body: { item: saved, link: r.link, oneTap: r.oneTap, password: r.password } };
    });
  }

  async stop(id: string, device: string): Promise<ShareResult> {
    return this.once(id, async () => {
      const item = await this.d.store.get(id);
      if (!item) return { code: 404, body: { error: "not found" } };
      const share = item.share;
      if (!share) return { code: 409, body: { error: "This ticket is not shared.", reason: "not-shared", item } };
      const tool = this.d.tool();
      if (!tool) return { code: 409, body: { error: NO_TOOL, reason: "no-tool" } };
      const problem = await (this.d.toolProblem ?? toolProblem)(tool);
      if (problem) return { code: 409, body: { error: `The share tool cannot run: ${problem}` } };
      const r = parseRemove(await (this.d.run ?? toolRunner)(tool)(["remove", share.docId], SHARE_TIMEOUT_MS.remove));
      if (!r.ok) {
        this.log(`[queue] ${id}: stop sharing ${share.docId} failed (device ${device})`);
        return { code: 502, body: { error: r.error } };
      }
      const saved = await this.d.store.withItem(id, async () => {
        const cur = await this.d.store.get(id);
        if (!cur) return null;
        const { share: _gone, ...rest } = cur;
        const next = rest as QueueItem;
        await this.d.store.write(next);
        return next;
      });
      this.log(`[queue] ${id}: stopped sharing ${share.docId} by device ${device}`);
      return { code: 200, body: { item: saved } };
    });
  }

  // The download: the same file, with or without a share tool.
  async file(id: string): Promise<{ code: 200; html: string; name: string } | ShareResult> {
    const item = await this.d.store.get(id);
    if (!item) return { code: 404, body: { error: "not found" } };
    const built = await this.build(item);
    if (!built.ok) return { code: 422, body: { error: built.error } };
    return { code: 200, html: built.html, name: fileName(item) };
  }

  // One share action per ticket at a time (two devices, a double press).
  private async once(id: string, fn: () => Promise<ShareResult>): Promise<ShareResult> {
    if (this.running.has(id)) return { code: 409, body: { error: "A share action of this ticket already runs.", reason: "running" } };
    this.running.add(id);
    try { return await fn(); } finally { this.running.delete(id); }
  }

  private async build(item: QueueItem): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
    let source: string | null = null;
    if (item.html) {
      try { source = await readFile(this.d.store.pagePath(item.id), "utf8"); } catch { return { ok: false, error: "The page of this ticket cannot be read." }; }
    }
    return buildShareFile(item, source);
  }

  // The file in a private temp folder for one run of the tool, removed after it.
  private async withFile<T>(item: QueueItem, fn: (file: string, run: RunTool) => Promise<T>): Promise<T | ShareResult> {
    const tool = this.d.tool();
    if (!tool) return { code: 409, body: { error: NO_TOOL, reason: "no-tool" } };
    const problem = await (this.d.toolProblem ?? toolProblem)(tool);
    if (problem) return { code: 409, body: { error: `The share tool cannot run: ${problem}` } };
    const built = await this.build(item);
    if (!built.ok) return { code: 422, body: { error: built.error } };
    const dir = await mkdtemp(join(tmpdir(), "console-share-"));
    try {
      const file = join(dir, `${item.id}.html`);
      await writeFile(file, built.html, { mode: 0o600 });
      return await fn(file, (this.d.run ?? toolRunner)(tool));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// "Pick a database.html": the title in plain characters.
export function fileName(item: Pick<QueueItem, "title" | "id">): string {
  const base = item.title.normalize("NFKD").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return `${base || item.id}.html`;
}
