// server/agents/subagents.ts — the subagents of a Claude session, for the
// thread view. A subagent's messages and tool steps are not in the session
// file: the harness writes them to
//   <session file without .jsonl>/subagents/agent-<agentId>.jsonl
// with a small agent-<agentId>.meta.json beside it. In the session file a
// subagent is one Agent (or Task) step, and the result of that step names the
// agentId (thread.ts puts it on the step). So the reader goes from a step to
// its two files by name: it never lists the folder (one real session holds
// 690 files there) and reads only the subagents a request names.
//
// Cost. A summary is kept per subagent file with a byte cursor. A poll for a
// subagent whose file did not change is one read of the meta file and one
// lstat; a changed file costs the appended bytes. The first look at a file
// reads at most `tail` bytes of its end, and one request reads at most
// `budget` bytes of files it has no summary for.
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { helperSpawn } from "../chief/hardened.js";
import { at, O_DIR } from "./nofollow.js";
import { openTranscript, readCalls, type Transcript } from "./sessionread.js";
import { isSubagentId, type ThreadItem } from "./thread.js";
import { readThreadAfterOpen, THREAD_LIMITS, type ThreadLimits } from "./threadfile.js";

export type SubagentState = {
  id: string;
  description: string;
  agentType: string;
  // running: no end recorded and the file is still written to. done: its turn
  // ended. stopped: no end recorded, and nothing can write it any more (the
  // agent's process is gone) or nothing did for `stale` ms.
  state: "running" | "done" | "stopped";
  // Its first line; known when the file was read from its start.
  start?: number;
  // The last write to its file (mtime).
  last: number;
  // When it ended: its last line. Absent while it runs.
  end?: number;
  // Tool steps so far; absent when the file was not read (the byte budget of
  // the request ended). `more`: the read began after the start of the file,
  // so `steps` counts only the part read.
  steps?: number;
  more?: true;
  // Its current step, or its last one when it ended.
  step?: string;
  // 2 or more: started by another subagent.
  depth?: number;
};

export type SubagentLimits = {
  meta: number;     // a larger meta file is not read
  tail: number;     // bytes of a file's end the first look reads
  budget: number;   // bytes one request reads from files it has no summary for
  stale: number;    // ms with no write after which an open subagent counts as stopped
  cache: number;    // summaries kept
};

export const SUBAGENT_LIMITS: SubagentLimits = {
  meta: 16 << 10, tail: 4 << 20, budget: 24 << 20, stale: 60 * 60_000, cache: 1024,
};

// A request names at most this many subagents (the steps of its page first).
export const MAX_SUBAGENTS = 48;

// The meta file rewrites a moment before the last line lands (55 ms on a real
// run); a file written later than this after it was marked finished was
// resumed (SendMessage).
const RESUME_SLACK_MS = 3000;

// The subagents folder of one session, opened without following a symlink at
// the session folder, at `subagents`, or at a file in it (in a hardened
// deployment the projects dir is the agent's own to write). `file`/`meta` give
// a path that is valid until close().
export type SubagentDir = {
  file(id: string): string;
  meta(id: string): string;
  close(): Promise<void>;
};

export async function openSubagentDir(sessionPath: string): Promise<SubagentDir | null> {
  if (!sessionPath.endsWith(".jsonl")) return null;
  const base = sessionPath.slice(0, -".jsonl".length);
  const names = { file: (id: string) => `agent-${id}.jsonl`, meta: (id: string) => `agent-${id}.meta.json` };
  // openat through /proc is Linux only (nofollow.ts). Elsewhere the two
  // folders are plain path segments; the files still open with O_NOFOLLOW.
  // Strong protection: the console cannot open these folders (the agent's home is 0700); the
  // helper reads each file by its plain path and refuses a link in any part (sessionread.ts).
  if (process.platform !== "linux" || helperSpawn()) {
    const dir = join(base, "subagents");
    return { file: (id) => join(dir, names.file(id)), meta: (id) => join(dir, names.meta(id)), close: async () => {} };
  }
  let top: FileHandle;
  try { top = await open(base, O_DIR); } catch { return null; }
  try {
    const dir = await open(at(top, "subagents"), O_DIR);
    return {
      file: (id) => at(dir, names.file(id)),
      meta: (id) => at(dir, names.meta(id)),
      close: () => dir.close().catch(() => {}),
    };
  } catch {
    return null;
  } finally {
    await top.close().catch(() => {});
  }
}

type Meta = { description: string; agentType: string; finished: boolean; mtime: number; depth: number };

const flat = (v: unknown, max: number): string => {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

// Strong protection: each read of a file is one helper call (sudo and the helper: tens of ms).
// A meta file read, and the summary of a subagent file, are kept this long: a running subagent
// then costs at most two calls in this time, whatever the pace of the polls, and its state
// changes at most this much later.
export const META_KEEP_MS = 3000;
const metas = new Map<string, { meta: Meta | null; at: number }>();

async function readMeta(path: string, limits: SubagentLimits): Promise<Meta | null> {
  const keep = helperSpawn();
  const now = Date.now();
  const kept = keep ? metas.get(path) : undefined;
  if (kept && now - kept.at < META_KEEP_MS) return kept.meta;
  const meta = await readMetaNow(path, limits);
  if (keep) {
    metas.delete(path);
    metas.set(path, { meta, at: now });
    while (metas.size > limits.cache) metas.delete(metas.keys().next().value as string);
  }
  return meta;
}

async function readMetaNow(path: string, limits: SubagentLimits): Promise<Meta | null> {
  const t = await openTranscript(path, { pos: 0, len: limits.meta });
  if (!t) return null;
  try {
    const st = t.facts;
    if (st.size > limits.meta) return null;
    const o: unknown = JSON.parse((await t.read(0, st.size)).toString("utf8"));
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const m = o as Record<string, unknown>;
    return {
      description: flat(m.description, 140),
      agentType: flat(m.agentType, 60),
      finished: m.finished === true,
      mtime: st.mtimeMs,
      depth: typeof m.spawnDepth === "number" && m.spawnDepth > 0 ? Math.floor(m.spawnDepth) : 1,
    };
  } catch {
    return null; // a meta file half written, or not JSON
  } finally {
    await t.close();
  }
}

// What one read of a subagent file told, kept between requests.
type Summary = {
  at?: number;          // when it was read (strong protection: kept META_KEEP_MS)
  size: number;
  mtime: number;
  cursor: number;       // just past the last complete line read
  steps: number;
  more: boolean;
  step?: string;        // label of the newest step
  first?: number;       // ts of the first line (read from offset 0 only)
  lastTs: number;       // ts of the newest item
  final: boolean;       // the newest item is the message that ended a turn
};

const summaries = new Map<string, Summary>();

function remember(key: string, s: Summary, max: number): void {
  summaries.delete(key);
  summaries.set(key, s);
  while (summaries.size > max) summaries.delete(summaries.keys().next().value as string);
}

function fold(s: Summary, items: ThreadItem[]): void {
  for (const it of items) {
    if (it.kind === "step") {
      s.steps++;
      s.step = it.label;
    }
    const ts = it.kind === "step" && it.end !== undefined ? Math.max(it.ts, it.end) : it.ts;
    if (ts > s.lastTs) s.lastTs = ts;
    if (s.first === undefined && !s.more && it.ts) s.first = it.ts;
    s.final = it.kind === "assistant" && it.final === true;
  }
}

const READ: ThreadLimits = { ...THREAD_LIMITS };

// The summary of one subagent file, brought up to date. `budget.left` is what
// this request may still read from files it has no summary for; with none left
// the answer is the size and mtime alone ("stat"). Null: no such file.
async function summarize(
  path: string, key: string, budget: { left: number }, limits: SubagentLimits,
): Promise<Summary | { stat: { mtime: number } } | null> {
  const held = summaries.get(key);
  if (held?.at !== undefined && helperSpawn() && Date.now() - held.at < META_KEEP_MS) return held;
  // One open gives the facts and, for a file read before, the bytes after its cursor.
  const t = await openTranscript(path, held ? { pos: held.cursor, len: READ.chunk } : undefined);
  if (!t) return null;
  try {
    return await summarizeOpen(t, key, held, budget, limits);
  } catch {
    return null;
  } finally {
    await t.close();
  }
}

async function summarizeOpen(
  t: Transcript, key: string, held: Summary | undefined, budget: { left: number }, limits: SubagentLimits,
): Promise<Summary | { stat: { mtime: number } }> {
  const size = t.facts.size;
  const mtime = t.facts.mtimeMs;
  if (held && held.size === size && held.mtime === mtime) {
    if (helperSpawn()) held.at = Date.now();
    return held;
  }

  // Go on from the cursor when the file only grew; else read its end again.
  let s: Summary;
  let from: number;
  if (held && size >= held.cursor && size - held.cursor <= READ.forward) {
    s = { ...held };
    from = held.cursor;
  } else {
    from = Math.max(0, size - limits.tail);
    if (size - from > budget.left) return { stat: { mtime } };
    budget.left -= size - from;
    s = { size, mtime, cursor: from, steps: 0, more: from > 0, lastTs: 0, final: false };
  }
  // A cursor inside a line is fine: the cut line does not parse and is dropped.
  const page = await readThreadAfterOpen(t, from, READ, { sidechain: true });
  if (page === "reset") return { stat: { mtime } }; // it changed under the read; the next poll reads it
  fold(s, page.items);
  s.size = size;
  s.mtime = mtime;
  s.cursor = page.end;
  if (helperSpawn()) s.at = Date.now();
  remember(key, s, limits.cache);
  return s;
}

// `alive`: the agent's Claude process can still run a subagent.
export type SubagentCtx = { alive: boolean; now: number };

function stateOf(meta: Meta | null, sum: { final: boolean; mtime: number }, ctx: SubagentCtx, limits: SubagentLimits): SubagentState["state"] {
  if (sum.final) return "done";
  // Marked finished with no closing message (it failed, or was stopped), and
  // not written to since. The harness sets the mark a moment before the
  // closing message lands, so a fresh mark waits: "done" is told only when the
  // closing message can be read, or when none came.
  if (meta?.finished && sum.mtime <= meta.mtime + RESUME_SLACK_MS && ctx.now - meta.mtime >= RESUME_SLACK_MS) return "done";
  if (!ctx.alive || ctx.now - sum.mtime > limits.stale) return "stopped";
  return "running";
}

// Strong protection: the most helper calls of one request for the subagents it looks at for the
// first time (a meta file, the facts and the tail of the file: up to FIRST_LOOK_CALLS each). The
// others are left out of this answer and kept here; the next requests of that session look at
// them (the page draws such a subagent from its launch step meanwhile).
export const FIRST_LOOK_BUDGET = 12;
export const FIRST_LOOK_CALLS = 3;
const later = new Map<string, Set<string>>();
// Whether a session has subagents left for a later request.
export const hasLaterSubagents = (sessionPath: string): boolean => later.has(sessionPath);

// The state of the named subagents of one session: `ids` in order, at most
// MAX_SUBAGENTS, each checked before it becomes a file name. A subagent with
// no file is left out.
export async function subagentStates(
  sessionPath: string, ids: readonly string[], ctx: SubagentCtx, limits: SubagentLimits = SUBAGENT_LIMITS,
): Promise<Record<string, SubagentState>> {
  const out: Record<string, SubagentState> = {};
  const wanted = [...new Set([...ids, ...(later.get(sessionPath) ?? [])])].filter(isSubagentId).slice(0, MAX_SUBAGENTS);
  later.delete(sessionPath);
  if (wanted.length === 0) return out;
  const dir = await openSubagentDir(sessionPath);
  if (!dir) return out;
  const strong = helperSpawn();
  const left: string[] = [];
  try {
    const budget = { left: limits.budget };
    let firstCalls = FIRST_LOOK_BUDGET;
    for (const id of wanted) {
      const key = `${sessionPath}\0${id}`;
      const first = strong && !summaries.has(key);
      if (first && firstCalls < FIRST_LOOK_CALLS) { left.push(id); continue; }
      const before = readCalls();
      // The meta file first: its mtime must not be newer than the look at the
      // subagent file it is compared with.
      const meta = await readMeta(dir.meta(id), limits);
      const sum = await summarize(dir.file(id), key, budget, limits);
      if (first) firstCalls -= readCalls() - before;
      if (!sum) continue;
      const read = "stat" in sum ? null : sum;
      const mtime = Math.round(read ? read.mtime : (sum as { stat: { mtime: number } }).stat.mtime);
      const state = stateOf(meta, { final: read?.final ?? false, mtime }, ctx, limits);
      out[id] = {
        id,
        description: meta?.description ?? "",
        agentType: meta?.agentType ?? "",
        state,
        last: mtime,
        ...(read?.first ? { start: read.first } : {}),
        ...(state !== "running" ? { end: read?.lastTs || mtime } : {}),
        ...(read ? { steps: read.steps } : {}),
        ...(read?.more ? { more: true as const } : {}),
        ...(read?.step ? { step: read.step } : {}),
        ...(meta && meta.depth > 1 ? { depth: meta.depth } : {}),
      };
    }
  } finally {
    await dir.close();
  }
  if (left.length) {
    later.set(sessionPath, new Set(left));
    while (later.size > limits.cache) later.delete(later.keys().next().value as string);
  }
  return out;
}

// The subagents a page of items names (the launch steps, and the launch
// results of steps in an earlier page), newest first.
export function subagentIdsOf(items: readonly ThreadItem[]): string[] {
  const ids: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if ((it.kind === "step" || it.kind === "end") && it.agent) ids.push(it.agent);
  }
  return ids;
}

// The quiet signal of the thread (`lastEntryAt`, threadfile.ts) is the session
// file's last write. A running subagent writes its own file, not the session
// file, so its last write counts too: the agent is at work while one of them
// writes. A subagent that ended or stopped does not count.
export function newestWrite(lastEntryAt: number, subs: Record<string, SubagentState>): number {
  let newest = lastEntryAt;
  for (const id in subs) if (subs[id].state === "running" && subs[id].last > newest) newest = subs[id].last;
  return newest;
}

// For tests: forget every summary, every kept meta file and every subagent left for later.
export function clearSubagentSummaries(): void { summaries.clear(); metas.clear(); later.clear(); }
