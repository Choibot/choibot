import { describe, it, expect } from "vitest";
import {
  applyPage, liveStep, newerSub, newerSubs, runningSubIds, subSteps, subView, subsChip, subsLive, toBlocks, MAX_POLLED_SUBS,
  type Shown, type Step, type SubagentState, type ThreadItem, type ThreadPageRes,
} from "./thread";

// The subagent side of src/lib/thread.ts.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const A1 = "a521e7a16e68e274c";
const A2 = "a60f72618901508d2";
const user = (id: string, ts: number): Shown => ({ kind: "user", id, ts, text: "prompt" });
const say = (id: string, ts: number): Shown => ({ kind: "assistant", id, ts, text: "answer" });
const step = (id: string, ts: number, end?: number): Step => ({ kind: "step", id, ts, tool: "Bash", label: `do ${id}`, ...(end ? { end } : {}) });
const launch = (id: string, ts: number, over: Partial<Step> = {}): Step =>
  ({ kind: "step", id, ts, tool: "Agent", label: `Review ${id} (subagent)`, ...over });
const bg = (id: string, ts: number, agent: string): Step => launch(id, ts, { end: ts + 30, agent, bg: true });
const sub = (id: string, over: Partial<SubagentState> = {}): SubagentState =>
  ({ id, description: `Review ${id}`, agentType: "general-purpose", state: "running", last: T0, steps: 3, step: "Read the spec", ...over });
const page = (items: ThreadItem[], over: Partial<ThreadPageRes> = {}): ThreadPageRes =>
  ({ ok: true, sessionId: "s1", status: "idle", now: T0, items, start: 100, end: 900, ...over });
const sameDay = (): string => "day";

describe("toBlocks: subagents", () => {
  it("gives a subagent a line of its own, outside the groups of steps", () => {
    const blocks = toBlocks([
      user("u1", T0), step("a", T0 + 1, T0 + 2), step("b", T0 + 3, T0 + 4), bg("t1", T0 + 5, A1), bg("t2", T0 + 6, A2),
      step("c", T0 + 7, T0 + 8), say("a1", T0 + 9),
    ], sameDay);
    expect(blocks.map((b) => b.type)).toEqual(["msg", "steps", "sub", "sub", "steps", "msg"]);
    expect(blocks[2]).toMatchObject({ type: "sub", key: "a:t1", item: { id: "t1", agent: A1 } });
    const first = blocks[1] as Extract<typeof blocks[number], { type: "steps" }>;
    expect(first.steps.map((s) => s.id)).toEqual(["a", "b"]);
    // The group before it ends where the subagent starts.
    expect(first.to).toBe(T0 + 5);
  });

  it("treats the old tool name Task as a subagent, and TaskCreate as a step", () => {
    const blocks = toBlocks([
      { ...launch("t1", T0), tool: "Task" }, { ...step("x", T0 + 1, T0 + 2), tool: "TaskCreate" },
    ], sameDay);
    expect(blocks.map((b) => b.type)).toEqual(["sub", "steps"]);
  });
});

describe("applyPage: subagents", () => {
  it("keeps the states of the tail page", () => {
    const st = applyPage(null, page([bg("t1", T0, A1)], { subs: { [A1]: sub(A1) } }), "tail");
    expect(st.subs).toEqual({ [A1]: sub(A1) });
  });

  it("holds no `subs` for a thread without subagents", () => {
    expect(applyPage(null, page([user("u1", T0)]), "tail")).not.toHaveProperty("subs");
  });

  it("merges a poll, and keeps the same object when nothing changed", () => {
    const st = applyPage(null, page([bg("t1", T0, A1)], { subs: { [A1]: sub(A1) } }), "tail");
    const same = applyPage(st, page([], { subs: { [A1]: sub(A1) } }), "newer", [A1]);
    expect(same.subs).toBe(st.subs);
    const moved = applyPage(st, page([], { subs: { [A1]: sub(A1, { steps: 4, step: "Search the code" }) } }), "newer", [A1]);
    expect(moved.subs).not.toBe(st.subs);
    expect(moved.subs?.[A1]).toMatchObject({ steps: 4, step: "Search the code" });
    const done = applyPage(moved, page([], { subs: { [A1]: sub(A1, { state: "done", end: T0 + 5 * MIN }) } }), "newer", [A1]);
    expect(done.subs?.[A1]).toMatchObject({ state: "done", end: T0 + 5 * MIN });
  });

  it("adds the states of an older page and keeps the ones held", () => {
    const st = applyPage(null, page([bg("t2", T0 + 10, A2)], { subs: { [A2]: sub(A2) } }), "tail");
    const next = applyPage(st, page([bg("t1", T0, A1)], { start: null, subs: { [A1]: sub(A1, { state: "done" }) } }), "older");
    expect(Object.keys(next.subs ?? {}).sort()).toEqual([A1, A2].sort());
  });

  it("stops a subagent that was asked for and is not in the answer (its file is gone)", () => {
    const st = applyPage(null, page([bg("t1", T0, A1)], { subs: { [A1]: sub(A1, { last: T0 + 7 }) } }), "tail");
    const next = applyPage(st, page([], {}), "newer", [A1]);
    expect(next.subs?.[A1]).toMatchObject({ state: "stopped", end: T0 + 7 });
    // Not asked for: kept as it is.
    expect(applyPage(st, page([], {}), "newer").subs).toBe(st.subs);
  });

  it("drops the states with the session", () => {
    const st = applyPage(null, page([bg("t1", T0, A1)], { subs: { [A1]: sub(A1) } }), "tail");
    expect(applyPage(st, page([user("u9", T0)], { sessionId: "s2" }), "newer")).not.toHaveProperty("subs");
  });

  it("gives a launch step the subagent's id from a result that arrives in a later page", () => {
    const st = applyPage(null, page([launch("t1", T0)]), "tail");
    const next = applyPage(st, page([{ kind: "end", id: "t1", ts: T0 + 30, agent: A1, bg: true }], { subs: { [A1]: sub(A1) } }), "newer");
    expect(next.items[0]).toEqual({ ...launch("t1", T0), end: T0 + 30, agent: A1, bg: true });
    // A result in a newer page that waits for its step in an older one.
    const tail = applyPage(null, page([{ kind: "end", id: "t0", ts: T0 + 30, agent: A2, bg: true }, say("a1", T0 + 40)]), "tail");
    const older = applyPage(tail, page([launch("t0", T0)], { start: null }), "older");
    expect(older.items[0]).toMatchObject({ id: "t0", agent: A2, bg: true, end: T0 + 30 });
    // Another tool's step never gets a subagent.
    const other = applyPage(applyPage(null, page([step("b1", T0)]), "tail"), page([{ kind: "end", id: "b1", ts: T0 + 1, agent: A1 }]), "newer");
    expect(other.items[0]).not.toHaveProperty("agent");
  });
});

describe("subView", () => {
  it("shows a running background subagent from its state, not from the launch result", () => {
    const v = subView(bg("t1", T0, A1), sub(A1, { start: T0 + 100 }), "idle");
    expect(v).toEqual({
      title: `Review ${A1}`, id: A1, state: "running", since: T0 + 100, until: null,
      step: "Read the spec", steps: 3, more: false, agentType: "general-purpose",
    });
  });

  it("shows a finished one with its end", () => {
    const v = subView(bg("t1", T0, A1), sub(A1, { state: "done", end: T0 + 4 * MIN, steps: 12 }), "idle");
    expect(v).toMatchObject({ state: "done", since: T0, until: T0 + 4 * MIN, steps: 12 });
  });

  it("takes the title from the step when the state has none, without the suffix", () => {
    expect(subView(bg("t1", T0, A1), sub(A1, { description: "" }), "idle").title).toBe("Review t1");
    expect(subView(bg("t1", T0, A1), undefined, "idle").title).toBe("Review t1");
  });

  it("shows a background launch with no readable file as launched, with no time", () => {
    expect(subView(bg("t1", T0, A1), undefined, "running")).toMatchObject({ state: "launched", until: null, steps: null, id: A1 });
  });

  it("shows a foreground subagent from its step: running, done, failed, stopped", () => {
    expect(subView(launch("t1", T0), undefined, "running")).toMatchObject({ state: "running", id: null, until: null });
    expect(subView(launch("t1", T0), undefined, "idle")).toMatchObject({ state: "stopped" });
    expect(subView(launch("t1", T0, { end: T0 + 3 * MIN, agent: A1 }), undefined, "idle")).toMatchObject({ state: "done", until: T0 + 3 * MIN, id: A1 });
    expect(subView(launch("t1", T0, { end: T0 + 5, error: true }), undefined, "idle")).toMatchObject({ state: "failed" });
  });
});

describe("newerSub, newerSubs", () => {
  it("takes the state from the later write of the file", () => {
    const a = sub(A1, { last: T0 + 5, steps: 3 });
    const b = sub(A1, { last: T0 + 9, steps: 4 });
    expect(newerSub(a, b)).toBe(b);
    expect(newerSub(b, a)).toBe(b);
    expect(newerSub(undefined, a)).toBe(a);
    expect(newerSub(a, undefined)).toBe(a);
    expect(newerSub(undefined, undefined)).toBeUndefined();
  });

  it("with the same write, takes the one that says it ended", () => {
    const run = sub(A1, { last: T0 + 9 });
    const done = sub(A1, { last: T0 + 9, state: "done", end: T0 + 9 });
    expect(newerSub(run, done)).toBe(done);
    expect(newerSub(done, run)).toBe(done);
  });

  it("puts the newer states over the held ones, and keeps the object when none is newer", () => {
    const held = { [A1]: sub(A1, { last: T0 + 5 }), [A2]: sub(A2, { last: T0 + 5 }) };
    expect(newerSubs(held, {})).toBe(held);
    expect(newerSubs(held, { [A1]: sub(A1, { last: T0 + 1 }) })).toBe(held);
    const done = sub(A1, { last: T0 + 8, state: "done" });
    const next = newerSubs(held, { [A1]: done });
    expect(next).toEqual({ [A1]: done, [A2]: held[A2] });
    expect(newerSubs(undefined, { [A1]: done })).toEqual({ [A1]: done });
    expect(newerSubs(undefined, {})).toBeUndefined();
    // The live line follows: no subagent runs once the newer state says done.
    const items: Shown[] = [bg("t1", T0, A1)];
    expect(subsLive(items, { [A1]: sub(A1, { last: T0 + 5 }) })).not.toBeNull();
    expect(subsLive(items, newerSubs({ [A1]: sub(A1, { last: T0 + 5 }) }, { [A1]: done }))).toBeNull();
  });
});

describe("subsChip", () => {
  const items: Shown[] = [user("u1", T0), bg("t1", T0 + 1, A1), bg("t2", T0 + 2, A2)];
  const st = (subs: Record<string, SubagentState> | undefined) => ({ items, ...(subs ? { subs } : {}) });

  it("replaces 'your turn' while the agent is between turns and subagents work", () => {
    expect(subsChip("idle", st({ [A1]: sub(A1), [A2]: sub(A2) }))).toBe("2 subagents working");
    expect(subsChip("idle", st({ [A1]: sub(A1), [A2]: sub(A2, { state: "done" }) }))).toBe("subagent working");
  });

  it("is null when no subagent runs: the chip says 'your turn' again", () => {
    expect(subsChip("idle", st({ [A1]: sub(A1, { state: "done" }), [A2]: sub(A2, { state: "stopped" }) }))).toBeNull();
    expect(subsChip("idle", st(undefined))).toBeNull();
    expect(subsChip("idle", null)).toBeNull();
  });

  it("leaves every other status as it is", () => {
    const run = st({ [A1]: sub(A1) });
    for (const status of ["running", "done", "error", "", null]) expect(subsChip(status, run)).toBeNull();
  });
});

describe("subSteps", () => {
  it("counts the steps, and says when the count is partial", () => {
    expect(subSteps({ steps: 12, more: false })).toBe("12 steps");
    expect(subSteps({ steps: 1, more: false })).toBe("1 step");
    expect(subSteps({ steps: 0, more: false })).toBe("0 steps");
    expect(subSteps({ steps: 120, more: true })).toBe("120+ steps");
    expect(subSteps({ steps: null, more: false })).toBe("");
  });
});

describe("runningSubIds", () => {
  it("names the running subagents only, and a bounded number of them", () => {
    expect(runningSubIds(undefined)).toEqual([]);
    expect(runningSubIds({ [A1]: sub(A1), [A2]: sub(A2, { state: "done" }), x: sub("x", { state: "stopped" }) })).toEqual([A1]);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, n) => [`a${n}`, sub(`a${n}`)]));
    expect(runningSubIds(many)).toHaveLength(MAX_POLLED_SUBS);
  });
});

describe("subsLive", () => {
  const items: Shown[] = [user("u1", T0), bg("t1", T0 + 1 * MIN, A1), bg("t2", T0 + 2 * MIN, A2), say("a1", T0 + 3 * MIN)];

  it("says how many subagents work, with the one that runs longest", () => {
    expect(subsLive(items, { [A1]: sub(A1, { description: "Review the reminders feature" }), [A2]: sub(A2) }))
      .toEqual({ text: "2 subagents working · Review the reminders feature", since: T0 + 1 * MIN, count: 2 });
    expect(subsLive(items, { [A1]: sub(A1, { state: "done" }), [A2]: sub(A2, { description: "Build it" }) }))
      .toEqual({ text: "Subagent working · Build it", since: T0 + 2 * MIN, count: 1 });
  });

  it("is null when none runs, and for a thread with no subagents", () => {
    expect(subsLive(items, { [A1]: sub(A1, { state: "done" }), [A2]: sub(A2, { state: "stopped" }) })).toBeNull();
    expect(subsLive(items, undefined)).toBeNull();
    expect(subsLive([user("u1", T0)], { [A1]: sub(A1) })).toBeNull();
  });

  it("counts a subagent once when its step is held twice", () => {
    expect(subsLive([...items, bg("t9", T0 + 4 * MIN, A1)], { [A1]: sub(A1), [A2]: sub(A2, { state: "done" }) })?.text).toMatch(/^Subagent working/);
  });

  it("leaves the agent's own live line as it was: a background launch is not an open step", () => {
    expect(liveStep(items, "idle")).toBeNull();
    expect(liveStep([user("u1", T0), bg("t1", T0 + 1, A1)], "running")).toEqual({ label: null, since: T0 + 1 + 30 });
  });
});
