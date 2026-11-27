// src/lib/updateProgress.ts — the progress of a press of Update on a hosted console (server/update):
// from the press to "Updated to version N", through the console's own restart, on the same place.
//
// The steps. Root's status file names two while root works (choibot-update): `download` (the
// release's index, its signature, the tar and every check of it) and `stage` (the unpack, then the
// stop of the console). The page sees the other two itself: the console goes away (the stop, the
// swap, the start), then it answers on a newer version while root's health check runs. No step is
// guessed and nothing shows a percentage: a step that root does not report stays the present step.
//
// What it reads: the ticket's run (the queue, by its stream), and while a press is under way one
// poll of GET /api/deploy (the same route as the Settings page): the version that answers, root's
// last result and step, the ticket's run. Two failed polls in a row: the console is away.
//
// The page's own memory of its press (localStorage, per browser): the button turns into the
// progress at once, before the server answers; the steps never go back; the end motion plays once;
// and a reload in the middle shows the same state.
import type { UpdateRun } from "../../server/chief/deploy/ticket"; // type-only
import { DEPLOY_CLOSED, pressLimit, updateLine } from "../../server/chief/deploy/ticket";
import { chiefFetch } from "./chief";

export type StepKey = "download" | "install" | "restart" | "check";
export const UPDATE_STEPS: readonly { key: StepKey; word: string }[] = [
  { key: "download", word: "Downloading" },
  { key: "install", word: "Installing" },
  { key: "restart", word: "Restarting" },
  { key: "check", word: "Checking" },
];
const STAGE = 1, RESTART = 2, CHECK = 3;

// The page's press. `askedAt` is the server's (the run on the ticket) once the POST answered.
export type Press = {
  item: string; from: number; to: number;
  at: number; askedAt: number | null;
  // The furthest step shown: the steps never go back.
  furthest: number;
  // The end showed once (its motion played); the Queue showed the ended ticket once by itself.
  ended: boolean; peeked: boolean;
};

// What the last polls of GET /api/deploy found.
export type Link =
  | { t: "none" }
  | { t: "up"; running: number; result: string | null; step: string | null; installed: number | null; run: UpdateRun | null }
  | { t: "away" };

export type StepState = "done" | "now" | "todo";
export type Progress =
  | { t: "idle" }
  | { t: "going"; at: number; steps: { key: StepKey; word: string; state: StepState }[] }
  | { t: "done"; version: number }
  // `again`: the ticket stays open and the same release can be asked again (the button).
  | { t: "failed"; line: string; next: string | null; again: boolean };

const PRESSED = new Set<UpdateRun["state"]>(["asked", "running"]);
// The ends that leave the ticket open with its button.
const OPEN_ENDS = new Set<UpdateRun["state"]>(["refused", "unreachable", "not-started", "not-finished"]);
const FAILED_RESULTS = new Set(["failed-back", "failed-stuck"]);
// A press with no answer of the server after this long did not reach it (a reload cut the POST).
export const PRESS_ANSWER_MS = 30_000;
// A press older than this is over (the server's RUN_MAX_MS; the Queue shows an end for an hour).
export const PRESS_MAX_MS = 60 * 60_000;

// The run of a press: the ticket's, or the poll's when it is of a later press or further on.
export function pickRun(a: UpdateRun | null | undefined, b: UpdateRun | null | undefined): UpdateRun | null {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.askedAt !== b.askedAt) return a.askedAt > b.askedAt ? a : b;
  if (PRESSED.has(a.state) !== PRESSED.has(b.state)) return PRESSED.has(a.state) ? b : a;
  return b.step === "stage" && a.step !== "stage" ? b : a;
}

// What the user can do after an end, in one short line (null: the line or the button says it).
function nextWords(run: UpdateRun): string | null {
  if (run.state === "failed-back") return "The next release comes as a new ticket.";
  return null;
}

export type ProgressInput = {
  // The ticket's run, and why the ticket closed (QueueItem.lastError) when it did.
  run: UpdateRun | null | undefined;
  closed?: string | null;
  press: Press | null;
  link: Link;
  now: number;
  // A ticket's panel: the poll's run counts only when it is for this ticket's release.
  to?: number;
};

// The one state machine: the ticket's run, the page's press and the poll give what the place of
// the button shows. `furthest`: the step index to keep in the press.
export function progressOf(x: ProgressInput): { p: Progress; furthest: number } {
  const mine = livePress(x.press, x.now);
  const polled = x.link.t === "up" && x.link.run && (x.to === undefined || x.link.run.to === x.to) ? x.link.run : null;
  const run = pickRun(x.run, polled);
  // Is the run the one of this page's press? A run of an older press is not (the stream has not
  // brought the new one yet): the page's press shows.
  // Before the POST answers, only a run under way counts (an end on the ticket is an older press).
  const current = run !== null && (mine === null || (mine.askedAt === null ? PRESSED.has(run.state) : run.askedAt >= mine.askedAt));
  const furthest0 = mine?.furthest ?? 0;
  if (current && run) {
    if (run.state === "updated" || (x.closed === DEPLOY_CLOSED.updated && !PRESSED.has(run.state))) return { p: { t: "done", version: run.to }, furthest: CHECK };
    if (!PRESSED.has(run.state)) {
      return { p: { t: "failed", line: updateLine(run), next: nextWords(run), again: OPEN_ENDS.has(run.state) && !pressLimit(run) }, furthest: furthest0 };
    }
  }
  // No run under way, and no press of this page (or its end showed already).
  if (!(current && run) && (mine === null || mine.ended)) return { p: { t: "idle" }, furthest: 0 };
  // A press under way (the ticket's run, or this page's press that the server did not answer yet).
  const from = current && run ? run.from : mine!.from;
  const to = current && run ? run.to : mine!.to;
  const link = x.link;
  // The new console answers and root's end is there: done before the ticket says so (the
  // server's own rule, service.ts nextRun: the version that runs is newer, root installed it).
  if (link.t === "up" && link.running > from && link.running >= to && link.installed === link.running
    && link.result !== "running" && !FAILED_RESULTS.has(link.result ?? "")) {
    return { p: { t: "done", version: link.running }, furthest: CHECK };
  }
  let at = 0;
  if (current && run?.state === "running" && run.step === "stage") at = STAGE;
  if (link.t === "up" && link.result === "running" && link.step === "stage") at = Math.max(at, STAGE);
  if (link.t === "up" && link.running > from) at = CHECK;
  at = Math.max(at, furthest0);
  // The console went away after the install began: its restart.
  if (link.t === "away" && at >= STAGE) at = Math.max(at, RESTART);
  const steps = UPDATE_STEPS.map((s, n) => ({ ...s, state: (n < at ? "done" : n === at ? "now" : "todo") as StepState }));
  return { p: { t: "going", at, steps }, furthest: at };
}

// A press that still counts: answered, or young enough to be answered; not older than a run.
export function livePress(p: Press | null, now: number): Press | null {
  if (!p) return null;
  if (now - p.at > PRESS_MAX_MS) return null;
  if (p.askedAt === null && now - p.at > PRESS_ANSWER_MS) return null;
  return p;
}

// The Queue: the ticket of the page's press closed with its end while the reading pane showed it
// (or the view's first list came after the end, a reload): the pane keeps that ticket, read-only,
// so the end shows where the press was. Once per press. `shownBefore`: the ticket the pane showed
// in the view's last render; undefined before the view's first list.
export function endedPressTicket(
  press: Press | null,
  items: readonly { id: string; status: string; lastError?: string | null }[],
  shownBefore: string | null | undefined,
): string | null {
  if (!press || press.peeked) return null;
  const t = items.find((i) => i.id === press.item);
  if (!t || t.status === "open" || t.status === "snoozed") return null;
  if (t.lastError !== DEPLOY_CLOSED.updated && t.lastError !== DEPLOY_CLOSED.updateFailed) return null;
  return shownBefore === undefined || shownBefore === t.id ? t.id : null;
}

// ---- the page's memory and the poll ----

export const PRESS_KEY = "choibot.updatePress";
export const POLL_MS = 1_500;
export const POLL_TIMEOUT_MS = 4_000;
// Polls that fail in a row before the console counts as away (one lost answer is not a restart).
export const AWAY_AFTER = 2;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type TrackerDeps = {
  fetch?: typeof fetch;
  storage?: Store | null;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
};
export type Snapshot = { press: Press | null; link: Link };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function readPress(storage: Store | null): Press | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PRESS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Press>;
    if (typeof p.item !== "string" || !isNum(p.from) || !isNum(p.to) || !isNum(p.at) || !(p.askedAt === null || isNum(p.askedAt))) return null;
    return { item: p.item, from: p.from, to: p.to, at: p.at, askedAt: p.askedAt, furthest: isNum(p.furthest) ? Math.min(Math.max(0, p.furthest), CHECK) : 0, ended: p.ended === true, peeked: p.peeked === true };
  } catch {
    return null;
  }
}

function writePress(storage: Store | null, p: Press | null): void {
  if (!storage) return;
  try {
    if (p) storage.setItem(PRESS_KEY, JSON.stringify(p));
    else storage.removeItem(PRESS_KEY);
  } catch { /* private mode: the memory lives in this page only */ }
}

// The answer of GET /api/deploy on a hosted console: `update` (UpdateService.view) and `press`.
function linkOf(b: unknown): Link | null {
  if (!b || typeof b !== "object") return null;
  const u = (b as { update?: Record<string, unknown> }).update;
  if (!u || typeof u !== "object" || !isNum(u.running)) return null;
  const run = (b as { press?: UpdateRun | null }).press;
  return {
    t: "up", running: u.running, result: typeof u.result === "string" ? u.result : null, step: typeof u.step === "string" ? u.step : null,
    installed: isNum(u.installed) ? u.installed : null, run: run && typeof run === "object" && isNum(run.askedAt) ? run : null,
  };
}

export type UpdateTracker = {
  get(): Snapshot;
  subscribe(fn: () => void): () => void;
  // The press, before the POST: the progress shows at once. false: a press of this page waits for
  // its answer already (a second press does nothing).
  press(p: { item: string; from: number; to: number }): boolean;
  // The POST answered with the ticket's run (its askedAt), or it was refused (the button again).
  answered(askedAt: number): void;
  refused(): void;
  note(patch: Partial<Pick<Press, "furthest" | "ended" | "peeked">>): void;
  // While one watcher is there, GET /api/deploy runs every POLL_MS.
  watch(): () => void;
  pollOnce(): Promise<void>;
};

export function createUpdateTracker(deps: TrackerDeps = {}): UpdateTracker {
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  const now = deps.now ?? Date.now;
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let snap: Snapshot = { press: livePress(readPress(storage), now()), link: { t: "none" } };
  if (!snap.press) writePress(storage, null);
  const subs = new Set<() => void>();
  let fails = 0, watchers = 0, timer: unknown = null, inFlight = false;
  const set = (next: Partial<Snapshot>, save = false) => {
    snap = { ...snap, ...next };
    if (save) writePress(storage, snap.press);
    for (const fn of [...subs]) fn();
  };
  const pollOnce = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    let link: Link | null = null;
    try {
      const ctl = typeof AbortController === "undefined" ? null : new AbortController();
      const t = ctl ? later(() => ctl.abort(), POLL_TIMEOUT_MS) : null;
      try {
        const res = await chiefFetch("/api/deploy", ctl ? { signal: ctl.signal } : undefined, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.storage !== undefined ? { storage: deps.storage } : {}) });
        // A proxy's 502 while the console restarts, or a page that is not JSON: not an answer.
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        link = linkOf(await res.json());
      } finally {
        if (t !== null) cancel(t);
      }
      fails = 0;
      if (link) set({ link });
    } catch {
      fails += 1;
      if (fails >= AWAY_AFTER && snap.link.t !== "away") set({ link: { t: "away" } });
    } finally {
      inFlight = false;
    }
  };
  const loop = () => {
    timer = null;
    if (watchers === 0) return;
    void pollOnce().finally(() => { if (watchers > 0 && timer === null) timer = later(loop, POLL_MS); });
  };
  return {
    get: () => snap,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    press(p) {
      const cur = livePress(snap.press, now());
      if (cur && cur.askedAt === null) return false;
      set({ press: { ...p, at: now(), askedAt: null, furthest: 0, ended: false, peeked: false } }, true);
      return true;
    },
    answered(askedAt) {
      if (snap.press) set({ press: { ...snap.press, askedAt } }, true);
    },
    refused() { set({ press: null }, true); },
    note(patch) {
      const p = snap.press;
      if (!p) return;
      const next = { ...p, ...patch, furthest: Math.max(p.furthest, patch.furthest ?? 0) };
      if (next.furthest === p.furthest && next.ended === p.ended && next.peeked === p.peeked) return;
      set({ press: next }, true);
    },
    watch() {
      watchers += 1;
      if (watchers === 1 && timer === null) loop();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        watchers -= 1;
        if (watchers === 0 && timer !== null) { cancel(timer); timer = null; }
      };
    },
    pollOnce,
  };
}

function defaultStorage(): Store | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

// The page's one tracker (the Queue's panel, the thread card and Settings share it).
let shared: UpdateTracker | null = null;
export function updateTracker(): UpdateTracker {
  return (shared ??= createUpdateTracker());
}
