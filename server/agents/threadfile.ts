// server/agents/threadfile.ts — reads an agent's Claude session file for the
// thread view. A session file grows to tens of MB (most of it request blobs
// the thread never shows), so nothing here reads it whole:
//   - readThreadBefore: the tail, or the page before a cursor, read backwards
//     in fixed chunks until it holds enough messages or the scan budget ends;
//   - readThreadAfter: only the bytes appended since a cursor (the live poll).
// Cursors are byte offsets. Memory is bounded by one chunk plus one line cap;
// a longer line is skipped without being held. Every read goes through
// sessionread.ts (with strong protection: the helper, as the agent).
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRecord } from "./store.js";
import { accountPaths } from "./accounts.js";
import { isSessionId } from "./hooks.js";
import { agentClaudeConfigDir, claudeTranscriptPath } from "./runtimes/claude.js";
import { pick } from "./runtimes/index.js";
import { helperSpawn } from "../chief/hardened.js";
import { openTranscript, TranscriptChanged, type Transcript } from "./sessionread.js";
import { foldEnds, isMessage, parseSessionLine, wantsLine, type ParseOpts, type ThreadItem } from "./thread.js";

export type ThreadLimits = {
  chunk: number;      // bytes per read
  maxLine: number;    // a longer line is skipped, never buffered
  scan: number;       // bytes one backward read may scan
  forward: number;    // bytes one forward read may cover; more → reset
  messages: number;   // a backward read stops once it holds this many messages
  items: number;      // …or this many items of any kind
};

export const THREAD_LIMITS: ThreadLimits = {
  chunk: 1 << 20, maxLine: 8 << 20, scan: 32 << 20, forward: 16 << 20, messages: 30, items: 400,
};

// `start`: the cursor for the page before this one; null when the file's first
// line is in it. `end`: the cursor for readThreadAfter (just past the last
// complete line read). `lastEntryAt`: when the file last got a line of any type
// (its mtime, from the stat the open already makes), for the quiet signal.
export type ThreadPage = { items: ThreadItem[]; start: number | null; end: number; lastEntryAt: number };

const NL = 10;
const EMPTY: Buffer = Buffer.alloc(0);

// A message to an idle agent is three lines in a few ms: enqueue, dequeue, the
// user line. A read that lands between them would show the message as
// "waits" until the next read. So wait-line lines at the very end of the file
// that are younger than this are left for the next read (the cursor stays
// before them). A message that does wait is shown this much later.
export const QUEUE_SETTLE_MS = 500;
export type ReadOpts = ParseOpts & { now?: () => number };

// The line gave only a wait-line item whose partner line can still come.
function unsettled(got: ThreadItem[]): number | null {
  if (got.length !== 1) return null;
  const it = got[0];
  return it.kind === "queued" || (it.kind === "unqueue" && it.op === "dequeue") ? it.ts : null;
}

type Session = { t: Transcript; size: number; mtime: number };

// `first`: the range read first (in the same helper call as the facts, with strong protection).
async function openSession(path: string, first?: { pos: number; len: number }): Promise<Session | null> {
  const t = await openTranscript(path, first);
  return t ? { t, size: t.facts.size, mtime: Math.round(t.facts.mtimeMs) } : null;
}

function itemsOf(line: Buffer, opts?: ParseOpts): ThreadItem[] {
  if (line.length < 2 || line[0] !== 123 /* { */) return [];
  // Decide on the first bytes, before a multi-megabyte line becomes a string.
  if (!wantsLine(line.subarray(0, 48).toString("latin1"))) return [];
  return parseSessionLine(line.toString("utf8"), opts);
}

// The page that ends at `before` (null: at the end of the file), or null when
// the file cannot be read. A cursor inside a line is fine: the cut line is dropped.
// `opts.sidechain`: the file is a subagent's own (subagents.ts).
export async function readThreadBefore(
  path: string, before: number | null, limits: ThreadLimits = THREAD_LIMITS, opts?: ReadOpts,
): Promise<ThreadPage | null> {
  const f = await openSession(path);
  if (!f) return null;
  try {
    return await readBefore(f, before, limits, opts);
  } catch (e) {
    if (e instanceof TranscriptChanged) return null; // the next read sees the new file
    throw e;
  } finally {
    await f.t.close();
  }
}

async function readBefore(f: Session, before: number | null, limits: ThreadLimits, opts?: ReadOpts): Promise<ThreadPage> {
  const from = before === null ? f.size : Math.max(0, Math.min(before, f.size));
  let pos = from;           // bytes [pos, from) are read
  let carry: Buffer = EMPTY; // a line whose start is not read yet; it begins at pos
  let skipping = true;      // the bytes down to the next newline are cut or oversized: dropped
  let end = from;           // just past the last complete line: set at the first newline found
  let endSet = false;
  let earliest = from;      // start of the earliest line already turned into items
  let scanned = 0;
  let messages = 0;
  let count = 0;
  const lines: ThreadItem[][] = []; // newest line first
  const starts: number[] = [];      // where each of them begins in the file
  let full = false;

  const take = (line: Buffer, startAt: number): void => {
    earliest = startAt;
    const got = itemsOf(line, opts);
    if (got.length === 0) return;
    lines.push(got);
    starts.push(startAt);
    count += got.length;
    for (const it of got) if (isMessage(it)) messages++;
    if (messages >= limits.messages || count >= limits.items) full = true;
  };

  while (pos > 0 && !full && scanned < limits.scan) {
    const n = Math.min(limits.chunk, pos);
    const buf = await f.t.read(pos - n, n);
    if (buf.length < n) break;
    pos -= n;
    scanned += n;
    let data: Buffer;
    if (skipping) {
      const cut = buf.lastIndexOf(NL);
      if (cut < 0) continue; // still inside the dropped line
      skipping = false;
      if (!endSet) { end = pos + cut + 1; endSet = true; earliest = end; }
      data = buf.subarray(0, cut + 1);
    } else {
      data = carry.length ? Buffer.concat([buf, carry]) : buf;
    }
    carry = EMPTY;
    // data = s0 \n s1 \n … sk \n: s1…sk are whole lines; s0's start is unknown.
    let lineEnd = data.length - 1; // index of the newline that ends the line in hand
    while (!full) {
      // Never lastIndexOf(…, -1): a negative offset counts from the end.
      const prev = lineEnd > 0 ? data.lastIndexOf(NL, lineEnd - 1) : -1;
      if (prev < 0) break;
      take(data.subarray(prev + 1, lineEnd), pos + prev + 1);
      lineEnd = prev;
    }
    if (full) break;
    if (lineEnd + 1 > limits.maxLine) skipping = true; // s0 is too long to keep
    else carry = data.subarray(0, lineEnd + 1);
  }

  let start: number | null;
  if (full) start = earliest;
  else if (pos === 0) {
    // The first line of the file: whole, unless it was dropped as oversized.
    if (!skipping && carry.length > 1) take(carry.subarray(0, carry.length - 1), 0);
    // No newline at all before `from`: no complete line yet.
    if (!endSet) end = 0;
    start = null;
  } else {
    // The scan budget ended. Resume inside a dropped line, else at the line after the carry.
    start = skipping ? pos : pos + carry.length;
  }
  if (start === 0) start = null;
  // The newest lines are of the wait line and a moment old: the next read takes them.
  if (before === null) {
    let n = 0;
    while (n < lines.length && unsettled(lines[n]) !== null) n++;
    if (n > 0 && (opts?.now ?? Date.now)() - (unsettled(lines[n - 1]) as number) < QUEUE_SETTLE_MS) {
      end = starts[n - 1];
      lines.splice(0, n);
    }
  }
  return { items: foldEnds(lines.reverse().flat()), start, end, lastEntryAt: f.mtime };
}

// The items appended after `after`. "reset": the cursor does not fit the file
// (it was replaced, or too much was appended to read as a delta); the caller
// then serves the tail. null: the file cannot be read.
export async function readThreadAfter(
  path: string, after: number, limits: ThreadLimits = THREAD_LIMITS, opts?: ReadOpts,
): Promise<ThreadPage | "reset" | null> {
  const f = await openSession(path, { pos: after, len: limits.chunk });
  if (!f) return null;
  try {
    return await readAfter(f, after, limits, opts);
  } finally {
    await f.t.close();
  }
}

// The same on a session file that the caller opened (subagents.ts: its facts decide first).
export async function readThreadAfterOpen(
  t: Transcript, after: number, limits: ThreadLimits = THREAD_LIMITS, opts?: ReadOpts,
): Promise<ThreadPage | "reset"> {
  return readAfter({ t, size: t.facts.size, mtime: Math.round(t.facts.mtimeMs) }, after, limits, opts);
}

async function readAfter(f: Session, after: number, limits: ThreadLimits, opts?: ReadOpts): Promise<ThreadPage | "reset"> {
  try {
    if (after > f.size || f.size - after > limits.forward) return "reset";
    let pos = after;
    let end = after;
    let carry: Buffer = EMPTY;
    let skipping = false;
    const items: ThreadItem[] = [];
    // The first of the wait-line lines that end what was read so far: where it
    // begins, how many items were before it, and its time.
    let hold: { at: number; count: number; ts: number } | null = null;
    while (pos < f.size) {
      const n = Math.min(limits.chunk, f.size - pos);
      const buf = await f.t.read(pos, n);
      if (buf.length === 0) break;
      let from = 0;
      if (skipping) {
        const nl = buf.indexOf(NL);
        if (nl < 0) { pos += buf.length; continue; }
        skipping = false;
        from = nl + 1;
        end = pos + from;
      }
      const data = carry.length ? Buffer.concat([carry, buf.subarray(from)]) : buf.subarray(from);
      const base = pos + from - carry.length; // file offset of data[0]
      carry = EMPTY;
      let lineStart = 0;
      for (;;) {
        const nl = data.indexOf(NL, lineStart);
        if (nl < 0) break;
        const got = itemsOf(data.subarray(lineStart, nl), opts);
        if (got.length) {
          const ts = unsettled(got);
          if (ts === null) hold = null;
          else if (!hold) hold = { at: base + lineStart, count: items.length, ts };
          items.push(...got);
        }
        lineStart = nl + 1;
        end = base + lineStart;
      }
      // The rest has no newline yet: a line still being written, or a long one.
      if (data.length - lineStart > limits.maxLine) skipping = true;
      else carry = data.subarray(lineStart);
      pos += buf.length;
    }
    if (hold && (opts?.now ?? Date.now)() - hold.ts < QUEUE_SETTLE_MS) {
      items.length = hold.count;
      end = hold.at;
    }
    return { items: foldEnds(items), start: null, end, lastEntryAt: f.mtime };
  } catch (e) {
    // It was replaced while it was read: the cursor means nothing in the new file.
    if (e instanceof TranscriptChanged) return "reset";
    throw e;
  }
}

export type SessionFile = { ok: true; path: string; sessionId: string } | { ok: false; reason: "runtime" | "no-session" | "no-file" };

// sessionId → the path it was last found at, for sessions filed under another
// project dir (see ensureTranscriptAt). Small and bounded; a stale entry is
// checked before use.
const found = new Map<string, string>();
const FOUND_MAX = 256;

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

// Where the agent's session file is, read-only: the path Claude derives from
// the agent's cwd, else the same session id under any other project dir (a
// session that moved its cwd). Never links or copies, unlike a resume.
// `projectsRoot` is a dependency for tests; production resolves it as the
// resume path does (canResume in runtimes/claude.ts).
export async function sessionFileFor(
  rec: AgentRecord, ctx: { workspaceDir: string; projectsRoot?: string },
): Promise<SessionFile> {
  if (pick(rec).id !== "claude") return { ok: false, reason: "runtime" };
  // The id becomes a path segment: the same check as at the write site (hooks.ts).
  const sessionId = rec.sessionId;
  if (!isSessionId(sessionId)) return { ok: false, reason: "no-session" };
  let root = ctx.projectsRoot;
  const strong = !root && helperSpawn();
  if (!root) {
    if (strong) {
      try { root = join(agentClaudeConfigDir(rec.id), "projects"); } catch { return { ok: false, reason: "no-file" }; }
    } else root = join(accountPaths().defaultDir, "projects");
  }
  const cwd = rec.cwd ?? (rec.repo ? rec.worktree : ctx.workspaceDir);
  const direct = claudeTranscriptPath(cwd, sessionId, root);
  // Strong protection: the console cannot look into the agent's Claude folder (sessionread.ts).
  // The path is the one Claude derives from the agent's cwd; the read through the helper says
  // whether it is there (no file: the reader gives null, and the route says "no-file"). A
  // session filed under another project folder is not looked for.
  if (strong) return { ok: true, path: direct, sessionId };
  if (await exists(direct)) return { ok: true, path: direct, sessionId };
  const key = `${root}\0${sessionId}`;
  const cached = found.get(key);
  if (cached && (await exists(cached))) return { ok: true, path: cached, sessionId };
  found.delete(key);
  let projects: string[];
  try { projects = await readdir(root); } catch { return { ok: false, reason: "no-file" }; }
  for (const project of projects) {
    const p = join(root, project, `${sessionId}.jsonl`);
    if (!(await exists(p))) continue;
    if (found.size >= FOUND_MAX) found.delete(found.keys().next().value as string);
    found.set(key, p);
    return { ok: true, path: p, sessionId };
  }
  return { ok: false, reason: "no-file" };
}
