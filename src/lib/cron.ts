import { chiefFetch, refusalSentence } from "./chief";
import type { Schedule } from "../../server/cron/schedule";
// src/lib/cron.ts — the client of the Recurring section: the tasks (the server and the command
// line say "cron jobs"), their runs, and what the list says of each task.
export type CronJob = {
  name: string;
  schedule: string;
  enabled: boolean;
  notify: "always" | "on-failure";
  nextRun: string | null;
  // The task's instructions, the name of its repo and when it was made (an older server sends none).
  prompt?: string; repo?: string | null; createdAt?: number | null;
  // A run is in progress now (an older server sends none).
  running?: boolean;
  // state, sentence, links: what the server says of the run (an older server sends none).
  lastRun: ({ finishedAt: number; ok: boolean; summary: string } & RunSaid) | null;
};
// What a run said: the server checked each field (server/cron/result.ts). clear: all clear.
// needs: a person must look. failed: it did not finish. done: it finished with no result line.
export type RunState = "clear" | "needs" | "failed" | "done";
export type RunLink =
  | { kind: "pr"; url: string; label: string }
  | { kind: "ticket"; id: string; title: string; open: boolean };
export type RunSaid = { state?: RunState; sentence?: string | null; links?: RunLink[] };
// timeZone: the server's zone, for a timer line with no zone name (null: an older server).
export type CronJobs = { jobs: CronJob[]; timeZone: string | null };

export async function fetchCronJobs(): Promise<CronJobs> {
  const res = await chiefFetch("/api/cron/jobs");
  if (!res.ok) throw new Error(`cron jobs: ${res.status}`);
  const body = (await res.json()) as { jobs: CronJob[]; timeZone?: unknown };
  return { jobs: body.jobs, timeZone: typeof body.timeZone === "string" && body.timeZone ? body.timeZone : null };
}

export type CronRun = {
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  ok: boolean;
  outputTail: string;
} & RunSaid;

// The state of a run. A run that did not finish is "failed" whatever else the record says.
export function runState(r: { ok: boolean; state?: RunState }): RunState {
  if (!r.ok) return "failed";
  return r.state === "clear" || r.state === "needs" ? r.state : "done";
}

export async function fetchCronRuns(name: string): Promise<CronRun[]> {
  const res = await chiefFetch(`/api/cron/jobs/${encodeURIComponent(name)}/runs`);
  if (!res.ok) throw new Error(`cron runs: ${res.status}`);
  return ((await res.json()) as { runs: CronRun[] }).runs;
}

// ---- what the page does to a task ---------------------------------------------
// The 4 fixed words of POST /api/cron/jobs/:name/:action (server/cron/api.ts TASK_ACTIONS).
export type TaskAction = "run" | "pause" | "resume" | "delete";

// The answer is { ok } or one sentence for the user: the server's own (a refusal, "paused",
// "could not do this"), the pairing sentence, or that the server did not answer.
export async function taskAction(name: string, action: TaskAction, deps: { fetch?: typeof fetch } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch(`/api/cron/jobs/${encodeURIComponent(name)}/${action}`, { method: "POST" }, deps);
    if (res.ok) return { ok: true };
    let body: { error?: string; userAuth?: string } | null = null;
    try { body = (await res.json()) as { error?: string; userAuth?: string }; } catch { /* no JSON body */ }
    const said = typeof body?.error === "string" && [404, 409, 422].includes(res.status) ? body.error : null;
    return { ok: false, error: refusalSentence(res.status, body, TASK_ACTION_WORDS[action]) ?? noPairing(res.status, body) ?? said ?? "Your server could not do this. Try again." };
  } catch {
    return { ok: false, error: "Your server did not answer. Try again." };
  }
}
const TASK_ACTION_WORDS: Record<TaskAction, string> = { run: "Run now", pause: "Pause", resume: "Resume", delete: "Delete" };
type ErrBodyText = { error?: string; text?: string; userAuth?: string; field?: string };
// A console with no device pairing refuses a change with one line of its own.
const noPairing = (status: number, body: ErrBodyText | null): string | null =>
  status === 403 && body?.error === "needs-pairing" && typeof body.text === "string" ? body.text : null;

// ---- the form: New task, Change, "Fill in" ------------------------------------
// What the form sends (server/cron/form.ts readForm checks each field again).
export type TaskFormBody = { name: string; repo: string | null; what: string; when: Schedule | null; zone: string | null; tell: "needs" | "always" };
export type FormField = "name" | "repo" | "what" | "when" | "tell";

// What the form needs to start: the names of the repos, and if "Fill in" is there.
export async function fetchTaskForm(deps: { fetch?: typeof fetch } = {}): Promise<{ repos: string[]; fillIn: boolean } | null> {
  try {
    const res = await chiefFetch("/api/cron/form", undefined, deps);
    if (!res.ok) return null;
    const b = (await res.json()) as { repos?: unknown; fillIn?: unknown };
    return { repos: Array.isArray(b.repos) ? b.repos.filter((r): r is string => typeof r === "string") : [], fillIn: b.fillIn === true };
  } catch { return null; }
}

// Save a new task, or the change of the task `change`. An error has the field it is about, if any.
export async function saveTask(form: TaskFormBody, change: string | null, deps: { fetch?: typeof fetch } = {}): Promise<{ ok: true; name: string } | { ok: false; error: string; field?: FormField }> {
  try {
    const res = await chiefFetch(change === null ? "/api/cron/tasks" : `/api/cron/tasks/${encodeURIComponent(change)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
    }, deps);
    let body: (ErrBodyText & { name?: string }) | null = null;
    try { body = (await res.json()) as ErrBodyText & { name?: string }; } catch { /* no JSON body */ }
    if (res.ok) return { ok: true, name: typeof body?.name === "string" ? body.name : form.name };
    const refusal = refusalSentence(res.status, body, "Save") ?? noPairing(res.status, body);
    if (refusal) return { ok: false, error: refusal };
    const said = typeof body?.error === "string" && [400, 404, 409, 422].includes(res.status) ? body.error : "Your server could not save the task. Try again.";
    const field = (["name", "repo", "what", "when", "tell"] as const).find((f) => f === body?.field);
    return { ok: false, error: said, ...(field ? { field } : {}) };
  } catch {
    return { ok: false, error: "Your server did not answer. Try again." };
  }
}

// "Fill in": the fields that the server's model made of the user's sentence (each one checked
// by the server), or one line that says why there is none. Nothing is saved.
export type TaskDraft = { title: string | null; name: string | null; what: string | null; when: Schedule | null; repo: string | null; tell: "needs" | "always" | null };
export async function draftTask(text: string, deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<{ ok: true; draft: TaskDraft } | { ok: false; error: string }> {
  const fill = "Fill in the form by hand.";
  try {
    const res = await chiefFetch("/api/cron/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }, deps);
    let body: (ErrBodyText & { ok?: boolean; draft?: TaskDraft; why?: string; until?: number }) | null = null;
    try { body = await res.json(); } catch { /* no JSON body */ }
    if (res.ok && body?.ok === true && body.draft) return { ok: true, draft: body.draft };
    const refusal = refusalSentence(res.status, body, "Fill in") ?? noPairing(res.status, body);
    if (refusal) return { ok: false, error: refusal };
    if (res.ok && body?.why === "limit") {
      const until = typeof body.until === "number" && body.until > (deps.now ?? Date.now)() ? ` It comes back ${nextWords(new Date(body.until).toISOString(), (deps.now ?? Date.now)())?.replace(/^T/, "t") ?? "later"}.` : "";
      return { ok: false, error: `Your Claude plan is at its limit.${until} ${fill}` };
    }
    if (res.ok && body?.why === "login") return { ok: false, error: `Claude is not logged in on your server. ${fill}` };
    if (res.ok && body?.why === "unclear") return { ok: false, error: `The answer was not clear. Write the sentence in another way, or fill in the form by hand.` };
    if (res.status === 400 || res.status === 429) return { ok: false, error: typeof body?.error === "string" ? body.error : fill };
    return { ok: false, error: `"Fill in" did not work this time. ${fill}` };
  } catch {
    return { ok: false, error: `Your server did not answer. ${fill}` };
  }
}

// ---- what the list says of a task --------------------------------------------
// The state of the last run (runState), or none: no run yet, or paused: turned off, whatever
// its last run was.
export type TaskState = RunState | "none" | "paused";
type StateOf = Pick<CronJob, "enabled" | "lastRun">;

export function taskState(j: StateOf): TaskState {
  if (!j.enabled) return "paused";
  if (!j.lastRun) return "none";
  return runState(j.lastRun);
}

// A task's name is a slug ("morning-error-digest"): the page shows "Morning error digest".
export function taskTitle(name: string): string {
  const t = name.replace(/-+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : name;
}

// The line under the task's name: what its last run said, in one sentence.
export function taskSentence(j: StateOf): string {
  switch (taskState(j)) {
    case "paused": return "Paused.";
    case "none": return "No run yet.";
    case "failed": return j.lastRun?.sentence ? `Did not finish. ${j.lastRun.sentence}` : "The last run did not finish.";
    case "needs": return j.lastRun?.sentence || "The last run found something for you.";
    case "clear": return j.lastRun?.sentence || "All clear.";
    case "done": return j.lastRun?.sentence || "The last run finished.";
  }
}

const STATE_ORDER: Record<TaskState, number> = { needs: 0, failed: 1, clear: 2, done: 2, none: 2, paused: 3 };

// What needs the user first, the paused tasks last; by name inside a group.
export function sortTasks<T extends StateOf & { name: string }>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => STATE_ORDER[taskState(a)] - STATE_ORDER[taskState(b)] || a.name.localeCompare(b.name));
}

export function taskCounts(jobs: StateOf[]): Record<TaskState, number> {
  const n: Record<TaskState, number> = { needs: 0, failed: 0, clear: 0, done: 0, none: 0, paused: 0 };
  for (const j of jobs) n[taskState(j)] += 1;
  return n;
}

// The one line of the page's head: "6 tasks", "1 task"; nothing while the list is not read.
export function tasksLine(jobs: StateOf[] | null): string {
  if (!jobs || jobs.length === 0) return "";
  return `${jobs.length} ${jobs.length === 1 ? "task" : "tasks"}`;
}

// The words of a state, beside its dot.
export function stateWord(state: TaskState): string {
  return { needs: "Needs you", failed: "Did not finish", clear: "All clear", done: "Finished", none: "No run yet", paused: "Paused" }[state];
}

// The line beside the page's title: "6 tasks · 1 needs you · 1 did not finish · 1 paused".
export function recurringHeadline(jobs: StateOf[] | null): string {
  if (!jobs || jobs.length === 0) return "";
  const n = taskCounts(jobs);
  return [
    tasksLine(jobs), n.needs ? `${n.needs} ${n.needs === 1 ? "needs" : "need"} you` : "", n.failed ? `${n.failed} did not finish` : "", n.paused ? `${n.paused} paused` : "",
  ].filter(Boolean).join(" · ");
}

// The sidebar row's dot. No number: red while a task did not finish, amber while a change
// waits for the user (a protected install), else nothing.
export function recurringLevel(jobs: StateOf[] | null, waiting: number): { level: "error" | "warn"; why: string } | null {
  const failed = jobs ? taskCounts(jobs).failed : 0;
  if (failed > 0) return { level: "error", why: `${failed} ${failed === 1 ? "task" : "tasks"} did not finish` };
  if (waiting > 0) return { level: "warn", why: `${waiting} ${waiting === 1 ? "change waits" : "changes wait"} for you` };
  return null;
}

// ---- times, in the viewer's zone (`zone`: an IANA name; none: the browser's) ----
type DateParts = { weekday: string; day: string; month: string; year: string; hour: string; minute: string };
function dateParts(ms: number, zone: string | undefined, long = false): DateParts {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, weekday: long ? "long" : "short", day: "numeric", month: long ? "long" : "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, day: p.day, month: p.month, year: p.year, hour: p.hour, minute: p.minute };
}

// Whole days from `b`'s calendar day to `a`'s, in the zone.
function dayDiff(a: number, b: number, zone: string | undefined): number {
  const day = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  };
  return Math.round((day(a) - day(b)) / 86_400_000);
}

// The last run: "Now", "14 min ago", "2 h ago", "Yesterday", "Mon 16 Nov".
export function lastWords(ms: number, now: number, zone?: string): string {
  const min = Math.floor(Math.max(0, now - ms) / 60_000);
  if (min < 1) return "Now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60 && dayDiff(now, ms, zone) <= 1) return `${Math.floor(min / 60)} h ago`;
  if (dayDiff(now, ms, zone) === 1) return "Yesterday";
  const p = dateParts(ms, zone);
  return `${p.weekday} ${p.day} ${p.month}`;
}

// The next run: "Today 17:00", "Tomorrow 08:00", "Mon 23 Nov 09:00"; null for no date.
export function nextWords(iso: string | null, now: number, zone?: string): string | null {
  const ms = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(ms)) return null;
  const p = dateParts(ms, zone);
  const time = `${p.hour}:${p.minute}`;
  const days = dayDiff(ms, now, zone);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${p.weekday} ${p.day} ${p.month} ${time}`;
}

// When a run started: "Today 08:00", "Yesterday 08:00", "Mon 16 Nov 08:00".
export function runWhen(ms: number, now: number, zone?: string): string {
  const p = dateParts(ms, zone);
  const time = `${p.hour}:${p.minute}`;
  const days = dayDiff(now, ms, zone);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${p.weekday} ${p.day} ${p.month} ${time}`;
}

// How long a run took: "40 s", "3 min", "1 h 5 min".
export function tookWords(r: { startedAt: number; finishedAt: number }): string {
  const secs = Math.max(0, Math.round((r.finishedAt - r.startedAt) / 1000));
  if (secs < 60) return `${secs} s`;
  const min = Math.round(secs / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// The line of the run strip: "Last 14 runs · 10 all clear · 3 needed you · 1 did not finish".
export function runsLine(runs: { ok: boolean; state?: RunState }[]): string {
  if (runs.length === 0) return "";
  const n: Record<RunState, number> = { clear: 0, needs: 0, failed: 0, done: 0 };
  for (const r of runs) n[runState(r)] += 1;
  return [
    runs.length === 1 ? "1 run" : `Last ${runs.length} runs`,
    n.clear ? `${n.clear} all clear` : "", n.needs ? `${n.needs} needed you` : "", n.failed ? `${n.failed} did not finish` : "",
  ].filter(Boolean).join(" · ");
}

// "Tell me" of a task: the server says "always" or "on-failure".
export function tellWords(notify: CronJob["notify"]): string {
  return notify === "always" ? "After every run" : "When it needs me";
}

// A full date for a tooltip, with the name of the zone: "Monday 23 November 2026, 09:00 (Europe/Paris)".
export function fullWhen(ms: number, zone?: string): string {
  if (!Number.isFinite(ms)) return "";
  const p = dateParts(ms, zone, true);
  const name = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} (${name})`;
}

// ---- the spool (hardened deployment, Task 2c-8) -----------------------------
// Cron changes an agent asked for, waiting for the user. Every field is
// agent-written: render it as plain text only.
export type CronSpoolRequest = {
  id: string; at: number; op: "add" | "edit" | "rm" | "enable" | "disable" | "run";
  name: string; spec?: unknown; by?: string;
  sha256: string; // of the request's bytes: Apply sends it back
  cwd?: string; // add/edit: where the job would run
  changed?: true; // rewritten after the console first listed it: reject only
};
// "off" = 404: not a hardened deployment, the route does not exist.
// "error" = any other failure: the pane keeps its last view.
export type CronSpoolView = { state: "off" } | { state: "error" } | { state: "on"; requests: CronSpoolRequest[] };
type Deps = { fetch?: typeof fetch };
type ErrBody = { error?: string; userAuth?: string };

export async function fetchCronSpool(deps: Deps = {}): Promise<CronSpoolView> {
  try {
    const res = await chiefFetch("/api/cron/spool", undefined, deps);
    if (res.status === 404) return { state: "off" };
    if (!res.ok) return { state: "error" };
    const body = (await res.json()) as { requests?: unknown };
    return Array.isArray(body?.requests) ? { state: "on", requests: body.requests as CronSpoolRequest[] } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

// What a change does, in the page's words (the server says add, edit, rm, enable, disable, run).
export function changeWords(op: CronSpoolRequest["op"]): string {
  return { add: "New task", edit: "Change", rm: "Delete", enable: "Resume", disable: "Pause", run: "Run now" }[op] ?? String(op);
}

// The "Changes that wait for you" section shows only with something waiting.
export function spoolSectionShown(v: CronSpoolView | null): boolean {
  return v?.state === "on" && v.requests.length > 0;
}

// The requests that wait for the user (the amber dot of the sidebar row).
export function spoolWaiting(v: CronSpoolView | null): number {
  return v?.state === "on" ? v.requests.length : 0;
}

export async function decideCronSpool(
  req: Pick<CronSpoolRequest, "id" | "sha256">, action: "apply" | "reject", deps: Deps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await chiefFetch(`/api/cron/spool/${encodeURIComponent(req.id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "apply" ? { sha256: req.sha256 } : {}),
    }, deps);
    if (res.ok) return { ok: true };
    let body: ErrBody | null = null;
    try { body = (await res.json()) as ErrBody; } catch { /* no JSON body */ }
    const reason = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    return { ok: false, error: refusalSentence(res.status, body, action === "apply" ? "Apply" : "Reject") ?? reason };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// A row that appeared or changed (another sha256) since the previous poll is
// "new": Apply stays off for SPOOL_FRESH_MS, so the user never applies bytes
// that changed under their eyes. "changed": the server saw the request
// rewritten after it was first listed; it can only be rejected.
export const SPOOL_FRESH_MS = 5000;
export type SpoolTrack = Map<string, { sha256: string; since: number }>;

// The track for this poll: only the ids listed now; `since` kept while the bytes are the same.
export function trackSpool(prev: SpoolTrack, requests: Pick<CronSpoolRequest, "id" | "sha256">[], now: number): SpoolTrack {
  const next: SpoolTrack = new Map();
  for (const r of requests) {
    const p = prev.get(r.id);
    next.set(r.id, p && p.sha256 === r.sha256 ? p : { sha256: r.sha256, since: now });
  }
  return next;
}

export function spoolRowState(r: Pick<CronSpoolRequest, "id" | "sha256" | "changed">, track: SpoolTrack, now: number): "changed" | "new" | "ready" {
  if (r.changed) return "changed";
  const t = track.get(r.id);
  return !t || t.sha256 !== r.sha256 || now - t.since < SPOOL_FRESH_MS ? "new" : "ready";
}

// Agent text as shown: format characters (bidi overrides, zero-width) and C1
// controls become \uXXXX, so nothing in a spec can hide or reorder text.
export function visibleText(s: string): string {
  return s.replace(/[\p{Cf}\u0080-\u009f]/gu, (c) => {
    const cp = c.codePointAt(0)!;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

// `by` is what the agent wrote: a claim, not an identity.
export function askedBy(by: string | undefined): string {
  return by ? `asked by (unverified) ${visibleText(by)}` : "";
}
