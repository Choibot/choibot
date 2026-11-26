import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import { tabReducer, type TabState } from "./queueState";

const NOW = 10_000_000_000;
const MIN = 60_000;
function item(p: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "x",
    title: "t", body: "", createdAt: NOW - 5 * MIN, updatedAt: NOW - 5 * MIN, status: "open", blocking: true,
    history: [], answerSeq: 0, ...p,
  };
}
// kind order by score: question 40 > pr 35 > choice 30, so q1 < q2 < q3 in the Open list
const q1 = item({ id: "q1", kind: "question" });
const q2 = item({ id: "q2", kind: "pr" });
const q3 = item({ id: "q3", kind: "choice" });
const base = (p: Partial<TabState> = {}): TabState => ({
  items: [q1, q2, q3], focusId: "q1", pending: {}, error: null, readOnly: false, arrived: {}, jumps: 0, ...p,
});
const answered = (i: QueueItem): QueueItem => ({
  ...i, status: "answered", answer: { value: "A", by: "user", via: "tab", at: NOW },
});

describe("tabReducer", () => {
  it("optimistic marks answered and moves focus to the next Open row", () => {
    const s = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(s.items.find((i) => i.id === "q1")?.status).toBe("answered");
    expect(s.pending).toEqual({ q1 });
    expect(s.focusId).toBe("q2");
  });
  it("optimistic on the last row moves focus to the previous Open row; none left -> null", () => {
    const s = tabReducer(base({ focusId: "q3" }), { t: "optimistic", id: "q3", next: answered(q3), now: NOW });
    expect(s.focusId).toBe("q2");
    const one = tabReducer(base({ items: [q1] }), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(one.focusId).toBeNull();
  });
  it("readOnly blocks optimistic", () => {
    const s = base({ readOnly: true });
    expect(tabReducer(s, { t: "optimistic", id: "q1", next: answered(q1), now: NOW })).toEqual(s);
  });
  it("failed without current restores the saved item and records the error", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const s = tabReducer(o, { t: "failed", id: "q1", error: "boom", now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(q1);
    expect(s.pending).toEqual({});
    expect(s.error).toBe("boom");
  });
  it("failed with a 409 current upserts it and clears pending", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const cur = { ...answered(q1), answerSeq: 1 };
    const s = tabReducer(o, { t: "failed", id: "q1", current: cur, error: "conflict", now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(cur);
    expect(s.pending).toEqual({});
  });
  it("a failure on one item leaves its neighbour's pending change alone", () => {
    let s = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    s = tabReducer(s, { t: "optimistic", id: "q2", next: answered(q2), now: NOW });
    s = tabReducer(s, { t: "failed", id: "q1", error: "x", now: NOW });
    expect(s.pending).toEqual({ q2 });
    expect(s.items.find((i) => i.id === "q2")?.status).toBe("answered");
    expect(s.items.find((i) => i.id === "q1")?.status).toBe("open");
  });
  it("sse for a pending item replaces it and clears pending", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const server = { ...answered(q1), updatedAt: NOW };
    const s = tabReducer(o, { t: "sse", seq: 1, item: server, now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(server);
    expect(s.pending).toEqual({});
  });
  it("sse adds an unknown item; confirmed replaces and clears pending", () => {
    const n = item({ id: "q4" });
    expect(tabReducer(base(), { t: "sse", seq: 1, item: n, now: NOW }).items).toHaveLength(4);
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const s = tabReducer(o, { t: "confirmed", item: answered(q1), now: NOW });
    expect(s.pending).toEqual({});
  });
  it("move does not wrap at either end", () => {
    expect(tabReducer(base({ focusId: "q1" }), { t: "move", by: -1, now: NOW }).focusId).toBe("q1");
    expect(tabReducer(base({ focusId: "q3" }), { t: "move", by: 1, now: NOW }).focusId).toBe("q3");
    expect(tabReducer(base({ focusId: "q1" }), { t: "move", by: 1, now: NOW }).focusId).toBe("q2");
  });
  it("move from no focus selects the first row", () => {
    expect(tabReducer(base({ focusId: null }), { t: "move", by: 1, now: NOW }).focusId).toBe("q1");
  });
  it("loaded, focus and pairState", () => {
    const s = tabReducer(base({ focusId: "q9" }), { t: "loaded", items: [q1, q2], since: 0, now: NOW });
    expect(s.items).toHaveLength(2);
    expect(s.focusId).toBeNull();
    expect(tabReducer(base(), { t: "focus", id: "q2" }).focusId).toBe("q2");
    expect(tabReducer(base(), { t: "pairState", readOnly: true }).readOnly).toBe(true);
  });

  it("sse that closes the focused item moves focus to the next Open row", () => {
    const s = tabReducer(base({ focusId: "q2" }), { t: "sse", seq: 1, item: answered(q2), now: NOW });
    expect(s.focusId).toBe("q3");
  });
  it("confirmed that closes the focused last item moves focus to the previous row", () => {
    const s = tabReducer(base({ focusId: "q3" }), { t: "confirmed", item: answered(q3), now: NOW });
    expect(s.focusId).toBe("q2");
  });
  it("sse for another item leaves focus alone", () => {
    expect(tabReducer(base({ focusId: "q1" }), { t: "sse", seq: 1, item: answered(q3), now: NOW }).focusId).toBe("q1");
  });
  it("sse with the pre-change status keeps the optimistic item and refreshes the saved copy", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const fresh = { ...q1, title: "newer", updatedAt: NOW };
    const s = tabReducer(o, { t: "sse", seq: 1, item: fresh, now: NOW });
    expect(s.items.find((i) => i.id === "q1")?.status).toBe("answered");
    expect(s.pending).toEqual({ q1: fresh });
  });
  it("confirmed does not replace a newer item", () => {
    const newer = { ...answered(q1), updatedAt: NOW, answerSeq: 2 };
    const s = tabReducer(base({ items: [newer, q2, q3] }), { t: "confirmed", item: { ...answered(q1), updatedAt: NOW - 1 }, now: NOW });
    expect(s.items[0]).toEqual(newer);
  });
  it("confirmed with a different (newer) item replaces it", () => {
    const n = { ...answered(q1), updatedAt: NOW, answerSeq: 3 };
    expect(tabReducer(base(), { t: "confirmed", item: n, now: NOW }).items.find((i) => i.id === "q1")).toEqual(n);
  });
  it("a second optimistic on one id keeps the original saved copy", () => {
    let s = tabReducer(base(), { t: "optimistic", id: "q1", next: { ...q1, status: "snoozed" }, now: NOW });
    s = tabReducer(s, { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(s.pending.q1).toEqual(q1);
  });
  it("an sse for a non-pending item leaves another item's optimistic change", () => {
    let s = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    s = tabReducer(s, { t: "sse", seq: 1, item: { ...q3, title: "x" }, now: NOW });
    expect(s.items.find((i) => i.id === "q1")?.status).toBe("answered");
    expect(s.pending).toEqual({ q1 });
  });
  it("move skips non-Open rows between Open rows", () => {
    const s = base({ items: [q1, answered(q2), q3], focusId: "q1" });
    expect(tabReducer(s, { t: "move", by: 1, now: NOW }).focusId).toBe("q3");
  });
  it("optimistic keeps another item's error; same id or dismiss clears it", () => {
    const failed = tabReducer(base(), { t: "failed", id: "q2", error: "boom", now: NOW });
    const o = tabReducer(failed, { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(o.error).toBe("boom");
    expect(tabReducer(failed, { t: "optimistic", id: "q2", next: answered(q2), now: NOW }).error).toBeNull();
    expect(tabReducer(failed, { t: "dismissError" }).error).toBeNull();
    expect(tabReducer(failed, { t: "confirmed", item: answered(q2), now: NOW }).error).toBeNull();
  });
  it("rollback focuses the restored item when focus is null", () => {
    const o = tabReducer(base({ items: [q1], focusId: "q1" }), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(o.focusId).toBeNull();
    expect(tabReducer(o, { t: "failed", id: "q1", error: "x", now: NOW }).focusId).toBe("q1");
  });
  it("failed with a 409 current that is not Open does not take focus when focus is null", () => {
    const o = tabReducer(base({ items: [q1, q2], focusId: "q2" }), { t: "optimistic", id: "q2", next: answered(q2), now: NOW });
    const o2 = tabReducer({ ...o, focusId: null }, { t: "focus", id: null });
    const s = tabReducer(o2, { t: "failed", id: "q2", current: answered(q2), error: "conflict", now: NOW });
    expect(s.focusId).toBeNull();
  });
  it("does not mutate a frozen input state", () => {
    const frozen = Object.freeze({ ...base(), items: Object.freeze([q1, q2, q3]) as unknown as QueueItem[], pending: Object.freeze({}) as Record<string, QueueItem> });
    expect(() => {
      let s = tabReducer(frozen, { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
      s = tabReducer(s, { t: "sse", seq: 1, item: answered(q2), now: NOW });
      tabReducer(s, { t: "failed", id: "q1", error: "x", now: NOW });
    }).not.toThrow();
  });
  it("failed: a restored item snoozed past snoozedUntil is in Open and takes focus; one still snoozed does not", () => {
    const sn = (until: number) => item({ id: "q5", status: "snoozed", snoozedUntil: until });
    const s0 = base({ items: [q1], focusId: null });
    expect(tabReducer(s0, { t: "failed", id: "q5", current: sn(NOW - MIN), error: "x", now: NOW }).focusId).toBe("q5");
    expect(tabReducer(s0, { t: "failed", id: "q5", current: sn(NOW + MIN), error: "x", now: NOW }).focusId).toBeNull();
  });
  it("loaded keeps the newer item per id: a stale snapshot cannot reopen an answered item", () => {
    const newer = { ...answered(q1), updatedAt: NOW };
    const s = tabReducer(base({ items: [newer, q2, q3] }), { t: "loaded", items: [q1, q2, q3], since: 0, now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(newer);
    const fresher = { ...q2, title: "new", updatedAt: NOW };
    expect(tabReducer(base(), { t: "loaded", items: [q1, fresher], since: 0, now: NOW }).items.find((i) => i.id === "q2")).toEqual(fresher);
  });
  it("F4: a snapshot taken before the answer landed keeps the optimistic copy and the saved original", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const snap = { ...q1, title: "newer", updatedAt: NOW }; // still open on the server, newer than the original
    const s = tabReducer(o, { t: "loaded", items: [snap, q2, q3], since: 0, now: NOW });
    expect(s.items.find((i) => i.id === "q1")?.status).toBe("answered");
    expect(s.pending).toEqual({ q1: snap }); // refreshed with the server copy (as `sse`)
    expect(s.focusId).toBe("q2");
    // a later 400 / network failure still has the original to restore
    const f = tabReducer(s, { t: "failed", id: "q1", error: "HTTP 400", now: NOW });
    expect(f.items.find((i) => i.id === "q1")).toEqual(snap);
  });
  it("F4: the saved original stays when the snapshot copy is older", () => {
    const fresh = { ...q1, title: "fresh", updatedAt: NOW };
    const o = tabReducer(base({ items: [fresh, q2, q3] }), { t: "optimistic", id: "q1", next: answered(fresh), now: NOW });
    expect(tabReducer(o, { t: "loaded", items: [q1, q2, q3], since: 0, now: NOW }).pending).toEqual({ q1: fresh });
  });
  it("F4: a snapshot after the answer landed (status changed) follows the newer-updatedAt rule and drops pending", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const landed = { ...answered(q1), answer: { value: "B", by: "user" as const, via: "tab" as const, at: NOW }, updatedAt: NOW };
    const s = tabReducer(o, { t: "loaded", items: [landed, q2], since: 0, now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(landed);
    expect(s.pending).toEqual({});
  });
  it("F4: a pending item missing from the snapshot is dropped with its saved copy; others keep theirs", () => {
    let o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    o = tabReducer(o, { t: "optimistic", id: "q2", next: answered(q2), now: NOW });
    const s = tabReducer(o, { t: "loaded", items: [q2, q3], since: 0, now: NOW });
    expect(s.items.map((i) => i.id)).toEqual(["q2", "q3"]);
    expect(s.items[0].status).toBe("answered");
    expect(s.pending).toEqual({ q2 });
  });
});

// Final fix wave I1: a focus move the user did not cause (the focused row left Open by a server
// change: another device, a withdraw, PrWatch, agent-gone, a refetch) counts in `jumps`; the view
// starts its key hold on each new jump. A local action never counts one.
describe("tabReducer jumps (I1)", () => {
  const withdrawn = (i: QueueItem): QueueItem => ({ ...i, status: "withdrawn", closedAt: NOW });
  it("sse that closes the focused item: focus to the next row and one jump", () => {
    const s = tabReducer(base({ focusId: "q2" }), { t: "sse", seq: 1, item: answered(q2), now: NOW });
    expect(s.focusId).toBe("q3");
    expect(s.jumps).toBe(1);
    const w = tabReducer(s, { t: "sse", seq: 2, item: withdrawn(q3), now: NOW });
    expect(w.focusId).toBe("q1");
    expect(w.jumps).toBe(2);
  });
  it("sse snoozing the focused item elsewhere is a jump; the last Open row leaving is a jump to none", () => {
    const sn = tabReducer(base(), { t: "sse", seq: 1, item: { ...q1, status: "snoozed", snoozedUntil: NOW + MIN }, now: NOW });
    expect([sn.focusId, sn.jumps]).toEqual(["q2", 1]);
    const last = tabReducer(base({ items: [q1] }), { t: "sse", seq: 1, item: withdrawn(q1), now: NOW });
    expect([last.focusId, last.jumps]).toEqual([null, 1]);
  });
  it("sse for another item, or one that keeps the focused item Open, is no jump", () => {
    expect(tabReducer(base(), { t: "sse", seq: 1, item: answered(q3), now: NOW }).jumps).toBe(0);
    expect(tabReducer(base(), { t: "sse", seq: 1, item: { ...q1, title: "new", updatedAt: NOW }, now: NOW }).jumps).toBe(0);
  });
  it("a refetch whose snapshot closes the focused item: focus to the next row (not the first) and one jump", () => {
    const s = tabReducer(base({ focusId: "q2" }), { t: "loaded", items: [q1, answered(q2), q3], since: 0, now: NOW });
    expect([s.focusId, s.jumps]).toEqual(["q3", 1]);
    const gone = tabReducer(base({ focusId: "q2" }), { t: "loaded", items: [q1, q3], since: 0, now: NOW });
    expect([gone.focusId, gone.jumps]).toEqual(["q3", 1]);
    const same = tabReducer(base({ focusId: "q2" }), { t: "loaded", items: [q1, q2, q3], since: 0, now: NOW });
    expect([same.focusId, same.jumps]).toEqual(["q2", 0]);
  });
  it("local actions never count a jump: optimistic, its confirmed and its sse, failed, move, focus", () => {
    let s = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    expect(s.focusId).toBe("q2");
    s = tabReducer(s, { t: "sse", seq: 1, item: { ...answered(q1), updatedAt: NOW }, now: NOW });
    s = tabReducer(s, { t: "confirmed", item: { ...answered(q1), updatedAt: NOW }, now: NOW });
    s = tabReducer(s, { t: "move", by: 1, now: NOW });
    s = tabReducer(s, { t: "focus", id: "q2" });
    s = tabReducer(s, { t: "optimistic", id: "q2", next: answered(q2), now: NOW });
    s = tabReducer(s, { t: "failed", id: "q2", error: "x", now: NOW });
    expect(s.jumps).toBe(0);
    expect(tabReducer(base({ focusId: "q3" }), { t: "confirmed", item: answered(q3), now: NOW }).jumps).toBe(0);
  });
});

// Final fix wave I2: an item the stream delivered after a fetch started may be missing from that
// fetch's snapshot (the server listed before it existed): `loaded` keeps it.
describe("tabReducer loaded and late stream items (I2)", () => {
  const q4 = item({ id: "q4", kind: "question" });
  it("an item that arrived after the fetch started is kept when the snapshot lacks it", () => {
    const s = tabReducer(base(), { t: "sse", seq: 5, item: q4, now: NOW });
    const l = tabReducer(s, { t: "loaded", items: [q1, q2, q3], since: 4, now: NOW });
    expect(l.items.map((i) => i.id).sort()).toEqual(["q1", "q2", "q3", "q4"]);
  });
  it("an item that arrived before the fetch started and is not in the snapshot is dropped", () => {
    const s = tabReducer(base(), { t: "sse", seq: 5, item: q4, now: NOW });
    expect(tabReducer(s, { t: "loaded", items: [q1, q2, q3], since: 5, now: NOW }).items.map((i) => i.id)).toEqual(["q1", "q2", "q3"]);
  });
  it("an older response that lands after a newer one still keeps it", () => {
    let s = tabReducer(base(), { t: "sse", seq: 5, item: q4, now: NOW });
    s = tabReducer(s, { t: "loaded", items: [q1, q2, q3, q4], since: 6, now: NOW });
    s = tabReducer(s, { t: "loaded", items: [q1, q2, q3], since: 4, now: NOW });
    expect(s.items.some((i) => i.id === "q4")).toBe(true);
  });
  it("a kept item keeps its change in flight", () => {
    let s = tabReducer(base(), { t: "sse", seq: 5, item: q4, now: NOW });
    s = tabReducer(s, { t: "optimistic", id: "q4", next: answered(q4), now: NOW });
    s = tabReducer(s, { t: "loaded", items: [q1, q2, q3], since: 4, now: NOW });
    expect(s.items.find((i) => i.id === "q4")?.status).toBe("answered");
    expect(s.pending).toEqual({ q4 });
  });
});

// Final fix wave, minor 5: `failed` with a 409 `current` follows the updatedAt rule of `confirmed`.
describe("tabReducer failed with a stale 409 body", () => {
  it("a 409 body older than the copy the stream already delivered never replaces it", () => {
    let s = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const streamed = { ...answered(q1), answerSeq: 2, updatedAt: NOW };
    s = tabReducer(s, { t: "sse", seq: 1, item: streamed, now: NOW });
    s = tabReducer(s, { t: "failed", id: "q1", current: { ...answered(q1), answerSeq: 1, updatedAt: NOW - 1 }, error: "conflict", now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(streamed);
    expect(s.error).toBe("conflict");
  });
  it("with the change still in flight, a saved copy newer than the 409 body is what comes back", () => {
    const a = { ...answered(q1), delivery: { msgId: "q1-1", state: "failed" as const, attempts: 1 } };
    let s = tabReducer(base({ items: [a, q2, q3] }), { t: "optimistic", id: "q1", next: { ...a, delivery: { ...a.delivery, state: "pending" } }, now: NOW });
    const fresh = { ...a, title: "fresh", updatedAt: NOW };
    s = tabReducer(s, { t: "sse", seq: 1, item: fresh, now: NOW }); // same status: refreshes the saved copy
    s = tabReducer(s, { t: "failed", id: "q1", current: { ...a, updatedAt: NOW - 1 }, error: "conflict", now: NOW });
    expect(s.items.find((i) => i.id === "q1")).toEqual(fresh);
  });
  it("a 409 body newer than what the tab holds still replaces it", () => {
    const o = tabReducer(base(), { t: "optimistic", id: "q1", next: answered(q1), now: NOW });
    const cur = { ...answered(q1), answerSeq: 1, updatedAt: NOW };
    expect(tabReducer(o, { t: "failed", id: "q1", current: cur, error: "conflict", now: NOW }).items.find((i) => i.id === "q1")).toEqual(cur);
  });
});

// The Inbox layout: the list shows the tickets that block an agent first (lib/queueInbox
// openOrder). Focus follows the list, not the bare score order.
describe("tabReducer focus order follows the list (blocking first)", () => {
  // Score order: old (70) > b1 (55) > b2 (45) > pr (35). List order: b1, b2, old, pr.
  const old = item({ id: "old", kind: "question", blocking: false, createdAt: NOW - 6 * 60 * MIN });
  const b1 = item({ id: "b1", kind: "choice" });
  const b2 = item({ id: "b2", kind: "preview", preview: { images: [] } });
  const pr = item({ id: "pr", kind: "pr", blocking: false, pr: { url: "https://github.com/o/r/pull/1", number: 1 } });
  const mixed = (focusId: string | null): TabState => base({ items: [old, pr, b2, b1], focusId });

  it("move walks the list order", () => {
    let s = mixed("b1");
    const seen = [s.focusId];
    for (let n = 0; n < 4; n++) { s = tabReducer(s, { t: "move", by: 1, now: NOW }); seen.push(s.focusId); }
    expect(seen).toEqual(["b1", "b2", "old", "pr", "pr"]);
    expect(tabReducer(mixed("old"), { t: "move", by: -1, now: NOW }).focusId).toBe("b2");
  });
  it("move with no focus lands on the first row of the list", () => {
    expect(tabReducer(mixed(null), { t: "move", by: 1, now: NOW }).focusId).toBe("b1");
  });
  it("after an answer the focus goes to the next row of the list", () => {
    expect(tabReducer(mixed("b1"), { t: "optimistic", id: "b1", next: answered(b1), now: NOW }).focusId).toBe("b2");
    expect(tabReducer(mixed("b2"), { t: "optimistic", id: "b2", next: answered(b2), now: NOW }).focusId).toBe("old");
    expect(tabReducer(mixed("pr"), { t: "optimistic", id: "pr", next: answered(pr), now: NOW }).focusId).toBe("old");
  });
  it("a server change that closes the focused row moves focus in the list order too", () => {
    const s = tabReducer(mixed("b1"), { t: "sse", seq: 1, item: { ...answered(b1), updatedAt: NOW }, now: NOW });
    expect(s.focusId).toBe("b2");
    expect(s.jumps).toBe(1);
  });
});
