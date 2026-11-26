// src/lib/thread.ts — client side of the agent thread view: the fetch for
// GET /api/agents/:id/thread and the pure logic the view renders from (merge
// of pages, fold of tool steps into groups, the live line, time formats).
import type { ThreadItem } from "../../server/agents/thread"; // type-only
import type { SubagentState } from "../../server/agents/subagents"; // type-only
import { chiefFetch } from "./chief";

export type { ThreadItem, SubagentState };
// What the state holds of a page: every item but the step results. `Shown` is
// what the view draws: the wait line's own items (queued, unqueue) are not rows.
export type Held = Exclude<ThreadItem, { kind: "end" }>;
export type Shown = Exclude<Held, { kind: "queued" | "unqueue" }>;
export type Step = Extract<ThreadItem, { kind: "step" }>;
export type Message = Extract<ThreadItem, { kind: "user" | "assistant" | "peer" }>;

// `lastEntryAt`: when the session file last got a line (server clock, as `now`).
export type ThreadPageRes = {
  ok: true; sessionId: string; status: string; now: number;
  items: ThreadItem[]; start: number | null; end: number; reset?: boolean;
  lastEntryAt?: number;
  // The state of the subagents that the page's steps launched, and of the ones
  // named in `subs` of the request.
  subs?: Record<string, SubagentState>;
};
// No session file to read (Codex, no session yet, the file is gone): the view
// falls back to the terminal.
export type ThreadNoneRes = { ok: false; reason: "runtime" | "no-session" | "no-file"; status: string; now: number };
export type ThreadRes = ThreadPageRes | ThreadNoneRes;

// `sub`: the page of that subagent's own file, not of the session file.
// `subs`: subagents to give the state of (the ones held as running).
export async function fetchThread(
  id: string, q: { before?: number; after?: number; session?: string; sub?: string; subs?: string[] } = {}, signal?: AbortSignal,
): Promise<ThreadRes> {
  const p = new URLSearchParams();
  if (q.before !== undefined) p.set("before", String(q.before));
  if (q.after !== undefined) p.set("after", String(q.after));
  if (q.session) p.set("session", q.session);
  if (q.sub) p.set("sub", q.sub);
  if (q.subs && q.subs.length) p.set("subs", q.subs.join(","));
  const qs = p.toString();
  const r = await chiefFetch(`/api/agents/${encodeURIComponent(id)}/thread${qs ? `?${qs}` : ""}`, { signal });
  if (!r.ok) throw new Error(`thread failed (${r.status})`);
  return r.json();
}

// What the view holds for one agent. `start`: cursor of the page before the
// oldest item (null: the session's first line is loaded). `end`: cursor for the
// live poll. `ends`: results that arrived for a step in a page not loaded yet.
// `subs`: the last known state of each subagent, by its id (absent: none known).
// `all`: the items as read, with the wait line's items (absent: `items` is all
// of them). `items` and `waiting` are made from it (queueView): the rows, and
// the messages that still wait for the agent, oldest first.
export type ThreadState = {
  sessionId: string;
  items: Shown[];
  start: number | null;
  end: number;
  ends: Record<string, { ts: number; error?: boolean; agent?: string; bg?: true }>;
  subs?: Record<string, SubagentState>;
  all?: Held[];
  waiting?: Waiting[];
};

// A message in the agent's wait line. `taken`: the agent took it this moment
// and its own row is not in the file yet (it stays on screen until it is).
export type Waiting = { item: Message; taken?: true };
type Queued = Extract<ThreadItem, { kind: "queued" }>;

const sameMessage = (q: Queued, m: Message): boolean => {
  const a = q.msg;
  if (a.kind !== m.kind || a.text !== m.text) return false;
  return a.kind !== "user" || m.kind !== "user" || ((a.via ?? "") === (m.via ?? "") && (a.ref ?? "") === (m.ref ?? ""));
};

// The items as read → the rows and the wait line. A message that waits is not
// a row: the view shows it after the last row, and the row it becomes (where
// the agent got it) is then the newest one, so nothing moves.
//   - "remove" takes a message out in the middle of a turn; its row (`mid`)
//     follows. Between the two it is `taken`.
//   - A user line that starts a turn takes out the message it is. The line
//     runs in order, so a message that is older than the one a turn started
//     with was not in the line any more: its session ended first ("lost").
//     The same for every message when a turn starts with a line that never
//     waited (no "dequeue" before it).
//   - "pop": the user took the waiting text back into the input box ("back").
// A lost or taken-back message is a row at the place where it was sent.
export function queueView(all: readonly Held[]): { items: Shown[]; waiting: Waiting[] } {
  const out: Shown[] = [];
  let pend: { q: Queued; pos: number }[] = [];
  const taken: { q: Queued; at: number }[] = [];
  let closed: { pos: number; q: Queued; how: "lost" | "back" }[] = [];
  let dequeued = false;
  const close = (list: { q: Queued; pos: number }[], how: "lost" | "back"): void => {
    for (const p of list) closed.push({ pos: p.pos, q: p.q, how });
  };
  // The agent got a message that was held as lost: the guess was wrong.
  const found = (m: Message): void => {
    for (let i = closed.length - 1; i >= 0; i--) {
      if (closed[i].how !== "lost" || !sameMessage(closed[i].q, m)) continue;
      closed = closed.filter((_, n) => n !== i);
      return;
    }
  };
  // The first message of the line that a turn starts with, and all the older ones as lost.
  const start = (at: number): void => {
    close(pend.slice(0, at), "lost");
    pend = pend.slice(at + 1);
  };
  for (const it of all) {
    if (it.kind === "queued") { pend.push({ q: it, pos: out.length }); continue; }
    if (it.kind === "unqueue") {
      if (it.op === "dequeue") dequeued = true;
      else if (it.op === "pop") {
        close(pend.filter((p) => p.q.msg.kind === "user"), "back");
        pend = pend.filter((p) => p.q.msg.kind !== "user");
      } else {
        let i = it.h ? pend.findIndex((p) => p.q.h === it.h) : -1;
        if (it.op === "line") {
          // A harness prompt that is not shown started a turn.
          if (i < 0 && dequeued && it.as) i = pend.findIndex((p) => p.q.msg.kind === it.as);
          if (i >= 0) start(i);
          dequeued = false;
          continue;
        }
        // The text can change a little between the two lines (a peer's tag).
        if (i < 0 && it.as) i = pend.findIndex((p) => p.q.msg.kind === it.as);
        if (i >= 0) taken.push({ q: pend.splice(i, 1)[0].q, at: out.length });
      }
      continue;
    }
    if (it.kind === "user" || it.kind === "peer") {
      if (it.mid) {
        let i = taken.findIndex((t) => sameMessage(t.q, it));
        if (i < 0) i = taken.findIndex((t) => t.q.msg.kind === it.kind);
        if (i >= 0) taken.splice(i, 1);
        else {
          // Its "remove" line is not in what was read.
          const j = pend.findIndex((p) => sameMessage(p.q, it));
          if (j >= 0) pend.splice(j, 1);
          else found(it);
        }
      } else if (!(it.kind === "user" && (it.via === "command" || it.via === "shell"))) {
        let i = pend.findIndex((p) => sameMessage(p.q, it));
        if (i < 0 && dequeued) i = pend.findIndex((p) => p.q.msg.kind === it.kind);
        if (i >= 0) start(i);
        else {
          found(it);
          if (!dequeued) { close(pend, "lost"); pend = []; }
        }
        dequeued = false;
      }
    }
    out.push(it);
  }
  const waiting: Waiting[] = [
    // Taken, and no row came after: its own row is the next thing to arrive.
    ...taken.filter((t) => t.at === out.length).map((t) => ({ item: t.q.msg as Message, taken: true as const })),
    ...pend.map((p) => ({ item: p.q.msg as Message })),
  ];
  if (closed.length === 0) return { items: out, waiting };
  closed.sort((a, b) => a.pos - b.pos);
  const items: Shown[] = [];
  let c = 0;
  for (let i = 0; i <= out.length; i++) {
    for (; c < closed.length && closed[c].pos === i; c++) items.push({ ...closed[c].q.msg, q: closed[c].how });
    if (i < out.length) items.push(out[i]);
  }
  return { items, waiting };
}

const isSubagentTool = (tool: string): boolean => tool === "Agent" || tool === "Task";
export const isSubagentStep = (it: ThreadItem): boolean => it.kind === "step" && isSubagentTool(it.tool);

const key = (it: ThreadItem): string => `${it.kind === "step" ? "s" : "m"}:${it.id}`;
const MAX_PENDING_ENDS = 500;

function withEnds(items: Held[], ends: ThreadState["ends"]): { items: Held[]; ends: ThreadState["ends"] } {
  let left = ends;
  const out = items.map((it) => {
    if (it.kind !== "step" || it.end !== undefined) return it;
    const e = left[it.id];
    if (!e) return it;
    if (left === ends) left = { ...ends };
    delete left[it.id];
    const launch = e.agent && isSubagentStep(it) ? { agent: e.agent, ...(e.bg ? { bg: true as const } : {}) } : {};
    return { ...it, end: e.ts, ...(e.error ? { error: true } : {}), ...launch };
  });
  return { items: out, ends: left };
}

type Subs = Record<string, SubagentState>;
const SUB_KEYS: (keyof SubagentState)[] = ["state", "steps", "step", "end", "last", "start", "more", "description", "agentType", "depth"];
const sameSub = (a: SubagentState, b: SubagentState): boolean => SUB_KEYS.every((k) => a[k] === b[k]);

// The states of an answer into the ones held. The same object comes back when
// nothing changed, so the caller can tell. A subagent that was asked for
// (`polled`) and is not in the answer has no file any more: it is stopped.
function mergeSubs(prev: Subs | undefined, got: Subs | undefined, polled: readonly string[]): Subs | undefined {
  let out = prev;
  const put = (id: string, s: SubagentState): void => {
    if (out === prev) out = { ...prev };
    (out as Subs)[id] = s;
  };
  for (const [id, s] of Object.entries(got ?? {})) {
    const old = prev?.[id];
    if (!old || !sameSub(old, s)) put(id, s);
  }
  for (const id of polled) {
    const old = prev?.[id];
    if (old && old.state === "running" && !got?.[id]) put(id, { ...old, state: "stopped", end: old.last });
  }
  return out;
}

// A page into the state. "tail" (or a reset) replaces it; "older" goes in
// front; "newer" at the end. An item already held is not added twice.
// `polled`: the subagents the request named in `subs`.
export function applyPage(
  prev: ThreadState | null, res: ThreadPageRes, where: "tail" | "older" | "newer", polled: readonly string[] = [],
): ThreadState {
  // One id, one item: the view keys its rows by id, and a session file can
  // hold a line twice (a resumed session copies lines).
  const seen = new Set<string>();
  const fresh = res.items.filter((it): it is Held => {
    if (it.kind === "end" || seen.has(key(it))) return false;
    seen.add(key(it));
    return true;
  });
  const newEnds: ThreadState["ends"] = {};
  for (const it of res.items) {
    if (it.kind !== "end") continue;
    newEnds[it.id] = { ts: it.ts, ...(it.error ? { error: true } : {}), ...(it.agent ? { agent: it.agent } : {}), ...(it.bg ? { bg: true as const } : {}) };
  }

  // The wait line's items are kept only when there are some: a thread with
  // none (a subagent's file, an old session) holds one list, as before.
  const view = (all: Held[]): Pick<ThreadState, "items" | "all" | "waiting"> => {
    if (!all.some((it) => it.kind === "queued" || it.kind === "unqueue")) return { items: all as Shown[] };
    const v = queueView(all);
    return { items: v.items, all, ...(v.waiting.length ? { waiting: v.waiting } : {}) };
  };
  if (!prev || where === "tail" || res.reset || prev.sessionId !== res.sessionId) {
    return { sessionId: res.sessionId, ...view(fresh), start: res.start, end: res.end, ends: newEnds, ...(res.subs ? { subs: res.subs } : {}) };
  }
  const subs = mergeSubs(prev.subs, res.subs, polled);
  const held: Held[] = prev.all ?? prev.items;
  const have = new Set(held.map(key));
  const added = fresh.filter((it) => !have.has(key(it)));
  let pending = { ...prev.ends, ...newEnds };
  const names = Object.keys(pending);
  if (names.length > MAX_PENDING_ENDS) {
    pending = Object.fromEntries(names.slice(-MAX_PENDING_ENDS).map((k) => [k, pending[k]]));
  }
  const merged = where === "older" ? [...added, ...held] : [...held, ...added];
  const done = withEnds(merged, pending);
  return {
    sessionId: prev.sessionId,
    ...view(done.items),
    start: where === "older" ? res.start : prev.start,
    end: where === "newer" ? Math.max(prev.end, res.end) : prev.end,
    ends: done.ends,
    ...(subs ? { subs } : {}),
  };
}

export type Block =
  | { type: "msg"; key: string; item: Message }
  | { type: "note"; key: string; item: Extract<ThreadItem, { kind: "note" }> }
  | { type: "day"; key: string; ts: number }
  // Consecutive tool steps, shown as one line. `to`: when the group ended (the
  // next item, else its last result); null while its last step still runs.
  | { type: "steps"; key: string; steps: Step[]; from: number; to: number | null }
  // A subagent launch: a line of its own, never inside a group of steps.
  | { type: "sub"; key: string; item: Step };

const localDay = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Items → what the view draws: messages, notes, one block per run of steps,
// and a day line where the date changes. `dayOf` is a parameter for tests.
export function toBlocks(items: Shown[], dayOf: (ts: number) => string = localDay): Block[] {
  const out: Block[] = [];
  let day = "";
  let run: Step[] = [];
  const flush = (nextTs: number | null): void => {
    if (run.length === 0) return;
    const last = run[run.length - 1];
    const lastEnd = run.reduce((m, st) => Math.max(m, st.end ?? 0), 0);
    const to = nextTs !== null ? Math.max(nextTs, lastEnd) : last.end !== undefined ? lastEnd : null;
    out.push({ type: "steps", key: `g:${run[0].id}`, steps: run, from: run[0].ts, to });
    run = [];
  };
  for (const it of items) {
    const d = it.ts ? dayOf(it.ts) : day;
    const newDay = d !== day;
    const sub = it.kind === "step" && isSubagentTool(it.tool);
    if (it.kind === "step" && !newDay && !sub) { run.push(it); continue; }
    flush(it.ts || null);
    if (newDay) {
      if (day !== "") out.push({ type: "day", key: `d:${d}`, ts: it.ts });
      day = d;
    }
    if (it.kind === "step") {
      if (sub) out.push({ type: "sub", key: `a:${it.id}`, item: it });
      else run.push(it);
    }
    else if (it.kind === "note") out.push({ type: "note", key: `n:${it.id}`, item: it });
    else out.push({ type: "msg", key: `m:${it.id}`, item: it });
  }
  flush(null);
  return out;
}

// What the agent does now, for the one live line. Null when it is not running.
// `label` is the newest step with no result yet (null: the model is writing or
// thinking); `since` is when that began.
export function liveStep(items: Shown[], status: string): { label: string | null; since: number } | null {
  if (status !== "running") return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "step" && it.end === undefined) return { label: it.label, since: it.ts };
    if (it.kind === "user" || it.kind === "peer") break; // an older turn's step is not the current one
  }
  const last = items[items.length - 1];
  return { label: null, since: last ? (last.kind === "step" && last.end !== undefined ? last.end : last.ts) : 0 };
}

// The quiet signal. The Claude spinner repaints the terminal all the time, so
// terminal output says nothing; the session file does. A running agent whose
// session got no line for this long is "quiet". That is information, not an
// error: a long tool run or a subagent writes nothing to the file either.
export const QUIET_AFTER_MS = 10 * 60_000;

// From when the silence counts: the session's last line, but not before the
// agent started to run (the first line of a new turn comes a moment after the
// status changes; the hours the agent was idle before are not silence).
export function quietSince(lastEntryAt: number | null | undefined, runningSince: number | null): number | null {
  if (!lastEntryAt) return null;
  return Math.max(lastEntryAt, runningSince ?? 0);
}

// How long the agent is quiet, in ms; null when it is not (not running, no
// session time, or less than `after`). `now` is on the server's clock.
export function quietMs(status: string | null, since: number | null, now: number, after = QUIET_AFTER_MS): number | null {
  if (status !== "running" || !since) return null;
  const ms = now - since;
  return ms >= after ? ms : null;
}

// The mark: "no output 14 min", "no output 1 h 5 min". Whole minutes, floor.
export function quietLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `no output ${m} min`;
  return `no output ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

// What the line of one subagent shows. `sub` is its state from the server
// (absent: not known, or the step has no subagent id yet).
//   running / done / stopped: as the server tells (stopped: no end recorded and
//     nothing writes its file any more);
//   failed: the launch step itself failed;
//   launched: started in the background, and its file cannot be read.
// `until` is null while it runs and when its end is not known. `id`: the
// subagent to open; null when the step names none.
export type SubView = {
  title: string;
  state: "running" | "done" | "stopped" | "failed" | "launched";
  since: number;
  until: number | null;
  step: string | null;
  steps: number | null;
  more: boolean;
  agentType: string;
  id: string | null;
};

export function subView(step: Step, sub: SubagentState | undefined, status: string): SubView {
  const title = sub?.description || step.label.replace(/ \(subagent\)$/, "");
  const id = step.agent ?? null;
  if (sub) {
    return {
      title, id, state: sub.state, since: sub.start ?? step.ts,
      until: sub.state === "running" ? null : sub.end ?? null,
      step: sub.step ?? null, steps: sub.steps ?? null, more: sub.more === true, agentType: sub.agentType,
    };
  }
  const rest = { title, id, since: step.ts, step: null, steps: null, more: false, agentType: "" };
  // A background launch ends at once: its result says nothing about the subagent.
  if (step.bg) return { ...rest, state: step.error ? "failed" : "launched", until: null };
  if (step.end === undefined) return { ...rest, state: status === "running" ? "running" : "stopped", until: null };
  return { ...rest, state: step.error ? "failed" : "done", until: step.end };
}

// Two states of one subagent (the thread's poll and the subagent's own page
// answer at different moments): the one from the later write of its file; with
// the same write, the one that says it ended.
export function newerSub(a: SubagentState | undefined, b: SubagentState | undefined): SubagentState | undefined {
  if (!a || !b) return a ?? b;
  return b.last > a.last || (b.last === a.last && a.state === "running") ? b : a;
}

// `held` with each state of `fresh` that is newer. The same object when none is.
export function newerSubs(
  held: Record<string, SubagentState> | undefined, fresh: Record<string, SubagentState>,
): Record<string, SubagentState> | undefined {
  let out = held;
  for (const id in fresh) {
    const best = newerSub(held?.[id], fresh[id]) as SubagentState;
    if (best === held?.[id]) continue;
    if (out === held) out = { ...held };
    (out as Record<string, SubagentState>)[id] = best;
  }
  return out;
}

// "12 steps", "1 step", "120+ steps" (the count is of the part of the file read).
export function subSteps(v: Pick<SubView, "steps" | "more">): string {
  if (v.steps === null) return "";
  return `${v.steps}${v.more ? "+" : ""} step${v.steps === 1 && !v.more ? "" : "s"}`;
}

// The subagents to ask the state of again: the ones held as running.
export const MAX_POLLED_SUBS = 24;
export function runningSubIds(subs: Record<string, SubagentState> | undefined): string[] {
  if (!subs) return [];
  const ids: string[] = [];
  for (const id in subs) if (subs[id].state === "running" && ids.length < MAX_POLLED_SUBS) ids.push(id);
  return ids;
}

// The live line while the agent itself does not run and its subagents do:
// "2 subagents working · Review the reminders feature" and the time of the one
// that runs longest. Null when none of the loaded launch steps still runs.
// `count`: how many run.
export function subsLive(items: Shown[], subs: Record<string, SubagentState> | undefined): { text: string; since: number; count: number } | null {
  if (!subs) return null;
  let n = 0;
  let first: { title: string; since: number } | null = null;
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind !== "step" || !isSubagentTool(it.tool) || !it.agent || seen.has(it.agent)) continue;
    seen.add(it.agent);
    const sub = subs[it.agent];
    if (!sub || sub.state !== "running") continue;
    n++;
    const v = subView(it, sub, "");
    if (!first || v.since < first.since) first = { title: v.title, since: v.since };
  }
  if (!first) return null;
  return { text: `${n === 1 ? "Subagent" : `${n} subagents`} working · ${first.title}`, since: first.since, count: n };
}

// The header chip while the agent is between turns and subagents of it still
// work. "Your turn" would be wrong then: the agent goes on by itself when they
// end. Null in every other case (the agent runs, or no loaded subagent runs).
export function subsChip(status: string | null, state: Pick<ThreadState, "items" | "subs"> | null): string | null {
  if (status !== "idle" || !state) return null;
  const live = subsLive(state.items, state.subs);
  if (!live) return null;
  return live.count === 1 ? "subagent working" : `${live.count} subagents working`;
}

// A length of time in one unit pair at most: "40 s", "7 min", "1 h 35 min".
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${Math.max(1, s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// A running clock: "8 s", "1 min 40 s", "1 h 35 min".
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const two = (n: number): string => String(n).padStart(2, "0");
export function fmtClock(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// The fold line of a step group: "9 steps · 7 min".
export function stepsSummary(b: Extract<Block, { type: "steps" }>): string {
  const n = b.steps.length;
  const count = `${n} step${n === 1 ? "" : "s"}`;
  return b.to === null ? count : `${count} · ${fmtSpan(b.to - b.from)}`;
}

// Which view the middle column shows. The user's choice is kept per browser;
// with no readable session the terminal shows whatever the choice is.
export type PaneMode = "thread" | "terminal";
export const PANE_MODE_KEY = "choibot.agentPaneMode";
export function readPaneMode(storage: Pick<Storage, "getItem"> | undefined): PaneMode {
  try { return storage?.getItem(PANE_MODE_KEY) === "terminal" ? "terminal" : "thread"; } catch { return "thread"; }
}
export function shownMode(pref: PaneMode, available: boolean | null): PaneMode | "loading" {
  if (pref === "terminal") return "terminal";
  if (available === null) return "loading";
  return available ? "thread" : "terminal";
}
