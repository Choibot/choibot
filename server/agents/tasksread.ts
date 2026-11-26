// server/agents/tasksread.ts — the Plan rail with strong protection. Claude Code keeps one JSON
// file per task in <its Claude folder>/tasks/<session id>/<n>.json. With strong protection that
// folder is in the agent's own home (0700; the files 0600): the console cannot read it, so the
// helper reads it AS the account of the session (deploy/choibot-agent-exec read-tasks), through the
// one reader of the agent's files and its gate (sessionread.ts helperRead). The answer is framed:
// "tasks <n>", then per file "<name> <bytes>", the bytes and a newline; or "absent". It is the
// agent's text: data, parsed as before (tasks.ts), never an order.
//
// The cost. The page polls the rail every 2 s (5 s when the agent is done or in error), from each
// open tab; each read is one sudo call. So the reads of one agent are kept:
// - a change of the session or of the agent's status: a read at once, and one more about 3 s later
//   (the last task write of a turn can land after its status event);
// - running: at most one read in PLAN_RUNNING_MS;
// - idle, done or in error: at most one read in PLAN_IDLE_MS (a status that the hooks missed never
//   freezes the rail);
// - requests at the same time share one call.
// One open agent: running, at most 12 calls a minute (10 with the 2 s poll); idle, 1 a minute;
// plus 2 for each status change.
//
// An installed helper older than this console has no read-tasks ("unknown verb"): an empty rail,
// ONE log line, and no call for PLAN_OLD_HELPER_MS. Any other failure: an empty rail and one log
// line per agent and reason.
import { join } from "node:path";
import { helperRead, transcriptAccount } from "./sessionread.js";
import { parseTaskFile, sortTasks, type AgentTask } from "./tasks.js";
import type { AgentRecord } from "./store.js";

type Env = Record<string, string | undefined>;

export const PLAN_RUNNING_MS = 5_000;
export const PLAN_IDLE_MS = 60_000;
export const PLAN_AFTER_CHANGE_MS = 3_000;
export const PLAN_OLD_HELPER_MS = 10 * 60_000;

// The helper's caps (deploy/choibot-agent-exec READ_TASKS_*): the parse refuses more.
const FILES_MAX = 1000;
const FILE_MAX = 262_144;
const TOTAL_MAX = 4_194_304;
// The answer: the bytes and one header line of at most 300 bytes per file.
const ANSWER_MAX = TOTAL_MAX + FILES_MAX * 302 + 64;
// The helper ends itself after its own limit (10 s by default).
const CALL_MS = 20_000;

// Claude Code's session ids, and the names of its task files (2.1.332: ids from a counter that
// starts at 1; it reads only `^[1-9]\d*$`). The helper reads only these names.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_NAME = /^[1-9][0-9]{0,9}\.json$/;

export type TaskFrame = { name: string; bytes: Buffer };

class Shape extends Error {
  constructor() { super("read-tasks: an answer of another shape"); }
}

// The helper's answer, by its frames; throws for an answer of another shape (never a guess).
export function parseTaskFrames(out: Buffer): TaskFrame[] | "absent" {
  const line = (from: number): { text: string; next: number } => {
    const nl = out.indexOf(10, from);
    if (nl < 0 || nl - from > 300) throw new Shape();
    return { text: out.subarray(from, nl).toString("latin1"), next: nl + 1 };
  };
  const head = line(0);
  if (head.text === "absent") {
    if (head.next !== out.length) throw new Shape();
    return "absent";
  }
  const m = /^tasks (0|[1-9][0-9]{0,3})$/.exec(head.text);
  if (!m || Number(m[1]) > FILES_MAX) throw new Shape();
  const frames: TaskFrame[] = [];
  let at = head.next;
  let total = 0;
  for (let i = 0; i < Number(m[1]); i++) {
    const h = line(at);
    const f = /^([^ ]{1,255}) (0|[1-9][0-9]{0,6})$/.exec(h.text);
    if (!f) throw new Shape();
    const len = Number(f[2]);
    total += len;
    if (len > FILE_MAX || total > TOTAL_MAX) throw new Shape();
    const end = h.next + len;
    if (end >= out.length || out[end] !== 10) throw new Shape();
    frames.push({ name: Buffer.from(f[1], "latin1").toString("utf8"), bytes: out.subarray(h.next, end) });
    at = end + 1;
  }
  if (at !== out.length) throw new Shape();
  return frames;
}

type Entry = { key: string; at: number; changedAt: number; second: boolean; tasks: AgentTask[]; pending?: Promise<AgentTask[]> };
const ENTRIES_MAX = 500;
let entries = new Map<string, Entry>();
let oldHelperUntil = 0;
let oldHelperLogged = false;
let logged = new Set<string>();

// One log line per agent and reason.
function logOnce(id: string, reason: string, line: string): void {
  const k = `${id}\0${reason}`;
  if (logged.has(k)) return;
  if (logged.size >= 1000) logged = new Set();
  logged.add(k);
  console.warn(line);
}

// Tests: forget the kept reads, the older-helper pause and the log lines.
export function forgetPlanReads(): void {
  entries = new Map();
  oldHelperUntil = 0;
  oldHelperLogged = false;
  logged = new Set();
}

// The agent's task list, read through the helper of its account. `claudeDir`: the Claude folder
// that the agent runs with (runtimes/claude.ts agentClaudeConfigDir). Never throws.
export function readPlanAsAgent(rec: AgentRecord, claudeDir: string, env: Env = process.env): Promise<AgentTask[]> {
  const sid = rec.sessionId;
  if (!sid || !SESSION_UUID.test(sid)) return Promise.resolve([]);
  const now = Date.now();
  if (now < oldHelperUntil) return Promise.resolve([]);
  const key = `${sid}\0${rec.status}`;
  let e = entries.get(rec.id);
  if (e?.pending) return e.pending;
  let due: boolean;
  if (!e || e.key !== key) {
    e = { key, at: 0, changedAt: now, second: false, tasks: [] };
    entries.delete(rec.id);
    if (entries.size >= ENTRIES_MAX) entries.delete(entries.keys().next().value as string);
    entries.set(rec.id, e);
    due = true;
  } else if (!e.second && now - e.changedAt >= PLAN_AFTER_CHANGE_MS) {
    e.second = true;
    due = true;
  } else {
    due = now - e.at >= (rec.status === "running" ? PLAN_RUNNING_MS : PLAN_IDLE_MS);
  }
  if (!due) return Promise.resolve(e.tasks);
  const kept = e;
  kept.at = now;
  const p = readNow(rec.id, sid, claudeDir, env)
    .then((tasks) => { kept.tasks = tasks; return tasks; })
    .finally(() => { kept.pending = undefined; });
  kept.pending = p;
  return p;
}

async function readNow(id: string, sid: string, claudeDir: string, env: Env): Promise<AgentTask[]> {
  const a = transcriptAccount(join(claudeDir, "tasks", sid), env);
  if (!a) {
    logOnce(id, "no helper", `[chief] ${id}: no helper reads its Claude folder (${claudeDir}); the Plan rail stays empty`);
    return [];
  }
  let frames: TaskFrame[] | "absent";
  try {
    frames = parseTaskFrames(await helperRead(a, "read-tasks", [sid], { maxBuffer: ANSWER_MAX, timeout: CALL_MS }, env));
  } catch (err) {
    const why = (err as Error).message;
    if (/unknown verb/.test(why)) {
      oldHelperUntil = Date.now() + PLAN_OLD_HELPER_MS;
      if (!oldHelperLogged) {
        oldHelperLogged = true;
        console.warn("[chief] the installed helper has no read-tasks verb (it is older than this console): the Plan rail stays empty until strong-setup installs the new helper");
      }
      return [];
    }
    logOnce(id, why, `[chief] ${id}: the Plan rail could not be read through the helper (${why})`);
    return [];
  }
  if (frames === "absent") return [];
  const tasks: AgentTask[] = [];
  for (const f of frames) {
    // The name form comes from Claude Code's code only: a later Claude (or helper) may name a
    // file otherwise. Skipped, never an error.
    if (!TASK_NAME.test(f.name)) {
      logOnce(id, "a name", `[chief] ${id}: a task file of a name that the console does not expect is skipped (${JSON.stringify(f.name.slice(0, 80))})`);
      continue;
    }
    const t = parseTaskFile(f.bytes.toString("utf8"));
    if (t) tasks.push(t);
  }
  return sortTasks(tasks);
}
