import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import type { QueueResult } from "./queue";
import type { TabEvent, TabState } from "./queueState";
import type { UseQueue } from "./useQueue";
import { makeQueueRun, prCheckSource } from "./useQueueRun";

const NOW = 5_000_000;
const item = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q1", kind: "pr", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "PR #7", body: "", blocking: false, status: "open", answerSeq: 0, history: [], createdAt: NOW - 1000, updatedAt: NOW - 1000,
  pr: { url: "https://github.com/o/app-shop/pull/7", number: 7 }, ...o,
} as QueueItem);
const merged = (i: QueueItem): QueueItem => ({ ...i, status: "withdrawn", lastError: "merged", closedAt: NOW, updatedAt: NOW });
const refusal = (i: QueueItem): QueueResult => ({ ok: false, status: 409, item: i, error: "PR #7 is not merged (open). Merge it first: this item then closes on its own." });

function setup(results: QueueResult[]) {
  const events: TabEvent[] = [];
  const posts: { id: string; body: unknown }[] = [];
  const stamps: string[] = [];
  let refreshes = 0;
  let gate: Promise<void> = Promise.resolve();
  const live = { current: { dispatch: (e: TabEvent) => { events.push(e); }, now: () => NOW, refresh: () => { refreshes++; } } };
  const run = makeQueueRun(live, {
    answer: async (id, body) => { posts.push({ id, body }); await gate; return results.shift()!; },
    stamp: (id) => { stamps.push(id); },
  });
  return { run, events, posts, stamps, refreshes: () => refreshes, hold: () => { let open!: () => void; gate = new Promise((r) => { open = r; }); return open; } };
}

describe("checkPr: the press (\"I merged it\", the `a` key)", () => {
  it("merged: one POST approve, the closed item is applied, the 15 s gap starts", async () => {
    const i = item();
    const f = setup([{ ok: true, item: merged(i) }]);
    expect(await f.run.checkPr(i)).toBe(true);
    expect(f.posts).toEqual([{ id: "q1", body: { value: "approve" } }]);
    expect(f.events).toEqual([{ t: "confirmed", item: merged(i), now: NOW }]);
    expect(f.stamps).toEqual(["q1"]);
  });
  it("not merged: the server's reason becomes the ticket's error line; no optimistic change", async () => {
    const i = item();
    const f = setup([refusal(i)]);
    expect(await f.run.checkPr(i)).toBe(false);
    expect(f.events).toEqual([{ t: "failed", id: "q1", current: i, error: "PR #7 is not merged (open). Merge it first: this item then closes on its own.", now: NOW }]);
  });
  it("a second press while the first check runs makes no second POST", async () => {
    const i = item();
    const f = setup([refusal(i)]);
    const open = f.hold();
    const a = f.run.checkPr(i);
    expect(await f.run.checkPr(i)).toBe(false);
    open();
    await a;
    expect(f.posts).toHaveLength(1);
  });
});

describe("checkPr: the quiet check (nobody pressed)", () => {
  it("not merged: nothing is shown and nothing changes", async () => {
    const i = item({ id: "q2" });
    const f = setup([refusal(i)]);
    expect(await f.run.checkPr(i, { quiet: true })).toBe(false);
    expect(f.posts).toEqual([{ id: "q2", body: { value: "approve" } }]);
    expect(f.events).toEqual([]);
    expect(f.refreshes()).toBe(0);
    expect(f.stamps).toEqual([]); // lib/prAutoCheck counts its own checks
  });
  it("merged: the close is left to the server change (one refetch), never applied as the user's own action", async () => {
    const i = item({ id: "q3" });
    const f = setup([{ ok: true, item: merged(i) }]);
    expect(await f.run.checkPr(i, { quiet: true })).toBe(true);
    expect(f.events).toEqual([]);
    expect(f.refreshes()).toBe(1);
  });
  it("a press while a quiet check runs waits for it, then gives the reason (the press never fails in silence)", async () => {
    const i = item({ id: "q4" });
    const f = setup([refusal(i), refusal(i)]);
    const open = f.hold();
    const quiet = f.run.checkPr(i, { quiet: true });
    const press = f.run.checkPr(i);
    open();
    expect(await quiet).toBe(false);
    expect(await press).toBe(false);
    expect(f.posts).toHaveLength(2);
    expect(f.events.map((e) => e.t)).toEqual(["failed"]);
  });
  it("a press while a quiet check runs that finds the merge: no second POST", async () => {
    const i = item({ id: "q5" });
    const f = setup([{ ok: true, item: merged(i) }]);
    const open = f.hold();
    const quiet = f.run.checkPr(i, { quiet: true });
    const press = f.run.checkPr(i);
    open();
    expect(await quiet).toBe(true);
    expect(await press).toBe(true);
    expect(f.posts).toHaveLength(1);
  });
  it("a quiet check while any check of the ticket runs is dropped", async () => {
    const i = item({ id: "q6" });
    const f = setup([refusal(i)]);
    const open = f.hold();
    const press = f.run.checkPr(i);
    expect(await f.run.checkPr(i, { quiet: true })).toBe(false);
    open();
    await press;
    expect(f.posts).toHaveLength(1);
  });
});

describe("prCheckSource: what a view gives to the automatic check", () => {
  const state = (items: QueueItem[], o: Partial<TabState> = {}): TabState => ({ items, focusId: null, pending: {}, error: null, readOnly: false, arrived: {}, jumps: 0, ...o });
  const q = (s: TabState, view: UseQueue["view"] = "on"): { current: UseQueue } => ({
    current: { view, state: s, dispatch: () => {}, now: () => NOW, refresh: () => {}, seenJumps: { current: 0 } },
  });
  const api = () => { const calls: [string, unknown][] = []; return { calls, checkPr: async (i: QueueItem, o?: { quiet?: boolean }) => { calls.push([i.id, o]); return false; } }; };

  it("an open pr ticket: selected, and checked quietly", () => {
    const a = api();
    const src = prCheckSource(q(state([item()])), a, () => "q1");
    expect(src.selected?.()).toBe("q1");
    expect(src.check("q1")).toBe(true);
    expect(a.calls).toEqual([["q1", { quiet: true }]]);
  });
  it("not a pr ticket, a closed one, a snoozed one, an unknown id: not selected, not checked", () => {
    const a = api();
    const items = [
      item({ id: "c1", kind: "choice", pr: undefined }), item({ id: "w1", status: "withdrawn", lastError: "merged" }),
      item({ id: "s1", status: "snoozed", snoozedUntil: NOW + 60_000 }),
    ];
    for (const id of ["c1", "w1", "s1", "nope"]) {
      const src = prCheckSource(q(state(items)), a, () => id);
      expect(src.selected?.()).toBeNull();
      expect(src.check(id)).toBe(false);
    }
    expect(a.calls).toEqual([]);
  });
  it("a read-only device, or a queue that is off: no check (the POST would be refused)", () => {
    const a = api();
    expect(prCheckSource(q(state([item()], { readOnly: true })), a, () => "q1").check("q1")).toBe(false);
    expect(prCheckSource(q(state([item()])), a, () => "q1").selected?.()).toBe("q1");
    expect(prCheckSource(q(state([item()]), "off"), a).check("q1")).toBe(false);
    expect(a.calls).toEqual([]);
  });
  it("a view with no selected ticket (a thread) gives none, and still checks a ticket by id", () => {
    const a = api();
    const src = prCheckSource(q(state([item()])), a);
    expect(src.selected?.()).toBeNull();
    expect(src.check("q1")).toBe(true);
  });
});
