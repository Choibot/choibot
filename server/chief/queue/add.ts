// server/chief/queue/add.ts — the queue add service (spec §5.1-§5.3).
// All gh and git calls run here, outside any queue lock, through injected deps; only
// then does store.add take its lock.
import type { AgentRecord, SessionStore } from "../../agents/store.js";
import type { PrStatus } from "../../gh/status.js";
import { prSlug } from "../../gh/status.js";
import { repoNameOf } from "../../master/events.js";
import type { Caller } from "../auth.js";
import { acceptMedia, readAgentFile } from "./media.js";
import { checkRich, RICH_MAX_BYTES, RICH_MAX_TEXT } from "./rich.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AddInputValue } from "./schema.js";
import type { NewItem, QueueStore } from "./store.js";
import { newItemId, type QueueItem } from "./types.js";
import { CLONE_NO_HELPER, agentClones, isClone, readAsAgent } from "../../agents/agentclone.js";
import type { AsAgent } from "./media.js";

export type AddDeps = {
  store: QueueStore; agents: Pick<SessionStore, "load">; workspaceDir: string;
  // The dirs a preview's agent cwd may sit in (acceptMedia; built once in index.ts).
  agentRoots: string[];
  listRepos: (ws: string) => Promise<{ name: string; slug: string; path: string }[]>;
  prStatus: (repoPath: string, pr: number) => Promise<PrStatus>;
  // Resolves true on exit 0, false only when git says not-an-ancestor (exit 1),
  // rejects on any other git error (addItem then leaves aheadAtAdd absent).
  isAncestor: (repoPath: string, branch: string, base: string) => Promise<boolean>;
  areaOf?: (repo: string) => Promise<string>; // Phase 3 (AreaStore.areaOf); default async (r) => r
};
export class QueueAddError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); this.name = "QueueAddError"; }
}
export type CreatedBy = QueueItem["createdBy"];

export function createdByOf(caller: Caller, rec: AgentRecord | null): CreatedBy {
  const agentId = caller.agentId ?? rec?.id;
  if (!agentId) throw new Error("createdByOf: caller has no agent id");
  if (rec?.kind === "issue") return { agentId, kind: "issue" };
  if (caller.level === "lead") return { agentId, kind: "lead" };
  if (caller.level === "master") return { agentId, kind: "fleet-master" };
  if (caller.level === "coordinator") return { agentId, kind: "coordinator" };
  return { agentId, kind: "worker" };
}

// The workspace repo a PR url belongs to (GitHub slugs are case-insensitive), or undefined.
export async function repoOfPrUrl(d: Pick<AddDeps, "listRepos" | "workspaceDir">, url: string): Promise<{ name: string; slug: string; path: string } | undefined> {
  const slug = prSlug(url)?.toLowerCase();
  return (await d.listRepos(d.workspaceDir)).find((r) => r.slug.toLowerCase() === slug);
}

async function urlPr(d: AddDeps, url: string): Promise<NonNullable<NewItem["pr"]>> {
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  const pr: NonNullable<NewItem["pr"]> = { url, number };
  try {
    const repo = await repoOfPrUrl(d, url);
    if (!repo) return pr;
    const st = await d.prStatus(repo.path, number);
    return { url, number, checks: st.checks.rollup, mergeable: st.mergeable };
  } catch { return pr; } // a gh failure stores the item without checks
}

export async function addItem(d: AddDeps, agentId: string, input: AddInputValue, createdBy: CreatedBy): Promise<{ id: string; created: boolean }> {
  const rec = await d.agents.load(agentId);
  if (!rec) throw new QueueAddError(404, "unknown agent");
  const repo = repoNameOf(rec);
  let pr: NewItem["pr"];
  if (input.pr && "url" in input.pr) pr = await urlPr(d, input.pr.url);
  else if (input.pr) {
    if (!rec.repo) throw new QueueAddError(400, "no repo for a local pr");
    const local: { repo: string; branch: string; aheadAtAdd?: boolean } = { repo, branch: input.pr.branch };
    try { local.aheadAtAdd = !(await d.isAncestor(rec.repo, input.pr.branch, rec.baseBranch)); } catch { /* unknown */ }
    pr = { local };
  }
  // A lead's own item (repo "") carries the lead's area; any other item maps its repo.
  const area = rec.area ?? await (d.areaOf ?? (async (r: string) => r))(repo);
  // The rich part: read from the agent's folder (the boundary of an image, media.ts) and checked
  // before anything is written. A refusal names its reason: nothing is repaired (rich.ts).
  let page: string | undefined;
  if (input.html) {
    const f = await readAgentFile({ roots: d.agentRoots, cwd: rec.cwd ?? rec.worktree, path: input.html.file, maxBytes: RICH_MAX_BYTES, maxText: `${RICH_MAX_TEXT} (the limit of a ticket page)`, ...asAgentOpt(rec) });
    if (!f.ok) throw new QueueAddError(400, `html: ${f.error}`);
    try { page = new TextDecoder("utf-8", { fatal: true }).decode(f.data); } catch { throw new QueueAddError(400, "html: the file is not UTF-8 text"); }
    const c = checkRich(page);
    if (!c.ok) throw new QueueAddError(400, `html: ${c.error}`);
  }
  // The images of a preview item, or of a pr item that carries screenshots
  // (overview decision 65), are copied before the item exists, into a folder
  // named by the item's id; the copy is undone if the add does not complete.
  let id: string | undefined;
  let images: string[] | undefined;
  if (input.preview) {
    id = newItemId();
    const r = await acceptMedia({
      roots: d.agentRoots, cwd: rec.cwd ?? rec.worktree, images: input.preview.images, destDir: join(d.store.mediaDir, id), ...asAgentOpt(rec),
    });
    if (!r.ok) throw new QueueAddError(400, r.error);
    images = r.names;
  }
  // Best effort, but a folder left behind is logged (no other path removes it).
  const dropFolder = async (mediaId: string): Promise<void> => {
    await rm(join(d.store.mediaDir, mediaId), { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`[chief] queue add: media cleanup failed for ${mediaId}: ${(err as NodeJS.ErrnoException | undefined)?.code ?? "error"}`);
    });
  };
  // The copy of the page, in the item's own folder: the ticket does not change when the agent's
  // file does. Written as the agent gave it; every read checks it again.
  if (page !== undefined) {
    id ??= newItemId();
    const path = d.store.pagePath(id);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, page, { mode: 0o600, flag: "wx" });
    } catch (e) {
      await dropFolder(id);
      throw e;
    }
  }
  const item: NewItem = {
    kind: input.kind, agentId, createdBy, repo, area, title: input.title, body: input.body,
    blocking: input.blocking ?? (input.kind === "question" || input.kind === "choice"),
    ...(pr ? { pr } : {}),
    ...(input.options ? { choice: { options: input.options } } : {}),
    ...(input.preview ? { preview: images ? { ...input.preview, images } : input.preview } : {}),
    ...(page !== undefined ? { html: { bytes: Buffer.byteLength(page, "utf8"), ...(input.html?.height !== undefined ? { height: input.html.height } : {}) } } : {}),
  };
  if (id === undefined) return d.store.add(item);
  try {
    const r = await d.store.add(item, { id });
    // An open pr item for the same PR exists (the store's dedup): this add made no item, so its
    // folder has no owner.
    if (r.id !== id) await dropFolder(id);
    return r;
  } catch (e) {
    await dropFolder(id);
    throw e;
  }
}

// Strong protection with its helper: the console opens no path in an agent's folder (a clone, or a
// persistent agent's home); each file is read AS the agent (agentclone.ts). An agent with its own
// clone and no helper: refused, never a read by the console.
function asAgentOpt(rec: { clone?: boolean }): { asAgent?: AsAgent } {
  const x = agentClones();
  if (x) return { asAgent: (abs, max) => readAsAgent(x, abs, max) };
  if (isClone(rec)) throw new QueueAddError(400, CLONE_NO_HELPER);
  return {};
}
