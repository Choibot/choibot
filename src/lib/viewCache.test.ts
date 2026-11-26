import { describe, expect, it } from "vitest";
import { AGENT_MAX, Remembered, agentKey, agentMemory, applySet, forgetAgent, viewMemory } from "./viewCache";

describe("Remembered", () => {
  it("keeps at most `max` entries and drops the least recently used first", () => {
    const m = new Remembered<number>(3);
    m.set("a", 1); m.set("b", 2); m.set("c", 3);
    m.get("a"); // a read is a use: b is now the oldest
    m.set("d", 4);
    expect(m.size).toBe(3);
    expect(m.has("b")).toBe(false);
    expect([m.get("a"), m.get("c"), m.get("d")]).toEqual([1, 3, 4]);
  });

  it("replaces an entry with the newest answer and makes it the newest", () => {
    const m = new Remembered<string>(2);
    m.set("a", "old"); m.set("b", "x");
    m.set("a", "fresh");
    m.set("c", "y"); // b goes, not a
    expect(m.get("a")).toBe("fresh");
    expect(m.has("b")).toBe(false);
  });

  it("refuses a store that cannot hold an entry", () => {
    expect(() => new Remembered(0)).toThrow();
  });

  it("returns undefined for a key it never saw", () => {
    expect(viewMemory<number>(4).get("nope")).toBeUndefined();
  });
});

describe("agent stores", () => {
  it("are bounded to the last agents by default", () => {
    const m = agentMemory<number>();
    for (let i = 0; i < AGENT_MAX + 5; i++) m.set(`agent-${i}`, i);
    expect(m.size).toBe(AGENT_MAX);
    expect(m.has("agent-0")).toBe(false);
    expect(m.get(`agent-${AGENT_MAX + 4}`)).toBe(AGENT_MAX + 4);
  });

  it("drop a deleted agent's entries in every store, its parts too, and nothing else", () => {
    const threads = agentMemory<string>();
    const widgets = agentMemory<string>();
    const views = viewMemory<string>(4);
    threads.set("a1", "thread of a1");
    threads.set("a10", "thread of a10");
    widgets.set(agentKey("a1", "w1"), "widget of a1");
    widgets.set(agentKey("a10", "w1"), "widget of a10");
    views.set("a1", "a view key that only looks like an agent");
    forgetAgent("a1");
    expect(threads.has("a1")).toBe(false);
    expect(widgets.has(agentKey("a1", "w1"))).toBe(false);
    expect(threads.get("a10")).toBe("thread of a10");
    expect(widgets.get(agentKey("a10", "w1"))).toBe("widget of a10");
    expect(views.get("a1")).toBe("a view key that only looks like an agent");
  });
});

describe("applySet (the hook's setter)", () => {
  it("shows and remembers the refreshed value for the key on screen", () => {
    const m = viewMemory<number[]>(4);
    m.set("cockpit", [1]);
    const next = applySet(m, { key: "cockpit", value: [1] }, "cockpit", [1, 2]);
    expect(next).toEqual({ key: "cockpit", value: [1, 2] });
    expect(m.get("cockpit")).toEqual([1, 2]);
  });

  it("applies a change function to the shown value", () => {
    const m = viewMemory<number[]>(4);
    const next = applySet(m, { key: "a", value: [1, 2, 3] }, "a", (p) => p.filter((n) => n !== 2));
    expect(next.value).toEqual([1, 3]);
    expect(m.get("a")).toEqual([1, 3]);
  });

  it("keeps the same object when nothing changed (no re-render)", () => {
    const m = viewMemory<string>(4);
    const prev = { key: "a", value: "same" };
    expect(applySet(m, prev, "a", "same")).toBe(prev);
  });

  it("a late answer for the agent the user left goes to that agent's entry only", () => {
    const m = agentMemory<string>();
    m.set("left", "old thread");
    const shown = { key: "now", value: "thread of now" };
    expect(applySet(m, shown, "left", "late answer")).toBe(shown);
    expect(m.get("left")).toBe("late answer");
    expect(applySet(m, shown, "left", (p) => `${p}, changed`)).toBe(shown);
    expect(m.get("left")).toBe("late answer, changed");
  });

  it("a change function for a key with no entry and not on screen does nothing", () => {
    const m = agentMemory<string>();
    const shown = { key: "now", value: "x" };
    expect(applySet(m, shown, "gone", (p) => `${p}!`)).toBe(shown);
    expect(m.has("gone")).toBe(false);
  });
});
