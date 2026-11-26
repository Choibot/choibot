import { describe, it, expect } from "vitest";
import {
  applyPage, fmtClock, fmtElapsed, fmtSpan, liveStep, queueView, readPaneMode, shownMode, stepsSummary, toBlocks,
  quietLabel, quietMs, quietSince, QUIET_AFTER_MS,
  PANE_MODE_KEY, type Block, type Held, type Shown, type ThreadItem, type ThreadPageRes,
} from "./thread";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const user = (id: string, ts: number, text = "prompt"): Shown => ({ kind: "user", id, ts, text });
const say = (id: string, ts: number, text = "answer"): Shown => ({ kind: "assistant", id, ts, text });
const step = (id: string, ts: number, end?: number, label = `do ${id}`): Shown => ({ kind: "step", id, ts, tool: "Bash", label, ...(end ? { end } : {}) });
const page = (items: ThreadItem[], over: Partial<ThreadPageRes> = {}): ThreadPageRes =>
  ({ ok: true, sessionId: "s1", status: "running", now: T0, items, start: 100, end: 900, ...over });
const sameDay = (): string => "day";

describe("applyPage", () => {
  it("takes the tail as the whole state", () => {
    const st = applyPage(null, page([user("u1", T0), { kind: "end", id: "old", ts: T0 + 5 }]), "tail");
    expect(st).toEqual({ sessionId: "s1", items: [user("u1", T0)], start: 100, end: 900, ends: { old: { ts: T0 + 5 } } });
  });
  it("keeps one item for an id that is in a page twice", () => {
    const st = applyPage(null, page([user("u1", T0), step("t1", T0 + 1), say("a1", T0 + 2), step("t1", T0 + 3), say("a1", T0 + 4)]), "tail");
    expect(st.items.map((i) => `${i.kind}:${i.id}:${i.ts - T0}`)).toEqual(["user:u1:0", "step:t1:1", "assistant:a1:2"]);
  });
  it("appends newer items once and moves only the end cursor", () => {
    const st = applyPage(null, page([user("u1", T0)]), "tail");
    const next = applyPage(st, page([user("u1", T0), say("a1", T0 + 1)], { start: null, end: 1200 }), "newer");
    expect(next.items.map((i) => i.id)).toEqual(["u1", "a1"]);
    expect(next.start).toBe(100);
    expect(next.end).toBe(1200);
  });
  it("closes a running step when its result arrives later", () => {
    const st = applyPage(null, page([user("u1", T0), step("t1", T0 + 1)]), "tail");
    const next = applyPage(st, page([{ kind: "end", id: "t1", ts: T0 + 9, error: true }], { end: 950 }), "newer");
    expect(next.items[1]).toEqual({ ...step("t1", T0 + 1), end: T0 + 9, error: true });
    expect(next.ends).toEqual({});
  });
  it("puts an older page in front and gives its steps the results seen before", () => {
    const st = applyPage(null, page([{ kind: "end", id: "t0", ts: T0 + 50 }, say("a1", T0 + 60)]), "tail");
    const next = applyPage(st, page([user("u0", T0), step("t0", T0 + 1)], { start: null, end: 100 }), "older");
    expect(next.items.map((i) => i.id)).toEqual(["u0", "t0", "a1"]);
    expect(next.items[1]).toMatchObject({ end: T0 + 50 });
    expect(next.start).toBeNull();
    expect(next.end).toBe(900);
    expect(next.ends).toEqual({});
  });
  it("starts again on a reset or a new session", () => {
    const st = applyPage(null, page([user("u1", T0), say("a1", T0 + 1)]), "tail");
    expect(applyPage(st, page([say("a9", T0 + 9)], { reset: true }), "newer").items.map((i) => i.id)).toEqual(["a9"]);
    const moved = applyPage(st, page([user("n1", T0 + 9)], { sessionId: "s2" }), "newer");
    expect(moved).toMatchObject({ sessionId: "s2", items: [{ id: "n1" }] });
  });
});

describe("toBlocks", () => {
  it("folds the steps between two messages into one block with its time", () => {
    const blocks = toBlocks([
      user("u1", T0), step("a", T0 + MIN, T0 + 2 * MIN), step("b", T0 + 3 * MIN, T0 + 6 * MIN), say("a1", T0 + 8 * MIN),
    ], sameDay);
    expect(blocks.map((b) => b.type)).toEqual(["msg", "steps", "msg"]);
    const g = blocks[1] as Extract<Block, { type: "steps" }>;
    expect(g.steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(g.to! - g.from).toBe(7 * MIN);
    expect(stepsSummary(g)).toBe("2 steps · 7 min");
  });
  it("leaves the last group open while its last step runs", () => {
    const blocks = toBlocks([user("u1", T0), step("a", T0 + MIN, T0 + 2 * MIN), step("b", T0 + 3 * MIN)], sameDay);
    const g = blocks[1] as Extract<Block, { type: "steps" }>;
    expect(g.to).toBeNull();
    expect(stepsSummary(g)).toBe("2 steps");
  });
  it("ends a finished last group at its last result", () => {
    const g = toBlocks([step("a", T0, T0 + 30_000)], sameDay)[0] as Extract<Block, { type: "steps" }>;
    expect(stepsSummary(g)).toBe("1 step · 30 s");
  });
  it("keeps a note apart and breaks the group there", () => {
    const blocks = toBlocks([step("a", T0, T0 + 1), { kind: "note", id: "n", ts: T0 + 2, text: "Interrupted" }, step("b", T0 + 3, T0 + 4)], sameDay);
    expect(blocks.map((b) => b.type)).toEqual(["steps", "note", "steps"]);
  });
  it("adds a day line where the date changes, not before the first item", () => {
    const dayOf = (ts: number): string => (ts < T0 + 100 ? "mon" : "tue");
    const blocks = toBlocks([user("u1", T0), say("a1", T0 + 50), user("u2", T0 + 200), step("a", T0 + 300)], dayOf);
    expect(blocks.map((b) => b.type)).toEqual(["msg", "msg", "day", "msg", "steps"]);
  });
});

describe("liveStep", () => {
  it("is null unless the agent runs", () => {
    expect(liveStep([user("u1", T0), step("a", T0 + 1)], "idle")).toBeNull();
    expect(liveStep([user("u1", T0)], "done")).toBeNull();
  });
  it("names the newest step with no result", () => {
    const items = [user("u1", T0), step("a", T0 + 1, T0 + 2), step("b", T0 + 3, undefined, "Review the change (subagent)"), step("c", T0 + 4, T0 + 5)];
    expect(liveStep(items, "running")).toEqual({ label: "Review the change (subagent)", since: T0 + 3 });
  });
  it("has no step while the model writes, and counts from the last item", () => {
    expect(liveStep([user("u1", T0), step("a", T0 + 1, T0 + 2)], "running")).toEqual({ label: null, since: T0 + 2 });
    expect(liveStep([user("u1", T0)], "running")).toEqual({ label: null, since: T0 });
    expect(liveStep([], "running")).toEqual({ label: null, since: 0 });
  });
  it("ignores a step with no result from an older turn", () => {
    expect(liveStep([step("lost", T0), user("u2", T0 + 10)], "running")).toEqual({ label: null, since: T0 + 10 });
  });
});

describe("time formats", () => {
  it("fmtSpan rounds to one unit pair", () => {
    expect(fmtSpan(0)).toBe("1 s");
    expect(fmtSpan(40_000)).toBe("40 s");
    expect(fmtSpan(7 * MIN + 10_000)).toBe("7 min");
    expect(fmtSpan(60 * MIN)).toBe("1 h");
    expect(fmtSpan(95 * MIN)).toBe("1 h 35 min");
    expect(fmtSpan(-5)).toBe("1 s");
  });
  it("fmtElapsed counts up", () => {
    expect(fmtElapsed(0)).toBe("0 s");
    expect(fmtElapsed(8_900)).toBe("8 s");
    expect(fmtElapsed(100_000)).toBe("1 min 40 s");
    expect(fmtElapsed(120_000)).toBe("2 min");
    expect(fmtElapsed(95 * MIN + 30_000)).toBe("1 h 35 min");
  });
  it("fmtClock gives local HH:MM, and nothing for no time", () => {
    const d = new Date(2026, 10, 10, 7, 5);
    expect(fmtClock(d.getTime())).toBe("07:05");
    expect(fmtClock(0)).toBe("");
  });
});

describe("pane mode", () => {
  const storage = (v: string | null) => ({ getItem: (k: string) => (k === PANE_MODE_KEY ? v : null) });
  it("defaults to the thread and remembers the terminal", () => {
    expect(readPaneMode(storage(null))).toBe("thread");
    expect(readPaneMode(storage("terminal"))).toBe("terminal");
    expect(readPaneMode(storage("junk"))).toBe("thread");
    expect(readPaneMode(undefined)).toBe("thread");
    expect(readPaneMode({ getItem: () => { throw new Error("blocked"); } })).toBe("thread");
  });
  it("falls back to the terminal when no session can be read", () => {
    expect(shownMode("thread", true)).toBe("thread");
    expect(shownMode("thread", false)).toBe("terminal");
    expect(shownMode("thread", null)).toBe("loading");
    expect(shownMode("terminal", true)).toBe("terminal");
    expect(shownMode("terminal", null)).toBe("terminal");
  });
});

describe("the quiet signal", () => {
  it("is off before 10 minutes and gives the silence after", () => {
    expect(QUIET_AFTER_MS).toBe(10 * MIN);
    expect(quietMs("running", T0, T0 + 10 * MIN - 1)).toBeNull();
    expect(quietMs("running", T0, T0 + 10 * MIN)).toBe(10 * MIN);
    expect(quietMs("running", T0, T0 + 14 * MIN + 30_000)).toBe(14 * MIN + 30_000);
  });
  it("is only for a running agent with a session time", () => {
    for (const status of ["idle", "done", "error", "", null]) expect(quietMs(status, T0, T0 + 60 * MIN)).toBeNull();
    expect(quietMs("running", null, T0 + 60 * MIN)).toBeNull();
    expect(quietMs("running", 0, T0 + 60 * MIN)).toBeNull();
  });
  it("counts from the last entry, but not from before the agent started to run", () => {
    expect(quietSince(null, T0)).toBeNull();
    expect(quietSince(undefined, null)).toBeNull();
    expect(quietSince(T0, null)).toBe(T0);
    // Idle for 3 hours, then a new turn: the silence starts with the turn.
    expect(quietSince(T0, T0 + 180 * MIN)).toBe(T0 + 180 * MIN);
    expect(quietMs("running", quietSince(T0, T0 + 180 * MIN), T0 + 181 * MIN)).toBeNull();
    // A line arrived after the turn began: it is the newer time.
    expect(quietSince(T0 + 5 * MIN, T0)).toBe(T0 + 5 * MIN);
  });
  it("writes the mark in whole minutes", () => {
    expect(quietLabel(10 * MIN)).toBe("no output 10 min");
    expect(quietLabel(14 * MIN + 59_000)).toBe("no output 14 min");
    expect(quietLabel(60 * MIN)).toBe("no output 1 h");
    expect(quietLabel(65 * MIN)).toBe("no output 1 h 5 min");
  });
});

// The wait line: what the server reads of the "queue-operation" lines
// (server/agents/thread.ts), turned into rows and the messages that wait.
describe("queueView", () => {
  const queued = (text: string, ts: number, over: object = {}): Held =>
    ({ kind: "queued", id: `q:${ts}:${text}`, ts, h: `h-${text}`, msg: { kind: "user", id: `q:${ts}:${text}`, ts, text, ...over } });
  const peerQ = (text: string, ts: number): Held =>
    ({ kind: "queued", id: `q:${ts}:${text}`, ts, h: `h-${text}`, msg: { kind: "peer", id: `q:${ts}:${text}`, ts, text, from: "agent-2" } });
  const gone = (op: "remove" | "pop" | "dequeue" | "line", ts: number, text?: string, as: "user" | "peer" = "user"): Held =>
    ({ kind: "unqueue", id: `u:${ts}:${op}`, ts, op, ...(text ? { h: `h-${text}`, as } : {}) });
  const mid = (id: string, ts: number, text: string): Shown => ({ kind: "user", id, ts, text, mid: true });
  const ids = (v: { items: Shown[] }): string[] => v.items.map((i) => i.id);
  const texts = (v: { waiting: { item: { text: string }; taken?: true }[] }): string[] => v.waiting.map((w) => `${w.item.text}${w.taken ? " (taken)" : ""}`);

  it("holds a message that waits apart from the rows", () => {
    const v = queueView([user("u1", T0), step("t1", T0 + 1), queued("also the docs", T0 + 2), step("t2", T0 + 3)]);
    expect(ids(v)).toEqual(["u1", "t1", "t2"]);
    expect(v.waiting).toEqual([{ item: { kind: "user", id: `q:${T0 + 2}:also the docs`, ts: T0 + 2, text: "also the docs" } }]);
  });

  it("enqueue then dequeue at a turn start: the user line is the one row", () => {
    const v = queueView([user("u1", T0), queued("next thing", T0 + 2), say("a1", T0 + 3), gone("dequeue", T0 + 4), user("u2", T0 + 5, "next thing")]);
    expect(ids(v)).toEqual(["u1", "a1", "u2"]);
    expect(v.waiting).toEqual([]);
  });

  it("a message sent to an idle agent is enqueued and dequeued at once: one row, no wait", () => {
    const v = queueView([queued("hello", T0), gone("dequeue", T0 + 1), user("u1", T0 + 2, "hello"), say("a1", T0 + 3)]);
    expect(ids(v)).toEqual(["u1", "a1"]);
    expect(v.waiting).toEqual([]);
  });

  it("enqueue then delivered in the middle of a turn: one row, where the agent got it", () => {
    const v = queueView([
      user("u1", T0), step("t1", T0 + 1), queued("also the docs", T0 + 2), step("t2", T0 + 3),
      gone("remove", T0 + 4, "also the docs"), mid("m1", T0 + 2, "also the docs"), say("a1", T0 + 5),
    ]);
    expect(ids(v)).toEqual(["u1", "t1", "t2", "m1", "a1"]);
    expect(v.waiting).toEqual([]);
  });

  it("between the remove and the message's own row the message stays on screen", () => {
    const at = [user("u1", T0), step("t1", T0 + 1), queued("also the docs", T0 + 2), gone("remove", T0 + 4, "also the docs")];
    expect(texts(queueView(at))).toEqual(["also the docs (taken)"]);
    // Its row arrives: the row takes its place.
    const v = queueView([...at, mid("m1", T0 + 2, "also the docs")]);
    expect(ids(v)).toEqual(["u1", "t1", "m1"]);
    expect(v.waiting).toEqual([]);
    // A row that is not its own came after the remove (the text was not a message): it is gone.
    expect(queueView([...at, say("a1", T0 + 6)]).waiting).toEqual([]);
  });

  it("takes the oldest message of the kind when the text changed between the two lines", () => {
    const v = queueView([peerQ("report v1", T0), queued("mine", T0 + 1), gone("remove", T0 + 2, "report v1 (edited)", "peer")]);
    expect(texts(v)).toEqual(["report v1 (taken)", "mine"]);
  });

  it("enqueue then taken back by the user: a row at its place, marked", () => {
    const v = queueView([user("u1", T0), queued("wrong text", T0 + 2), step("t1", T0 + 3), gone("pop", T0 + 4, "wrong text"), say("a1", T0 + 5)]);
    expect(v.items.map((i) => (i.kind === "user" ? `${i.id}:${i.q ?? ""}` : i.id))).toEqual(["u1:", `q:${T0 + 2}:wrong text:back`, "t1", "a1"]);
    expect(v.waiting).toEqual([]);
  });

  it("a pop takes every message of the user out, not a peer's", () => {
    const v = queueView([queued("one", T0), peerQ("report", T0 + 1), queued("two", T0 + 2), gone("pop", T0 + 3)]);
    expect(texts(v)).toEqual(["report"]);
    expect(v.items.map((i) => (i.kind === "user" ? i.q : ""))).toEqual(["back", "back"]);
  });

  it("two messages wait: the first starts the next turn, the second still waits", () => {
    const v = queueView([
      user("u1", T0), queued("first", T0 + 1), queued("second", T0 + 2), say("a1", T0 + 3),
      gone("dequeue", T0 + 4), user("u2", T0 + 5, "first"), step("t1", T0 + 6),
    ]);
    expect(ids(v)).toEqual(["u1", "a1", "u2", "t1"]);
    expect(texts(v)).toEqual(["second"]);
  });

  it("a digest, a peer message and a queue answer that wait keep their kind", () => {
    const v = queueView([
      user("u1", T0), queued("agent-1 waiting", T0 + 1, { via: "events" }), peerQ("the build is green", T0 + 2),
      queued("choice: A", T0 + 3, { via: "queue", ref: "q1" }),
    ]);
    expect(v.waiting.map((w) => (w.item.kind === "user" ? `user:${w.item.via}` : w.item.kind))).toEqual(["user:events", "peer", "user:queue"]);
    // A plain message with the text of the queue answer is not the answer.
    const turn = queueView([queued("choice: A", T0 + 3, { via: "queue", ref: "q1" }), gone("dequeue", T0 + 4), user("u2", T0 + 5, "choice: A")]);
    expect(turn.waiting).toEqual([]); // the dequeue says the head of the line started the turn
    const direct = queueView([queued("choice: A", T0 + 3, { via: "queue", ref: "q1" }), mid("m1", T0 + 5, "choice: A")]);
    expect(texts(direct)).toEqual(["choice: A"]);
  });

  it("a harness prompt that is not shown takes itself out of the line", () => {
    const v = queueView([user("u1", T0), queued("Continue: the next step", T0 + 1), say("a1", T0 + 2), gone("dequeue", T0 + 3), gone("line", T0 + 4, "Continue: the next step")]);
    expect(ids(v)).toEqual(["u1", "a1"]);
    expect(v.waiting).toEqual([]);
  });

  it("a message whose session stopped before the agent read it is a row, marked lost", () => {
    // The next turn starts with a line that never waited: the old line is gone.
    const v = queueView([user("u1", T0), step("t1", T0 + 1), queued("never read", T0 + 2), user("u2", T0 + 60_000, "new session"), say("a1", T0 + 60_001)]);
    expect(v.items.map((i) => (i.kind === "user" ? `${i.text}:${i.q ?? ""}` : i.id))).toEqual(["prompt:", "t1", "never read:lost", "new session:", "a1"]);
    expect(v.waiting).toEqual([]);
    // The agent got it after all: the row of the agent's is the one row.
    const healed = queueView([queued("late", T0), user("u2", T0 + 1, "other"), mid("m1", T0, "late")]);
    expect(healed.items.map((i) => i.id)).toEqual(["u2", "m1"]);
  });

  it("a slash command or a shell line does not end the wait of a message", () => {
    const v = queueView([queued("still here", T0), { kind: "user", id: "c1", ts: T0 + 1, text: "/compact", via: "command" }, { kind: "user", id: "s1", ts: T0 + 2, text: "! ls", via: "shell" }]);
    expect(texts(v)).toEqual(["still here"]);
  });
});

describe("applyPage: the wait line", () => {
  const queued = (text: string, ts: number): ThreadItem =>
    ({ kind: "queued", id: `q:${ts}`, ts, h: `h-${text}`, msg: { kind: "user", id: `q:${ts}`, ts, text } });

  it("keeps one list when the thread has no wait line", () => {
    const st = applyPage(null, page([user("u1", T0), say("a1", T0 + 1)]), "tail");
    expect(st.all).toBeUndefined();
    expect(st.waiting).toBeUndefined();
  });

  it("shows a message that waits after a reload (the tail has its enqueue)", () => {
    const st = applyPage(null, page([user("u1", T0), step("t1", T0 + 1), queued("also the docs", T0 + 2)]), "tail");
    expect(st.items.map((i) => i.id)).toEqual(["u1", "t1"]);
    expect(st.waiting?.map((w) => w.item.text)).toEqual(["also the docs"]);
  });

  it("takes the message out when a later poll brings the line that took it", () => {
    const st = applyPage(null, page([user("u1", T0), step("t1", T0 + 1), queued("also the docs", T0 + 2)]), "tail");
    const next = applyPage(st, page([
      { kind: "end", id: "t1", ts: T0 + 3 }, { kind: "unqueue", id: "u:1", ts: T0 + 3, op: "remove", h: "h-also the docs", as: "user" },
      { kind: "user", id: "m1", ts: T0 + 2, text: "also the docs", mid: true },
    ], { end: 1200 }), "newer");
    expect(next.items.map((i) => i.id)).toEqual(["u1", "t1", "m1"]);
    expect(next.waiting).toBeUndefined();
    expect(next.items[1]).toMatchObject({ kind: "step", end: T0 + 3 });
  });

  it("reads an enqueue of an older page against the newer lines already held", () => {
    const st = applyPage(null, page([{ kind: "unqueue", id: "u:1", ts: T0 + 3, op: "dequeue" }, user("u2", T0 + 4, "next thing"), say("a2", T0 + 5)]), "tail");
    const older = applyPage(st, page([user("u1", T0), queued("next thing", T0 + 2)], { start: null }), "older");
    expect(older.items.map((i) => i.id)).toEqual(["u1", "u2", "a2"]);
    expect(older.waiting).toBeUndefined();
  });
});
