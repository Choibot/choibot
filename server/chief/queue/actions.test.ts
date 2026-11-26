import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerGate } from "../../agents/composer.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import type { Caller } from "../auth.js";
import { QueueActions } from "./actions.js";
import { get, harness, lines, ok, patch, raw, reset, ruleEvents } from "./actions.fixture.js";
import { Deliverer } from "./deliver.js";
import { closedMerged } from "./lines.js";
import type { MergeState } from "./prgate.js";
import type { NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-actions-"));
  clock = 7_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const W = "a1"; // the item's worker
const PR_URL = "https://github.com/o/app-shop/pull/12";
const base = { agentId: W, createdBy: { agentId: W, kind: "worker" as const }, repo: "app-shop", area: "app-shop", body: "b" };
const choice: NewItem = { ...base, kind: "choice", title: "Pick", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] } };
const question: NewItem = { ...base, kind: "question", title: "How?", blocking: true };
const pr: NewItem = { ...base, kind: "pr", title: "PR #12", blocking: false, pr: { url: PR_URL, number: 12 } };

const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };
const agent = (agentId: string): Caller => ({ level: "agent", agentHeaders: true, agentId, kind: "worker" });

// The shared harness (actions.fixture.ts) and QueueActions over it.
function setup(o: { deliverer?: Pick<Deliverer, "kick">; failDecision?: boolean; mergeState?: (item: QueueItem) => Promise<MergeState> } = {}) {
  const h = harness(root, () => clock, o);
  const actions = new QueueActions({
    store: h.store, rules: h.rules, decisions: h.decisions,
    agents: { load: async () => null },
    deliverer: o.deliverer ?? h.kicker,
    inbox: { cancel: () => "absent" }, audit: h.audit,
    undoMs: 600_000, now: () => clock, log: h.log,
    mergeState: o.mergeState ?? (async () => ({ state: "not-merged", detail: "open" })),
  });
  return { ...h, actions };
}
type F = ReturnType<typeof setup>;

// An active rule, as a USER add from the Brain panel makes it.
async function activeRule(f: F, text: string): Promise<string> {
  const { rule } = await f.rules.add({ text, state: "active", kind: "decision", scope: { area: "*" }, source: { origin: "panel" } });
  f.steps.length = 0;
  return rule.id;
}
async function recommended(f: F, input: NewItem, value: string, ruleIds: string[]): Promise<string> {
  const { id } = await f.store.add(input);
  await patch(f, id, (it) => ({ ...it, recommend: { value, why: "the brain says so", ruleIds, by: "fleet-master", at: clock } }));
  return id;
}

describe("answerUser: the commit", () => {
  it("commits answer, answerSeq, a pending delivery slot and status answered; one hub event; kick after the lock", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    f.changes.length = 0;
    clock += 1_000;
    const item = ok(await f.actions.answerUser(id, { value: "B" }, "tab"));
    const want = {
      status: "answered", answerSeq: 1,
      answer: { value: "B", by: "user", via: "tab", at: clock },
      delivery: { msgId: `${id}-1`, state: "pending", attempts: 0 },
    };
    expect(item).toMatchObject(want);
    expect(item.answer).toEqual(want.answer);
    expect(item.delivery).toEqual(want.delivery);
    expect(await get(f, id)).toEqual(item);
    expect(f.changes).toEqual([item]);
    expect(f.kicks).toEqual([id]);
    // The commit, then the decision line, all under the item lock; the kick after it.
    expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 }]);
  });

  it("keeps text when given; a snoozed item can be answered and loses snoozedUntil", async () => {
    const f = setup();
    const { id } = await f.store.add(question);
    await patch(f, id, (it) => ({ ...it, status: "snoozed", snoozedUntil: clock + 60_000 }));
    const item = ok(await f.actions.answerUser(id, { value: "reply", text: "Use the registry." }, "telegram"));
    expect(item.status).toBe("answered");
    expect(item.snoozedUntil).toBeUndefined();
    expect(item.answer).toEqual({ value: "reply", text: "Use the registry.", by: "user", via: "telegram", at: clock });
  });

  it("msgId from the item's counter (decision 50): answerSeq 3 → <id>-4", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const old = { value: "A", by: "user" as const, via: "tab" as const, at: 1 };
    await patch(f, id, (it) => ({ ...it, answerSeq: 3, history: [old, old, old] }));
    const item = ok(await f.actions.answerUser(id, { value: "A" }, "cli"));
    expect(item.answerSeq).toBe(4);
    expect(item.delivery).toEqual({ msgId: `${id}-4`, state: "pending", attempts: 0 });
  });

  it("keeps an existing withdrawal slot that is still pending (it goes out before the new answer)", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const undone = { value: "B", by: "user" as const, via: "tab" as const, at: clock };
    const w = { msgId: `${id}-w1`, state: "pending" as const, attempts: 0 };
    await patch(f, id, (it) => ({ ...it, answerSeq: 1, history: [undone], withdrawal: w }));
    const item = ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    expect(item.withdrawal).toEqual(w);
    expect(item.delivery).toEqual({ msgId: `${id}-2`, state: "pending", attempts: 0 });
    expect(await get(f, id)).toEqual(item);
  });

  it("404 for an unknown or malformed id; nothing kicked", async () => {
    const f = setup();
    expect(await f.actions.answerUser("q00000000", { value: "A" }, "tab")).toEqual({ code: 404, body: { error: "not found" } });
    expect((await f.actions.answerUser("../x", { value: "A" }, "tab")).code).toBe(404);
    expect(f.kicks).toEqual([]);
  });

  it("an item already answered → 409 with the current item, nothing written", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const first = ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    const before = raw(f, id);
    f.kicks.length = 0;
    expect(await f.actions.answerUser(id, { value: "B" }, "tab")).toEqual({ code: 409, body: { error: "already answered", item: first } });
    expect(raw(f, id)).toBe(before);
    expect(f.kicks).toEqual([]);
    expect(await lines(f)).toHaveLength(1);
  });

  it("a withdrawn or auto item → 409 already answered with the item", async () => {
    const f = setup();
    for (const status of ["withdrawn", "auto"] as const) {
      const { id } = await f.store.add(choice);
      await patch(f, id, (it) => ({ ...it, status }));
      const r = await f.actions.answerUser(id, { value: "A" }, "tab");
      expect(r).toEqual({ code: 409, body: { error: "already answered", item: await get(f, id) } });
    }
  });

  // Review Focus 3.
  it("an invalid value (option G, approve on a choice, changes without text) → 400 and the file unchanged", async () => {
    const f = setup();
    const c = (await f.store.add(choice)).id;
    const p = (await f.store.add(pr)).id;
    const q = (await f.store.add(question)).id;
    const before = { c: raw(f, c), p: raw(f, p), q: raw(f, q) };
    f.changes.length = 0;
    const cases: [string, unknown][] = [
      [c, { value: "G" }], [c, { value: "approve" }], [c, { value: "reply" }], [c, { value: "reply", text: "  " }],
      [p, { value: "changes" }], [p, { value: "changes", text: " \n " }], [p, { value: "B" }],
      [q, { value: "reply" }], [q, { value: "A" }], [c, { value: "A", auto: true }], [c, null], [c, "A"],
    ];
    for (const [id, body] of cases) {
      const r = await f.actions.answerUser(id, body, "tab");
      expect(r.code, JSON.stringify(body)).toBe(400);
      if (r.code !== 200) expect(typeof r.body.error).toBe("string");
    }
    expect({ c: raw(f, c), p: raw(f, p), q: raw(f, q) }).toEqual(before);
    expect(f.changes).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect(await lines(f)).toEqual([]);
    expect(await ruleEvents(f)).toEqual([]);
  });

  // Review Focus 5.
  it("two concurrent answers → one 200 and one 409 whose body has the committed item", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const rs = await Promise.all([
      f.actions.answerUser(id, { value: "A" }, "tab"),
      f.actions.answerUser(id, { value: "B" }, "tab"),
    ]);
    const won = rs.filter((r) => r.code === 200);
    const lost = rs.filter((r) => r.code === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const committed = await get(f, id);
    expect(ok(won[0]!)).toEqual(committed);
    expect(lost[0]).toEqual({ code: 409, body: { error: "already answered", item: committed } });
    expect(committed.answerSeq).toBe(1);
    expect(await lines(f)).toHaveLength(1);
    expect(f.kicks).toEqual([id]);
  });

  it("a failing decision-log write is logged; the commit stands, 200 and kick", async () => {
    const f = setup({ failDecision: true });
    const { id } = await f.store.add(choice);
    const item = ok(await f.actions.answerUser(id, { value: "reply", text: "Neither; ship the registry." }, "tab"));
    expect(item.status).toBe("answered");
    expect(await get(f, id)).toEqual(item);
    expect(f.kicks).toEqual([id]);
    expect(f.logs.join("\n")).toMatch(/decisions disk full/);
  });
});

describe("answerUser: the decision line (spec §5.4 step 7, §6.2 source 1)", () => {
  // A real Deliverer and ComposerGate: the paste path never logs a user line.
  function delivering() {
    const live = new Set<string>();
    const writes: string[] = [];
    const terminals = {
      has: (id: string) => live.has(id),
      hasSession: async (id: string) => live.has(id),
      reattach: async () => null,
      write: (_id: string, d: string) => { writes.push(d); },
      inputReady: (id: string) => live.has(id),
    };
    const gate = new ComposerGate({ terminals, agentExists: async () => true, sleep: async () => {} });
    const rec: AgentRecord = { id: W, label: W, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
      sessionId: null, hookToken: "t", status: "idle", createdAt: 1 };
    let deliverer!: Deliverer;
    const f = setup({ deliverer: { kick: (id) => deliverer.kick(id) } });
    deliverer = new Deliverer({
      store: f.store, agents: { load: async (id) => (id === W ? rec : null), exists: async (id) => id === W },
      composer: gate, inbox: { pushConsole: async () => {} }, rules: { hit: async () => {} }, hub: new EventHub(),
      now: () => clock, undoMs: 600_000, log: () => {},
    });
    return { f, deliverer, live, writes };
  }

  it("one line at commit even when the delivery then fails; the inputInternal paste adds no second line", async () => {
    const { f, deliverer, live, writes } = delivering();
    const { id } = await f.store.add(choice);
    ok(await f.actions.answerUser(id, { value: "B" }, "tab"));
    await deliverer.deliver(id);
    expect((await get(f, id)).delivery).toMatchObject({ state: "failed", lastError: "not-live" });
    const one = await lines(f);
    expect(one).toHaveLength(1);
    expect(one[0]).toEqual({
      at: one[0]!.at, via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "B", text: "", correction: false,
    });
    // The agent comes back; Resend → the paste goes through inputInternal.
    live.add(W);
    ok(await f.actions.deliveryAction(id, "resend"));
    await deliverer.deliver(id);
    expect((await get(f, id)).delivery).toMatchObject({ state: "delivered" });
    expect(writes.join("")).toContain(`[queue ${id}] choice: B (Registry-driven)`);
    expect(await lines(f)).toEqual(one);
  });

  it("choice B against recommend A with text → differs-from-recommend, a redacted line, no candidate, one strike per cited rule", async () => {
    const f = setup();
    const r1 = await activeRule(f, "Prefer hand-rolled lists.");
    const r2 = await activeRule(f, "Small diffs first.");
    const id = await recommended(f, choice, "A", [r1, r2]);
    const text = `Registry, not hand-rolled; token sk-abcdefghijklmnopqrstuv${" more words".repeat(30)}`;
    ok(await f.actions.answerUser(id, { value: "B", text }, "tab"));

    const [line] = await lines(f);
    expect(line).toMatchObject({
      via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop", value: "B",
      recommend: { value: "A", ruleIds: [r1, r2] }, correction: true, reason: "differs-from-recommend",
    });
    expect(line!.text).not.toContain("sk-abcdefghij");

    // A one-time answer is never a rule (pick A "Quiet rules"): the distiller reads the line.
    expect((await f.rules.all()).filter((r) => r.state === "candidate")).toEqual([]);
    expect((await f.rules.get(r1))).toMatchObject({ hits: 0, strikes: 1 });
    expect((await f.rules.get(r2))).toMatchObject({ hits: 0, strikes: 1 });
    // Lock chain: the commit, the strikes, the decision line under the item
    // lock, in this order; the kick after it.
    expect(f.steps).toEqual([
      { what: "write", held: 1 },
      { what: `strike ${r1}`, held: 1 }, { what: `strike ${r2}`, held: 1 },
      { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 },
    ]);
  });

  it("the same value as the recommendation → one hit per rule, correction false, no candidate (text or not)", async () => {
    const f = setup();
    const r1 = await activeRule(f, "Prefer the registry.");
    const id = await recommended(f, choice, "B", [r1]);
    ok(await f.actions.answerUser(id, { value: "B", text: "yes, as suggested" }, "tab"));
    const [line] = await lines(f);
    expect(line).toMatchObject({ value: "B", text: "yes, as suggested", correction: false, recommend: { value: "B", ruleIds: [r1] } });
    expect(line!.reason).toBeUndefined();
    expect(await f.rules.get(r1)).toMatchObject({ hits: 1, strikes: 0 });
    expect((await f.rules.all()).filter((r) => r.state === "candidate")).toEqual([]);
  });

  it("a question compares normalized text (decision 33): same words → hit, no candidate; other words → differs", async () => {
    const f = setup();
    const r1 = await activeRule(f, "Registry over hand-rolled.");
    const same = await recommended(f, question, "Use the registry.", [r1]);
    ok(await f.actions.answerUser(same, { value: "reply", text: "  use the   registry " }, "tab"));
    expect((await lines(f))[0]).toMatchObject({ itemId: same, value: "reply", correction: false });
    expect((await lines(f))[0]!.reason).toBeUndefined();
    expect(await f.rules.get(r1)).toMatchObject({ hits: 1, strikes: 0 });
    expect((await f.rules.all()).filter((r) => r.state === "candidate")).toEqual([]);

    const other = await recommended(f, question, "Use the registry.", [r1]);
    ok(await f.actions.answerUser(other, { value: "reply", text: "Hand-roll it this once." }, "telegram"));
    expect((await lines(f))[1]).toMatchObject({
      itemId: other, via: "queue-telegram", correction: true, reason: "differs-from-recommend",
      recommend: { value: "Use the registry.", ruleIds: [r1] },
    });
    expect(await f.rules.get(r1)).toMatchObject({ hits: 1, strikes: 1 });
    expect((await f.rules.all()).filter((r) => r.state === "candidate")).toEqual([]);
  });

  it("pr changes (the PR is open) → pr-changes, no candidate; approve (the PR is merged) → correction false", async () => {
    const f = setup({ mergeState: async (item) => (item.pr && "url" in item.pr && item.pr.number === 123 ? { state: "merged" } : { state: "not-merged", detail: "open" }) });
    const a = (await f.store.add(pr)).id;
    ok(await f.actions.answerUser(a, { value: "changes", text: "Split the migration out." }, "cli"));
    const b = (await f.store.add({ ...pr, pr: { url: `${PR_URL}3`, number: 123 } })).id;
    ok(await f.actions.answerUser(b, { value: "approve" }, "tab"));
    const [la, lb] = await lines(f);
    expect(la).toMatchObject({ itemId: a, via: "queue-tab", prUrl: PR_URL, value: "changes", text: "Split the migration out.",
      correction: true, reason: "pr-changes" });
    expect(la!.recommend).toBeUndefined();
    expect(lb).toMatchObject({ itemId: b, value: "approve", text: "", correction: false });
    expect(await f.rules.all()).toEqual([]);
  });

  it("choice reply → free-text, no candidate; a key press alone writes only the decision line", async () => {
    const f = setup();
    const a = (await f.store.add(choice)).id;
    ok(await f.actions.answerUser(a, { value: "reply", text: "Neither; ask the indexer team." }, "tab"));
    const b = (await f.store.add(choice)).id;
    ok(await f.actions.answerUser(b, { value: "A" }, "tab"));
    const [la, lb] = await lines(f);
    expect(la).toMatchObject({ value: "reply", correction: true, reason: "free-text" });
    expect(lb).toMatchObject({ value: "A", correction: false });
    expect(await f.rules.all()).toEqual([]);
  });

  it("a question without a recommendation is no correction", async () => {
    const f = setup();
    const { id } = await f.store.add(question);
    ok(await f.actions.answerUser(id, { value: "reply", text: "Use Postgres." }, "tab"));
    expect((await lines(f))[0]).toMatchObject({ correction: false });
    expect(await f.rules.all()).toEqual([]);
  });

  it("a correction whose text normalizes to nothing makes no candidate", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    ok(await f.actions.answerUser(id, { value: "reply", text: "..." }, "tab"));
    expect((await lines(f))[0]).toMatchObject({ correction: true, reason: "free-text", text: "..." });
    expect(await f.rules.all()).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it("the same correction twice writes two decision lines and no rule", async () => {
    const f = setup();
    for (let n = 0; n < 2; n++) {
      const { id } = await f.store.add(choice);
      ok(await f.actions.answerUser(id, { value: "reply", text: "Ask the indexer team." }, "tab"));
    }
    expect(await f.rules.all()).toEqual([]);
    expect(await lines(f)).toHaveLength(2);
  });

  it("hit/strike: at most one per rule per commit; an unknown or retired rule id gets none", async () => {
    const f = setup();
    const live = await activeRule(f, "Prefer the registry.");
    const gone = await activeRule(f, "Old rule.");
    await f.rules.retire(gone, { by: "user", why: "stale" });
    const id = await recommended(f, choice, "A", [live, live, gone, "r_zzzzz"]);
    const before = (await ruleEvents(f)).length;
    ok(await f.actions.answerUser(id, { value: "B" }, "tab"));
    const after = (await ruleEvents(f)).slice(before);
    expect(after.map((e) => [e.ev, e.id])).toEqual([["strike", live]]);
    expect(after[0]).toMatchObject({ itemId: id, at: clock });
  });
});

describe("snooze (Review Focus 4)", () => {
  it("0, -5, 1.5, 10081 and non-numbers → 400, the file unchanged", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const before = raw(f, id);
    for (const m of [0, -5, 1.5, 10081, Number.NaN, Number.POSITIVE_INFINITY, "60", null, undefined]) {
      const r = await f.actions.snooze(id, m);
      expect(r.code, String(m)).toBe(400);
    }
    expect(raw(f, id)).toBe(before);
  });

  it("60 → snoozed with snoozedUntil = now + 3_600_000; 1 and 10080 are accepted; a snoozed item can be re-snoozed", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    f.changes.length = 0;
    const item = ok(await f.actions.snooze(id, 60));
    expect(item).toMatchObject({ status: "snoozed", snoozedUntil: clock + 3_600_000 });
    expect(await get(f, id)).toEqual(item);
    expect(f.changes).toEqual([item]);
    expect(ok(await f.actions.snooze(id, 1)).snoozedUntil).toBe(clock + 60_000);
    expect(ok(await f.actions.snooze(id, 10080)).snoozedUntil).toBe(clock + 10080 * 60_000);
    expect(f.kicks).toEqual([]);
  });

  it("an answered item → 409 with the item before any 400 (minutes checked inside the lock); unknown id → 404 first", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    const before = raw(f, id);
    for (const m of [0, 1.5, 10081, "60", undefined]) {
      expect(await f.actions.snooze(id, m), String(m)).toEqual({ code: 409, body: { error: "already answered", item: await get(f, id) } });
    }
    expect(raw(f, id)).toBe(before);
    expect(await f.actions.snooze("q00000000", 0)).toEqual({ code: 404, body: { error: "not found" } });
  });

  it("an answered or auto item → 409 with the item, the file unchanged; unknown id → 404", async () => {
    const f = setup();
    const a = (await f.store.add(choice)).id;
    ok(await f.actions.answerUser(a, { value: "A" }, "tab"));
    const b = (await f.store.add(choice)).id;
    await patch(f, b, (it) => ({ ...it, status: "auto" }));
    for (const id of [a, b]) {
      const before = raw(f, id);
      expect(await f.actions.snooze(id, 60)).toEqual({ code: 409, body: { error: "already answered", item: await get(f, id) } });
      expect(raw(f, id)).toBe(before);
    }
    expect((await f.actions.snooze("q00000000", 60)).code).toBe(404);
  });
});

describe("withdraw", () => {
  it("by the item's own agent → withdrawn with closedAt; by the user too", async () => {
    const f = setup();
    const a = (await f.store.add(choice)).id;
    clock += 5_000;
    f.changes.length = 0;
    const item = ok(await f.actions.withdraw(a, agent(W)));
    expect(item).toMatchObject({ status: "withdrawn", closedAt: clock });
    expect(await get(f, a)).toEqual(item);
    expect(f.changes).toEqual([item]);
    const b = (await f.store.add(question)).id;
    await patch(f, b, (it) => ({ ...it, status: "snoozed", snoozedUntil: clock + 1 }));
    const wb = ok(await f.actions.withdraw(b, USER));
    expect(wb).toMatchObject({ status: "withdrawn", closedAt: clock });
    expect(wb.snoozedUntil).toBeUndefined();
  });

  it("another agent or an unauthenticated caller → 403, the file unchanged", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const before = raw(f, id);
    expect((await f.actions.withdraw(id, agent("a2"))).code).toBe(403);
    expect((await f.actions.withdraw(id, { level: "none", agentHeaders: true })).code).toBe(403);
    expect((await f.actions.withdraw(id, { level: "none", agentHeaders: false })).code).toBe(403);
    expect(raw(f, id)).toBe(before);
  });

  it("an answered or withdrawn item → 409 item is not open, with the item; unknown id → 404", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    const before = raw(f, id);
    expect(await f.actions.withdraw(id, agent(W))).toEqual({ code: 409, body: { error: "item is not open", item: await get(f, id) } });
    expect(await f.actions.withdraw(id, USER)).toEqual({ code: 409, body: { error: "item is not open", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    const w = (await f.store.add(choice)).id;
    ok(await f.actions.withdraw(w, USER));
    expect(await f.actions.withdraw(w, USER)).toEqual({ code: 409, body: { error: "item is not open", item: await get(f, w) } });
    expect((await f.actions.withdraw("q00000000", USER)).code).toBe(404);
  });
});

// Overview decision 60: the user merges; a pr item is never answered `approve`.
describe("answerUser: the merge gate of a pr item", () => {
  const local: NewItem = { ...base, kind: "pr", title: "Branch", blocking: false, pr: { local: { repo: "app-shop", branch: "agent/x", aheadAtAdd: true } } };
  const notMerged = async (): Promise<MergeState> => ({ state: "not-merged", detail: "open" });

  for (const via of ["tab", "telegram", "cli"] as const) {
    it(`approve via ${via} while the PR is not merged → 409 with the reason; nothing written, no kick, no decision line`, async () => {
      const f = setup({ mergeState: notMerged });
      const { id } = await f.store.add(pr);
      const before = raw(f, id);
      const r = await f.actions.answerUser(id, { value: "approve" }, via);
      expect(r).toEqual({ code: 409, body: {
        error: "PR #12 is not merged (open). Merge it first: this item then closes on its own.", reason: "pr-not-merged", item: await get(f, id),
      } });
      expect(raw(f, id)).toBe(before);
      expect(f.changes).toHaveLength(1); // the add only
      expect(f.kicks).toEqual([]);
      expect(await lines(f)).toEqual([]);
    });
  }

  it("approve on a local-branch item whose branch is not in its base → 409 naming the branch", async () => {
    const f = setup({ mergeState: async () => ({ state: "not-merged", detail: "not in main" }) });
    const { id } = await f.store.add(local);
    const r = await f.actions.answerUser(id, { value: "approve" }, "tab");
    expect(r.code).toBe(409);
    expect(r.code === 409 && r.body).toMatchObject({ reason: "pr-not-merged", error: "Branch agent/x is not merged (not in main). Merge it first: this item then closes on its own." });
    expect((await get(f, id)).status).toBe("open");
  });

  it("the state cannot be read → 409 pr-state-unknown (fail closed), nothing written", async () => {
    const f = setup({ mergeState: async () => ({ state: "unknown", why: "gh pr view timed out after 10000 ms" }) });
    const { id } = await f.store.add(pr);
    const before = raw(f, id);
    const r = await f.actions.answerUser(id, { value: "approve" }, "tab");
    expect(r).toMatchObject({ code: 409, body: { reason: "pr-state-unknown",
      error: "Could not read the state of PR #12 (gh pr view timed out after 10000 ms). Approve is refused. Try again." } });
    expect(raw(f, id)).toBe(before);
    expect(f.kicks).toEqual([]);
  });

  it("a mergeState that rejects is a state that cannot be read: refused", async () => {
    const f = setup({ mergeState: async () => { throw new Error("spawn gh ENOENT"); } });
    const { id } = await f.store.add(pr);
    const r = await f.actions.answerUser(id, { value: "approve" }, "tab");
    expect(r).toMatchObject({ code: 409, body: { reason: "pr-state-unknown" } });
    expect((await get(f, id)).status).toBe("open");
  });

  it("a snoozed pr item is gated the same way", async () => {
    const f = setup({ mergeState: notMerged });
    const { id } = await f.store.add(pr);
    ok(await f.actions.snooze(id, 60));
    const r = await f.actions.answerUser(id, { value: "approve" }, "tab");
    expect(r).toMatchObject({ code: 409, body: { reason: "pr-not-merged" } });
    expect((await get(f, id)).status).toBe("snoozed");
  });

  it("changes stays allowed while the PR is not merged: the gate is asked once, then the answer is committed as before", async () => {
    let asked = 0;
    const f = setup({ mergeState: async () => { asked++; return notMerged(); } });
    const { id } = await f.store.add(pr);
    const it = ok(await f.actions.answerUser(id, { value: "changes", text: "Split the migration out." }, "tab"));
    expect(it).toMatchObject({ status: "answered", answer: { value: "changes", text: "Split the migration out." }, delivery: { msgId: `${id}-1`, state: "pending" } });
    expect(asked).toBe(1);
    expect(f.kicks).toEqual([id]);
    expect(await lines(f)).toEqual([expect.objectContaining({ value: "changes", correction: true, reason: "pr-changes" })]);
  });

  for (const via of ["tab", "telegram"] as const) {
    it(`changes via ${via} on a merged PR ("done merge") closes the item as merged: no changes answer, no candidate rule, the merged notice pending`, async () => {
      const f = setup({ mergeState: async () => ({ state: "merged" }) });
      const { id } = await f.store.add(pr);
      reset(f);
      const it = ok(await f.actions.answerUser(id, { value: "changes", text: "done merge" }, via));
      expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: clock, delivery: { msgId: `${id}-m`, state: "pending", attempts: 0 } });
      expect(it.answer).toBeUndefined();
      expect(it.answerSeq).toBe(0);
      expect(f.kicks).toEqual([id]);
      // One write, one decision line (an approve, not a correction), no rule write.
      expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 }]);
      expect(await lines(f)).toEqual([expect.objectContaining({ by: "user", itemId: id, prUrl: PR_URL, value: "approve", text: "done merge", correction: false })]);
      expect((await lines(f))[0]).not.toHaveProperty("reason");
      expect(await ruleEvents(f)).toEqual([]);
    });
  }

  it("changes on a snoozed pr item whose PR is merged closes it and ends the snooze", async () => {
    const f = setup({ mergeState: async () => ({ state: "merged" }) });
    const { id } = await f.store.add(pr);
    ok(await f.actions.snooze(id, 60));
    const it = ok(await f.actions.answerUser(id, { value: "changes", text: "merged" }, "tab"));
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged" });
    expect(it.snoozedUntil).toBeUndefined();
  });

  it("changes on a local-branch item whose branch is in its base closes it as merged too", async () => {
    const f = setup({ mergeState: async () => ({ state: "merged" }) });
    const { id } = await f.store.add(local);
    expect(ok(await f.actions.answerUser(id, { value: "changes", text: "ok merged" }, "tab"))).toMatchObject({ status: "withdrawn", lastError: "merged" });
    expect((await lines(f))[0]).not.toHaveProperty("prUrl");
  });

  it("changes while the PR state cannot be read (unknown, or a read that rejects) goes on as a change request", async () => {
    for (const mergeState of [async (): Promise<MergeState> => ({ state: "unknown", why: "gh pr view timed out" }), async (): Promise<MergeState> => { throw new Error("spawn gh ENOENT"); }]) {
      const f = setup({ mergeState });
      const { id } = await f.store.add(pr);
      expect(ok(await f.actions.answerUser(id, { value: "changes", text: "done" }, "tab"))).toMatchObject({ status: "answered", answer: { value: "changes", text: "done" } });
    }
  });

  it("changes without text on a pr item is a 400 before any gh call; changes on a preview never asks the gate", async () => {
    let asked = 0;
    const f = setup({ mergeState: async () => { asked++; return { state: "merged" }; } });
    const { id } = await f.store.add(pr);
    const before = raw(f, id);
    expect((await f.actions.answerUser(id, { value: "changes" }, "tab")).code).toBe(400);
    expect(raw(f, id)).toBe(before);
    const pv = (await f.store.add({ ...base, kind: "preview", title: "Page", blocking: false, preview: { images: ["1.png"] } })).id;
    expect(ok(await f.actions.answerUser(pv, { value: "changes", text: "done" }, "tab"))).toMatchObject({ status: "answered", answer: { value: "changes" } });
    expect(asked).toBe(0);
  });

  it("the read for a changes answer runs outside the item lock; an item answered meanwhile is not closed", async () => {
    let f!: F;
    let id = "";
    let first = true;
    f = setup({ mergeState: async () => {
      if (!first) return notMerged();
      first = false;
      ok(await f.actions.answerUser(id, { value: "changes", text: "x" }, "tab")); // commits while the first read runs
      return { state: "merged" };
    } });
    id = (await f.store.add(pr)).id;
    const r = await f.actions.answerUser(id, { value: "changes", text: "done merge" }, "telegram");
    expect(r).toMatchObject({ code: 409, body: { error: "already answered" } });
    expect(await get(f, id)).toMatchObject({ status: "answered", answer: { value: "changes", text: "x" } });
  });

  it("no other kind asks the gate: a preview approve and a choice answer commit as before", async () => {
    let asked = 0;
    const f = setup({ mergeState: async () => { asked++; return notMerged(); } });
    const pv = (await f.store.add({ ...base, kind: "preview", title: "Page", blocking: false, preview: { images: ["1.png"] } })).id;
    expect(ok(await f.actions.answerUser(pv, { value: "approve" }, "tab")).status).toBe("answered");
    const c = (await f.store.add(choice)).id;
    expect(ok(await f.actions.answerUser(c, { value: "A" }, "tab")).status).toBe("answered");
    expect(asked).toBe(0);
  });

  it("approve once the PR is merged closes the item as PrWatch would: withdrawn, merged, the merged notice pending, one kick, one decision line", async () => {
    const f = setup({ mergeState: async () => ({ state: "merged" }) });
    const { id } = await f.store.add(pr);
    ok(await f.actions.snooze(id, 60));
    reset(f);
    const it = ok(await f.actions.answerUser(id, { value: "approve" }, "telegram"));
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: clock, delivery: { msgId: `${id}-m`, state: "pending", attempts: 0 } });
    expect(it.answer).toBeUndefined();
    expect(it.snoozedUntil).toBeUndefined();
    expect(it.answerSeq).toBe(0);
    expect(f.kicks).toEqual([id]);
    // The write and the decision line run under the item lock; the kick after it.
    expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 }]);
    expect(await lines(f)).toEqual([expect.objectContaining({ via: "queue-telegram", by: "user", itemId: id, prUrl: PR_URL, value: "approve", correction: false })]);
  });

  it("the gate's read runs outside the item lock", async () => {
    let heldAtRead = -1;
    const f = setup({ mergeState: async () => { heldAtRead = f.steps.filter((s) => s.held > 0).length; return { state: "merged" }; } });
    const { id } = await f.store.add(pr);
    reset(f);
    let locked = false;
    const probe = f.actions.answerUser(id, { value: "approve" }, "tab");
    // While the gate reads, the item lock is free: another action gets it at once.
    await f.store.withItem(id, async () => { locked = true; });
    ok(await probe);
    expect(locked).toBe(true);
    expect(heldAtRead).toBe(0);
  });

  it("an item answered while the gate read the PR state is not closed: 409 already answered", async () => {
    let f!: F;
    let id = "";
    let first = true;
    f = setup({ mergeState: async () => {
      if (!first) return notMerged(); // the read of the changes answer below
      first = false;
      ok(await f.actions.answerUser(id, { value: "changes", text: "x" }, "tab"));
      return { state: "merged" };
    } });
    id = (await f.store.add(pr)).id;
    const r = await f.actions.answerUser(id, { value: "approve" }, "telegram");
    expect(r).toMatchObject({ code: 409, body: { error: "already answered" } });
    expect(await get(f, id)).toMatchObject({ status: "answered", answer: { value: "changes" } });
  });

  it("an item PrWatch closed as merged while the gate read the state → 200 with that item; no second write, no second decision line", async () => {
    let f!: F;
    let id = "";
    f = setup({ mergeState: async () => {
      await patch(f, id, (it) => closedMerged(it, clock));
      return { state: "merged" };
    } });
    id = (await f.store.add(pr)).id;
    const it = ok(await f.actions.answerUser(id, { value: "approve" }, "tab"));
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", delivery: { msgId: `${id}-m`, state: "pending" } });
    expect(f.steps.filter((s) => s.what === "write")).toEqual([]);
    expect(await lines(f)).toEqual([]);
  });

  it("an answered or withdrawn pr item never asks the gate: 409 already answered", async () => {
    let asked = 0;
    const f = setup({ mergeState: async () => { asked++; return { state: "merged" }; } });
    const { id } = await f.store.add(pr);
    ok(await f.actions.withdraw(id, USER));
    expect(await f.actions.answerUser(id, { value: "approve" }, "tab")).toMatchObject({ code: 409, body: { error: "already answered" } });
    expect(asked).toBe(0);
  });

  it("approve with text is still gated (the text is not a way around)", async () => {
    const f = setup({ mergeState: notMerged });
    const { id } = await f.store.add(pr);
    expect(await f.actions.answerUser(id, { value: "approve", text: "ship it" }, "tab")).toMatchObject({ code: 409, body: { reason: "pr-not-merged" } });
    expect((await get(f, id)).status).toBe("open");
  });

  it("Resend and Mark delivered work on a stuck merged notice", async () => {
    const f = setup({ mergeState: async () => ({ state: "merged" }) });
    const { id } = await f.store.add(pr);
    ok(await f.actions.answerUser(id, { value: "approve" }, "tab"));
    await patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state: "unknown", lastError: "EIO" } }));
    const again = ok(await f.actions.deliveryAction(id, "resend"));
    expect(again.delivery).toEqual({ msgId: `${id}-m`, state: "pending", attempts: 0 });
    await patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state: "failed", lastError: "x" } }));
    expect(ok(await f.actions.deliveryAction(id, "mark-delivered")).delivery?.state).toBe("delivered");
  });
});

describe("deliveryAction", () => {
  async function answered(f: F, state: "delivered" | "failed" | "unknown" | "pending"): Promise<string> {
    const { id } = await f.store.add(choice);
    ok(await f.actions.answerUser(id, { value: "B" }, "tab"));
    await patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state, attempts: 1, at: clock, lastError: "not-live" } }));
    f.kicks.length = 0;
    return id;
  }

  it("resend on a delivered or pending slot → 409 with the item, the file unchanged", async () => {
    const f = setup();
    for (const state of ["delivered", "pending"] as const) {
      const id = await answered(f, state);
      const before = raw(f, id);
      const r = await f.actions.deliveryAction(id, "resend");
      expect(r).toEqual({ code: 409, body: { error: "only an unknown or failed slot", item: await get(f, id) } });
      expect(raw(f, id)).toBe(before);
    }
    expect(f.kicks).toEqual([]);
  });

  it("resend on failed → pending (lastError cleared, attempts and at kept) and kick; mark-delivered on unknown → delivered", async () => {
    const f = setup();
    const a = await answered(f, "failed");
    const ra = ok(await f.actions.deliveryAction(a, "resend", "answer"));
    expect(ra.delivery).toEqual({ msgId: `${a}-1`, state: "pending", attempts: 1, at: clock });
    expect(await get(f, a)).toEqual(ra);
    expect(f.changes).toEqual([ra]);
    expect(f.kicks).toEqual([a]);
    const b = await answered(f, "unknown");
    const rb = ok(await f.actions.deliveryAction(b, "mark-delivered"));
    expect(rb.delivery).toEqual({ msgId: `${b}-1`, state: "delivered", attempts: 1, at: clock });
    expect(f.changes).toEqual([rb]);
    // Every 200 kicks, mark-delivered too, after the item lock.
    expect(f.kicks).toEqual([b]);
    expect(f.steps.at(-1)).toEqual({ what: `kick ${b}`, held: 0 });
  });

  it("mark-delivered on the withdrawal slot kicks the item: the answer waiting behind it may go now", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const undone = { value: "B", by: "user" as const, via: "tab" as const, at: clock };
    await patch(f, id, (it) => ({ ...it, answerSeq: 1, history: [undone],
      withdrawal: { msgId: `${id}-w1`, state: "failed", attempts: 1, lastError: "not-live" } }));
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    f.kicks.length = 0;
    f.changes.length = 0;
    const item = ok(await f.actions.deliveryAction(id, "mark-delivered", "withdrawal"));
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "delivered", attempts: 1 });
    expect(item.delivery?.state).toBe("pending");
    expect(f.changes).toEqual([item]);
    expect(f.kicks).toEqual([id]);
  });

  it("the withdrawal slot: resend and mark-delivered on failed/unknown; absent → 409", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    const undone = { value: "B", by: "user" as const, via: "tab" as const, at: clock };
    await patch(f, id, (it) => ({ ...it, answerSeq: 1, history: [undone],
      withdrawal: { msgId: `${id}-w1`, state: "failed", attempts: 2, lastError: "not-live" } }));
    expect(ok(await f.actions.deliveryAction(id, "resend", "withdrawal")).withdrawal)
      .toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 2 });
    expect(f.kicks).toEqual([id]);
    await patch(f, id, (it) => ({ ...it, withdrawal: { ...it.withdrawal!, state: "unknown" } }));
    expect(ok(await f.actions.deliveryAction(id, "mark-delivered", "withdrawal")).withdrawal?.state).toBe("delivered");
    const other = (await f.store.add(choice)).id;
    expect((await f.actions.deliveryAction(other, "resend", "withdrawal")).code).toBe(409);
  });

  it("the answer slot after an undo → 409 (decision 32), also with a stale failed slot left behind", async () => {
    const f = setup();
    const id = await answered(f, "failed");
    // Undo (Task 2a-13): the answer to history, status open, delivery cleared.
    await patch(f, id, (it) => {
      const { answer, delivery: _cleared, ...rest } = it;
      return { ...rest, status: "open", history: [...it.history, answer!] };
    });
    expect((await f.actions.deliveryAction(id, "resend")).code).toBe(409);
    await patch(f, id, (it) => ({ ...it, delivery: { msgId: `${id}-1`, state: "failed", attempts: 1 } }));
    const before = raw(f, id);
    expect(await f.actions.deliveryAction(id, "resend")).toEqual({ code: 409, body: { error: "only an unknown or failed slot", item: await get(f, id) } });
    expect((await f.actions.deliveryAction(id, "mark-delivered")).code).toBe(409);
    expect(raw(f, id)).toBe(before);
    expect(f.kicks).toEqual([]);
  });

  it("a bad action or slot → 400; unknown id → 404", async () => {
    const f = setup();
    const id = await answered(f, "failed");
    const before = raw(f, id);
    expect((await f.actions.deliveryAction(id, "retry")).code).toBe(400);
    expect((await f.actions.deliveryAction(id, undefined)).code).toBe(400);
    expect((await f.actions.deliveryAction(id, "resend", "delivery")).code).toBe(400);
    expect((await f.actions.deliveryAction(id, "resend", null)).code).toBe(400);
    expect(raw(f, id)).toBe(before);
    expect((await f.actions.deliveryAction("q00000000", "resend")).code).toBe(404);
  });
});

// Final fix wave, minor 1: an item withdrawn because its agent is gone never sends a line again
// (decision 37): Resend and Mark delivered refuse its slots. A withdrawal slot of an item withdrawn
// otherwise (merged, closed, by its agent or the user) stays actionable (§5.6 "when in doubt withdraw").
describe("deliveryAction on a withdrawn item", () => {
  const undone = { value: "B", by: "user" as const, via: "tab" as const, at: 1 };
  it("agent-gone: both slots → 409 with the item, the file unchanged, no kick", async () => {
    const f = setup();
    const { id } = await f.store.add(choice);
    await patch(f, id, (it) => ({ ...it, status: "withdrawn", lastError: "agent-gone", closedAt: clock, answerSeq: 1, history: [undone],
      withdrawal: { msgId: `${id}-w1`, state: "failed", attempts: 1, lastError: "agent-gone" } }));
    f.kicks.length = 0;
    const before = raw(f, id);
    for (const action of ["resend", "mark-delivered"] as const) {
      expect(await f.actions.deliveryAction(id, action, "withdrawal")).toEqual({ code: 409, body: { error: "agent gone", item: await get(f, id) } });
    }
    expect(raw(f, id)).toBe(before);
    expect(f.kicks).toEqual([]);
  });
  it("merged or withdrawn by its agent: the withdrawal slot can still be resent", async () => {
    const f = setup();
    for (const lastError of ["merged", undefined]) {
      const { id } = await f.store.add(choice);
      await patch(f, id, (it) => ({ ...it, status: "withdrawn", ...(lastError ? { lastError } : {}), closedAt: clock, answerSeq: 1, history: [undone],
        withdrawal: { msgId: `${id}-w1`, state: "failed", attempts: 1, lastError: "not-live" } }));
      expect(ok(await f.actions.deliveryAction(id, "resend", "withdrawal")).withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 1 });
    }
  });
});
