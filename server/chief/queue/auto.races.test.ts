// Task 2b-7: auto answer races, the undo of an auto answer, hits and strikes
// (spec §5.6 "Races and undo", §5.1, §6.1, §15; overview decisions 24, 32, 46).
// A real QueueStore, RuleStore, DecisionLog and AuditLog (actions.fixture.ts),
// AutoAnswer and QueueActions over them, and a real Deliverer whose worker
// paste is a fake that answers 200.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputResult } from "../../agents/composer.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import type { ConfirmVia } from "../brain/store.js";
import { QueueActions } from "./actions.js";
import { auditLines, get, harness, lines, ok, patch, raw, reset, ruleEvents, type Harness } from "./actions.fixture.js";
import { AUTO_HOLD_MS, AutoAnswer, type AuditEntry } from "./auto.js";
import { Deliverer } from "./deliver.js";
import { QueueStore, type NewItem } from "./store.js";
import type { Answer, Delivery, QueueItem } from "./types.js";

const NOW = 50_000_000;
const UNDO_MS = 600_000;
const W = "a1"; // a worker

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-races-"));
  clock = NOW;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };
const MASTER: Caller = { level: "master", agentHeaders: true, agentId: FLEET_MASTER_ID, kind: "fleet-master" };
const LEAD: Caller = { level: "lead", agentHeaders: true, agentId: "lead-1", kind: "lead" };
const WORKER: Caller = { level: "agent", agentHeaders: true, agentId: W, kind: "worker" };
const OK: InputResult = { code: 200, body: { delivered: true } };

const base = { agentId: W, createdBy: { agentId: W, kind: "worker" as const }, repo: "app-shop", area: "app-shop", body: "b", blocking: true };
const choice = (title = "Pick"): NewItem => ({ ...base, kind: "choice", title,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] } });
const question: NewItem = { ...base, kind: "question", title: "How?" };
const record = (id: string, kind?: string): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
});
const RECORDS = new Map([record(W), record(FLEET_MASTER_ID, "fleet-master")].map((r) => [r.id, r]));
const agents = { load: async (id: string) => RECORDS.get(id) ?? null, exists: async (id: string) => RECORDS.has(id) };

type Input = { agentId: string; msgId: string; text: string };

// A Deliverer over `store`; hits go to the harness's rule store.
function makeDeliverer(h: Harness, store: QueueStore, inputs: Input[]): Deliverer {
  return new Deliverer({
    store, agents, rules: h.rules, hub: new EventHub(), now: () => clock, undoMs: UNDO_MS, log: h.log,
    composer: { inputInternal: async (agentId, m) => { inputs.push({ agentId, ...m }); return OK; } },
    inbox: { pushConsole: () => new Promise<void>(() => {}) },
  });
}
function makeActions(h: Harness, store: QueueStore): QueueActions {
  return new QueueActions({
    store, rules: h.rules, decisions: h.decisions, agents, deliverer: h.kicker, inbox: { cancel: () => "absent" },
    audit: h.audit, undoMs: UNDO_MS, now: () => clock, log: h.log,
    mergeState: async () => ({ state: "not-merged", detail: "open" }),
  });
}

// An active rule whose latest confirm came from Telegram (eligible in weak mode).
async function addRule(h: Harness, text: string, via: ConfirmVia = "telegram"): Promise<string> {
  const { rule } = await h.rules.add({ text, state: "active", kind: "decision", source: { origin: "panel" },
    scope: { area: "app-shop", repo: "app-shop", audience: "all" } });
  await h.rules.confirm(rule.id, { via });
  return rule.id;
}

async function setup() {
  const h = harness(root, () => clock);
  const inputs: Input[] = [];
  const deliverer = makeDeliverer(h, h.store, inputs);
  const actions = makeActions(h, h.store);
  const auto = new AutoAnswer({
    store: h.store, rules: h.rules, agents, audit: h.audit, deliverer: h.kicker, mode: () => "weak", threshold: 0.85,
    undoMs: UNDO_MS, now: () => clock, log: h.log,
  });
  const r1 = await addRule(h, "prefer the registry");
  const r2 = await addRule(h, "keep tokens in the registry");
  reset(h);
  return { ...h, deliverer, actions, auto, inputs, r1, r2 };
}
type F = Awaited<ReturnType<typeof setup>>;

// An auto answer (default: B citing r1 and r2) on item `id`, or on a new choice.
async function autoAnswered(f: F, o: { id?: string; value?: string; text?: string; ruleIds?: string[] } = {}): Promise<{ id: string; auto: Answer }> {
  const id = o.id ?? (await f.store.add(choice())).id;
  const r = await f.auto.apply(id, { value: o.value ?? "B", ...(o.text !== undefined ? { text: o.text } : {}), auto: true,
    ruleIds: o.ruleIds ?? [f.r1, f.r2], confidence: 0.9 }, MASTER);
  expect(r.code === 200 && r.downgraded).toBeUndefined();
  const item = ok(r);
  expect(item.status).toBe("auto");
  reset(f);
  return { id, auto: item.answer! };
}

// The hit and strike lines, in file order, as "<ev> <ruleId>".
const counts = async (f: F): Promise<string[]> =>
  (await ruleEvents(f)).filter((e) => e.ev === "hit" || e.ev === "strike").map((e) => `${e.ev} ${e.id}`);
const audit = (id: string, a: Answer, event: AuditEntry["event"], at: number, delivered: boolean, kind: AuditEntry["kind"] = "choice"): AuditEntry =>
  ({ at, itemId: id, agentId: W, kind, value: a.value, ruleIds: a.ruleIds!, confidence: 0.9, undoUntil: a.at + UNDO_MS, event, delivered });
const setDelivery = (f: F, id: string, state: Delivery["state"], o: Partial<Delivery> = {}) =>
  patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state, ...o } }));
const recommend = (value: string, ruleIds: string[]): QueueItem["recommend"] => ({ value, why: "w", ruleIds, by: FLEET_MASTER_ID, at: 1 });

describe("a user answer on an auto item", () => {
  it("held, another value: the user wins — auto in history, audit superseded, one strike per cited rule, no hits, a correction line carrying the auto value (no recommend on the item)", async () => {
    const f = await setup();
    const { id, auto } = await autoAnswered(f);
    clock += 10_000;
    const item = ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    expect(item).toEqual(await get(f, id));
    expect(item).toMatchObject({ status: "answered", answerSeq: 2, history: [auto],
      answer: { value: "A", by: "user", via: "tab", at: clock }, delivery: { msgId: `${id}-2`, state: "pending", attempts: 0 } });
    expect(item.recommend).toBeUndefined();
    expect(await auditLines(f)).toEqual([audit(id, auto, "auto", NOW, false), audit(id, auto, "superseded", clock, false)]);
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect(await lines(f)).toEqual([{ at: clock, via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "A", text: "", recommend: { value: "B", ruleIds: [f.r1, f.r2] }, correction: true, reason: "differs-from-recommend" }]);
    // Under the item lock in this order; the kick after it.
    expect(f.steps).toEqual([
      { what: "write", held: 1 }, { what: "audit superseded", held: 1 }, { what: `strike ${f.r1}`, held: 1 },
      { what: `strike ${f.r2}`, held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 },
    ]);
    // The held auto line never goes out; the user's line does.
    clock = NOW + AUTO_HOLD_MS + 1;
    await f.deliverer.tick();
    await vi.waitFor(async () => expect((await get(f, id)).delivery?.state).toBe("delivered"));
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-2`, text: `[queue ${id}] choice: A (Hand-rolled)` }]);
  });

  it("one strike per rule per commit, also when the item's recommend cites the same rules; a rule the recommend would hit gets only the strike", async () => {
    const f = await setup();
    // The recommend says B (as the auto): the 2a path strikes its rules too.
    const same = (await f.store.add(choice())).id;
    await patch(f, same, (it) => ({ ...it, recommend: recommend("B", [f.r1, f.r2]) }));
    await autoAnswered(f, { id: same });
    ok(await f.actions.answerUser(same, { value: "A" }, "tab"));
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect((await lines(f)).at(-1)).toMatchObject({ value: "A", recommend: { value: "B", ruleIds: [f.r1, f.r2] },
      correction: true, reason: "differs-from-recommend" });
    // The recommend says A (the user follows it, a hit in 2a) and cites r1, which the auto cites too.
    // An auto B is refused on an item that shows A (decision 58), so the
    // recommend is written after the auto, as on an item from before it.
    const other = (await f.store.add(choice("Second"))).id;
    await autoAnswered(f, { id: other });
    await patch(f, other, (it) => ({ ...it, recommend: recommend("A", [f.r1]) }));
    ok(await f.actions.answerUser(other, { value: "A" }, "tab"));
    expect((await ruleEvents(f)).filter((e) => (e.ev === "hit" || e.ev === "strike") && e.itemId === other)
      .map((e) => `${e.ev} ${e.id}`)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect((await ruleEvents(f)).some((e) => e.ev === "hit")).toBe(false);
  });

  it("held, the same value: superseded, no strike and no hit; the decision line is the 2a one", async () => {
    const f = await setup();
    const { id, auto } = await autoAnswered(f);
    clock += 10_000;
    const item = ok(await f.actions.answerUser(id, { value: "B" }, "telegram"));
    expect(item).toMatchObject({ status: "answered", answerSeq: 2, history: [auto], answer: { value: "B", by: "user" } });
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto", "superseded"]);
    expect(await counts(f)).toEqual([]);
    expect(await lines(f)).toEqual([{ at: clock, via: "queue-telegram", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "B", text: "", correction: false }]);
  });

  it("a question compares texts (decision 33): the same text normalized → no strike; another text → strikes, no candidate, recommend = the auto text", async () => {
    const f = await setup();
    const mk = async () => {
      const { id } = await f.store.add(question);
      await patch(f, id, (it) => ({ ...it, recommend: recommend("Use the registry.", [f.r2]) }));
      await autoAnswered(f, { id, value: "reply", text: "Use the registry.", ruleIds: [f.r1] });
      return id;
    };
    const same = await mk();
    ok(await f.actions.answerUser(same, { value: "reply", text: "  use THE registry " }, "tab"));
    // Only the 2a hit of the item's own recommend.
    expect(await counts(f)).toEqual([`hit ${f.r2}`]);
    expect((await lines(f)).at(-1)).toMatchObject({ itemId: same, correction: false, recommend: { value: "Use the registry.", ruleIds: [f.r2] } });
    const other = await mk();
    ok(await f.actions.answerUser(other, { value: "reply", text: "Hand-roll it." }, "tab"));
    expect((await counts(f)).slice(1)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect((await lines(f)).at(-1)).toMatchObject({ itemId: other, value: "reply", text: "Hand-roll it.", correction: true,
      reason: "differs-from-recommend", recommend: { value: "Use the registry.", ruleIds: [f.r1] } });
    expect((await f.rules.all()).find((r) => r.text === "Hand-roll it.")).toBeUndefined();
    expect((await auditLines(f)).filter((e) => e.event === "superseded").map((e) => [e.itemId, e.kind, e.value]))
      .toEqual([[same, "question", "reply"], [other, "question", "reply"]]);
  });

  it.each(["pending", "delivering", "delivered", "failed", "unknown"] as const)("an auto whose line is %s (past held) → 409 undo first with the item, nothing written", async (state) => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    await setDelivery(f, id, state);
    const before = raw(f, id);
    expect(await f.actions.answerUser(id, { value: "A" }, "tab")).toEqual({ code: 409, body: { error: "undo first", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    expect(f.steps).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect(await lines(f)).toEqual([]);
    expect(await counts(f)).toEqual([]);
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto"]);
  });

  it("held, an invalid value → 400, nothing written", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    const before = raw(f, id);
    expect((await f.actions.answerUser(id, { value: "G" }, "tab")).code).toBe(400);
    expect(raw(f, id)).toBe(before);
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto"]);
  });

  it("two user answers on a held auto: the first commits, the second gets 409 already answered with the current item", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    const rs = await Promise.all([f.actions.answerUser(id, { value: "A" }, "tab"), f.actions.answerUser(id, { value: "B" }, "telegram")]);
    const now = await get(f, id);
    expect(rs[0]).toEqual({ code: 200, item: now });
    expect(rs[1]).toEqual({ code: 409, body: { error: "already answered", item: now } });
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto", "superseded"]);
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect(await lines(f)).toHaveLength(1);
  });

  it("an auto status with no master answer (a hand-edited file) → 409 already answered", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, status: "auto" }));
    expect(await f.actions.answerUser(id, { value: "A" }, "tab")).toEqual({ code: 409, body: { error: "already answered", item: await get(f, id) } });
  });
});

describe("undo of an auto answer", () => {
  it("USER undo of a held auto → silent cancel: open, auto in history, no delivery, recommend cleared; strikes, audit undone, decision line undo; never sent", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, recommend: recommend("B", [f.r1]) }));
    const { auto } = await autoAnswered(f, { id });
    clock += 30_000;
    const item = ok(await f.actions.undo(id, USER));
    expect(item).toEqual(await get(f, id));
    expect(item).toMatchObject({ status: "open", answerSeq: 1, history: [auto] });
    for (const k of ["answer", "delivery", "withdrawal", "recommend", "closedAt"] as const) expect(item[k], k).toBeUndefined();
    expect(await auditLines(f)).toEqual([audit(id, auto, "auto", NOW, false), audit(id, auto, "undone", clock, false)]);
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect(await lines(f)).toEqual([{ at: clock, via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "B", text: "", correction: true, reason: "undo" }]);
    expect(f.steps).toEqual([
      { what: "write", held: 1 }, { what: "audit undone", held: 1 }, { what: `strike ${f.r1}`, held: 1 },
      { what: `strike ${f.r2}`, held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 },
    ]);
    clock = NOW + AUTO_HOLD_MS + 10_000;
    await f.deliverer.tick();
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
  });

  it.each(["pending", "failed"] as const)("USER undo of a %s auto → silent cancel, audit not delivered", async (state) => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    await setDelivery(f, id, state, state === "failed" ? { lastError: "agent-closed" } : {});
    const item = ok(await f.actions.undo(id, USER));
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toBeUndefined();
    expect((await auditLines(f)).at(-1)).toMatchObject({ event: "undone", delivered: false });
  });

  it.each(["delivered", "unknown"] as const)("undo of a %s auto → a withdrawal, audit undone delivered: true; the withdrawal goes out", async (state) => {
    const f = await setup();
    const { id, auto } = await autoAnswered(f);
    await setDelivery(f, id, state);
    clock += 120_000;
    const item = ok(await f.actions.undo(id, USER));
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    expect((await auditLines(f)).at(-1)).toEqual(audit(id, auto, "undone", clock, true));
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-w1`, text: `[queue ${id}] the earlier answer (B) is withdrawn; wait for the user` }]);
  });

  it("a Telegram [Undo] names the auto's seq: the decision line is via queue-telegram; a stale seq → 409 stale undo, nothing written", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    const before = raw(f, id);
    expect(await f.actions.undo(id, USER, { expectSeq: 2, via: "telegram" })).toEqual({ code: 409, body: { error: "stale undo", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    ok(await f.actions.undo(id, USER, { expectSeq: 1, via: "telegram" }));
    expect(await lines(f)).toEqual([expect.objectContaining({ via: "queue-telegram", correction: true, reason: "undo" })]);
  });

  it("MASTER undo of its own auto → 200: strikes and audit undone, no decision line (decision 24)", async () => {
    const f = await setup();
    const { id, auto } = await autoAnswered(f);
    clock += 30_000;
    const item = ok(await f.actions.undo(id, MASTER));
    expect(item).toMatchObject({ status: "open", history: [auto] });
    expect(item.answer).toBeUndefined();
    expect(item.delivery).toBeUndefined();
    expect(await auditLines(f)).toEqual([audit(id, auto, "auto", NOW, false), audit(id, auto, "undone", clock, false)]);
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r2}`]);
    expect(await lines(f)).toEqual([]);
    expect(f.steps).toEqual([
      { what: "write", held: 1 }, { what: "audit undone", held: 1 }, { what: `strike ${f.r1}`, held: 1 },
      { what: `strike ${f.r2}`, held: 1 }, { what: `kick ${id}`, held: 0 },
    ]);
  });

  it("MASTER undo of a user answer → 403, nothing written; of an open item → 409 nothing to undo; a lead or a worker → 403", async () => {
    const f = await setup();
    const { id: user } = await f.store.add(choice());
    ok(await f.actions.answerUser(user, { value: "A" }, "tab"));
    const before = raw(f, user);
    reset(f);
    const r = await f.actions.undo(user, MASTER);
    expect(r.code).toBe(403);
    expect(raw(f, user)).toBe(before);
    const { id: open } = await f.store.add(choice("Open"));
    expect(await f.actions.undo(open, MASTER)).toEqual({ code: 409, body: { error: "nothing to undo", item: await get(f, open) } });
    const { id } = await autoAnswered(f);
    const auto = raw(f, id);
    for (const c of [LEAD, WORKER]) expect((await f.actions.undo(id, c)).code, c.level).toBe(403);
    expect(raw(f, id)).toBe(auto);
    expect(f.steps).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto"]);
  });

  it("the window: undoMs after the auto → 200 (USER and MASTER); undoMs + 1 → 409 undo window passed, nothing written", async () => {
    const f = await setup();
    const [a, b, c] = [(await autoAnswered(f)).id, (await autoAnswered(f)).id, (await autoAnswered(f)).id];
    clock = NOW + UNDO_MS;
    ok(await f.actions.undo(a, USER));
    ok(await f.actions.undo(b, MASTER));
    clock = NOW + UNDO_MS + 1;
    const before = raw(f, c);
    for (const caller of [USER, MASTER]) {
      expect(await f.actions.undo(c, caller)).toEqual({ code: 409, body: { error: "undo window passed", item: await get(f, c) } });
    }
    expect(raw(f, c)).toBe(before);
  });

  it("after an undo, a second --auto is downgraded (check 8)", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    ok(await f.actions.undo(id, USER));
    const r = await f.auto.apply(id, { value: "B", auto: true, ruleIds: [f.r1], confidence: 0.95 }, MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the item was auto-answered before" });
    expect(await get(f, id)).toMatchObject({ status: "open", recommend: { value: "B", why: "auto refused: the item was auto-answered before" } });
    expect((await auditLines(f)).map((e) => e.event)).toEqual(["auto", "undone"]);
  });
});

describe("a held auto and a restart", () => {
  // A restart: a new store and Deliverer over the same directory, and its boot scan.
  async function restart(f: F) {
    const store = new QueueStore(join(root, "queue"), { now: () => clock, log: () => {} });
    const inputs: Input[] = [];
    const deliverer = makeDeliverer(f, store, inputs);
    await deliverer.bootScan([]);
    return { store, inputs, deliverer, actions: makeActions(f, store) };
  }

  it("is still held after the restart and is sent at deliverAfter", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f, { ruleIds: [f.r1] });
    const r = await restart(f);
    expect((await r.store.get(id))!.delivery).toEqual({ msgId: `${id}-1`, state: "held", deliverAfter: NOW + AUTO_HOLD_MS, attempts: 0 });
    clock = NOW + AUTO_HOLD_MS - 1;
    await r.deliverer.tick();
    expect((await r.store.get(id))!.delivery?.state).toBe("held");
    expect(r.inputs).toEqual([]);
    clock = NOW + AUTO_HOLD_MS;
    await r.deliverer.tick();
    await vi.waitFor(async () => expect((await r.store.get(id))!.delivery?.state).toBe("delivered"));
    expect(r.inputs).toEqual([{ agentId: W, msgId: `${id}-1`, text: `[queue ${id}] auto (rule ${f.r1}): choice: B (Registry-driven)` }]);
  });

  it("a user undo after the restart cancels it: never sent", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    const r = await restart(f);
    clock = NOW + 30_000;
    expect(ok(await r.actions.undo(id, USER))).toMatchObject({ status: "open" });
    clock = NOW + AUTO_HOLD_MS + 10_000;
    await r.deliverer.tick();
    await r.deliverer.deliver(id);
    expect(r.inputs).toEqual([]);
    expect((await r.store.get(id))!.delivery).toBeUndefined();
  });
});

describe("the scanner: hits and closedAt", () => {
  // The auto line is delivered at +60 s.
  async function delivered(f: F): Promise<string> {
    const { id } = await autoAnswered(f);
    clock = NOW + AUTO_HOLD_MS;
    await f.deliverer.tick();
    await vi.waitFor(async () => expect((await get(f, id)).delivery?.state).toBe("delivered"));
    reset(f);
    return id;
  }

  it("a delivered auto past its window → one hit per cited rule and closedAt, once; the hits follow the item write", async () => {
    const f = await setup();
    const id = await delivered(f);
    clock = NOW + UNDO_MS - 1;
    await f.deliverer.tick();
    expect((await get(f, id)).closedAt).toBeUndefined();
    expect(await counts(f)).toEqual([]);
    clock = NOW + UNDO_MS;
    reset(f);
    await f.deliverer.tick();
    expect(await get(f, id)).toMatchObject({ status: "auto", closedAt: NOW + UNDO_MS });
    expect(await counts(f)).toEqual([`hit ${f.r1}`, `hit ${f.r2}`]);
    expect((await ruleEvents(f)).filter((e) => e.ev === "hit")).toEqual([
      { ev: "hit", id: f.r1, at: NOW + UNDO_MS, itemId: id }, { ev: "hit", id: f.r2, at: NOW + UNDO_MS, itemId: id }]);
    expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: `hit ${f.r1}`, held: 1 }, { what: `hit ${f.r2}`, held: 1 }]);
    for (const step of [5_000, 3_600_000]) {
      clock += step;
      await f.deliverer.tick();
    }
    expect(await counts(f)).toEqual([`hit ${f.r1}`, `hit ${f.r2}`]);
    expect((await get(f, id)).closedAt).toBe(NOW + UNDO_MS);
    // Closed: the undo is refused.
    expect(await f.actions.undo(id, USER)).toMatchObject({ code: 409, body: { error: "undo window passed" } });
    expect(await lines(f)).toEqual([]);
  });

  it("an item write that fails writes no hit; the next tick writes them once", async () => {
    const f = await setup();
    const id = await delivered(f);
    clock = NOW + UNDO_MS;
    const write = f.store.write;
    let fail = true;
    f.store.write = async (item) => {
      if (fail) { fail = false; throw new Error("disk full"); }
      await write(item);
    };
    await f.deliverer.tick();
    expect(f.logs.some((l) => l.includes(id) && l.includes("disk full"))).toBe(true);
    expect((await get(f, id)).closedAt).toBeUndefined();
    expect(await counts(f)).toEqual([]);
    await f.deliverer.tick();
    expect((await get(f, id)).closedAt).toBe(NOW + UNDO_MS);
    expect(await counts(f)).toEqual([`hit ${f.r1}`, `hit ${f.r2}`]);
  });

  it("a hit that throws is logged and never retried; the item stays closed", async () => {
    const f = await setup();
    const id = await delivered(f);
    clock = NOW + UNDO_MS;
    const hit = f.rules.hit;
    f.rules.hit = async (ruleId, itemId) => {
      if (ruleId === f.r1) throw new Error("rules disk full");
      await hit(ruleId, itemId);
    };
    await f.deliverer.tick();
    expect(f.logs.some((l) => l.includes(id) && l.includes(f.r1) && l.includes("rules disk full"))).toBe(true);
    expect(await counts(f)).toEqual([`hit ${f.r2}`]);
    f.rules.hit = hit;
    clock += 5_000;
    await f.deliverer.tick();
    expect(await counts(f)).toEqual([`hit ${f.r2}`]);
    expect((await get(f, id)).closedAt).toBe(NOW + UNDO_MS);
  });

  it("an auto that is not delivered (failed agent-closed) never closes and writes no hit, however old", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    await setDelivery(f, id, "failed", { lastError: "agent-closed" });
    clock = NOW + 10 * UNDO_MS;
    await f.deliverer.tick();
    expect((await get(f, id)).closedAt).toBeUndefined();
    expect(await counts(f)).toEqual([]);
  });

  it("a user answer that superseded a held auto closes without a hit", async () => {
    const f = await setup();
    const { id } = await autoAnswered(f);
    ok(await f.actions.answerUser(id, { value: "B" }, "tab"));
    await f.deliverer.deliver(id);
    clock = NOW + UNDO_MS;
    await f.deliverer.tick();
    expect(await get(f, id)).toMatchObject({ status: "answered", closedAt: NOW + UNDO_MS });
    expect(await counts(f)).toEqual([]);
  });
});

describe("strikes and eligibility (with Task 2b-5)", () => {
  it("two strikes make the rule recommend-only; a re-confirm on Telegram makes it eligible again", async () => {
    const f = await setup();
    const body = { value: "B", auto: true, ruleIds: [f.r1], confidence: 0.95 };
    const first = (await autoAnswered(f, { ruleIds: [f.r1] })).id;
    ok(await f.actions.undo(first, USER));
    const second = (await autoAnswered(f, { ruleIds: [f.r1] })).id;
    ok(await f.actions.answerUser(second, { value: "A" }, "tab"));
    expect(await counts(f)).toEqual([`strike ${f.r1}`, `strike ${f.r1}`]);
    const { id: third } = await f.store.add(choice("Third"));
    expect(await f.auto.apply(third, body, MASTER)).toMatchObject({ code: 200, downgraded: `rule ${f.r1} has 2 strikes since its latest confirm` });
    expect((await get(f, third)).status).toBe("open");
    await f.rules.confirm(f.r1, { via: "telegram" });
    expect(await f.auto.apply(third, body, MASTER)).toMatchObject({ code: 200, item: { status: "auto" } });
  });
});

describe("a user answer drops telegram.awaiting in its own write; an auto answer keeps it", () => {
  it.each(["tab", "telegram"] as const)("a %s user answer", async (via) => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, telegram: { cardMessageId: 5, awaiting: "other" } }));
    const item = ok(await f.actions.answerUser(id, { value: "A" }, via));
    expect(item.telegram).toEqual({ cardMessageId: 5 });
    expect(f.changes).toHaveLength(1);
  });

  it("an auto answer keeps it (spec §5.6: the awaited reply still beats a held auto), and the user's answer after it drops it", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, telegram: { cardMessageId: 5, awaiting: "other" } }));
    await f.auto.apply(id, { value: "B", auto: true, ruleIds: [f.r1], confidence: 0.95 }, MASTER);
    expect((await get(f, id))).toMatchObject({ status: "auto", telegram: { cardMessageId: 5, awaiting: "other" } });
    expect(f.changes).toHaveLength(1);
    const item = ok(await f.actions.answerUser(id, { value: "reply", text: "neither" }, "telegram"));
    expect(item).toMatchObject({ status: "answered", history: [expect.objectContaining({ by: "master" })] });
    expect(item.telegram).toEqual({ cardMessageId: 5 });
  });

  it("an item with no telegram field gets none (CHIEF_ENABLED off writes the same bytes)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    expect("telegram" in ok(await f.actions.answerUser(id, { value: "A" }, "tab"))).toBe(false);
  });
});
