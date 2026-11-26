// Task 2a-14: `recommend` (spec §5.3, §7; overview decision 39).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import { QueueActions } from "./actions.js";
import { get, harness, ok, raw } from "./actions.fixture.js";
import type { NewItem } from "./store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "chief-rec-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const MASTER: Caller = { level: "master", agentHeaders: true, agentId: FLEET_MASTER_ID, kind: "fleet-master" };
const WORKER: Caller = { level: "agent", agentHeaders: true, agentId: "a1", kind: "worker" };
const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };
const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: "worker" },
  repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] },
});
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});

// The shared harness (actions.fixture.ts) and QueueActions over it, with one active rule.
async function setup(recs: AgentRecord[] = [record("a1")]) {
  const h = harness(root, () => 7_000);
  const map = new Map(recs.map((r) => [r.id, r]));
  const actions = new QueueActions({
    store: h.store, rules: h.rules, decisions: h.decisions, agents: { load: async (id) => map.get(id) ?? null },
    deliverer: h.kicker, inbox: { cancel: () => "absent" }, audit: h.audit, undoMs: 1000, now: () => 7_000, log: h.log,
    mergeState: async () => ({ state: "not-merged", detail: "open" }),
  });
  const rule = await h.rules.add({ text: "prefer the registry", state: "active", kind: "correction",
    scope: { area: "app-shop", repo: "app-shop", kind: "choice", audience: "all" },
    source: { origin: "user-line", itemId: "qx", agentId: "a1", via: "queue-tab" } });
  return { ...h, actions, ruleId: rule.rule.id };
}

describe("QueueActions.recommend", () => {
  it("master recommend on a worker item is stored", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    const r = await f.actions.recommend(id, { value: "B", why: "fits", ruleIds: [f.ruleId] }, MASTER);
    expect(r.code).toBe(200);
    expect((await f.store.get(id))!.recommend).toEqual({ value: "B", why: "fits", ruleIds: [f.ruleId], by: FLEET_MASTER_ID, at: 7_000 });
  });

  it("a snoozed item can get a recommend; it stays snoozed", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    ok(await f.actions.snooze(id, 60));
    const item = ok(await f.actions.recommend(id, { value: "A", why: "fits", ruleIds: [f.ruleId] }, MASTER));
    expect(item).toMatchObject({ status: "snoozed", recommend: { value: "A", why: "fits", ruleIds: [f.ruleId], by: FLEET_MASTER_ID, at: 7_000 } });
    expect(await get(f, id)).toEqual(item);
  });

  it("an unknown rule id is 400 and nothing is stored", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    const r = await f.actions.recommend(id, { value: "B", why: "fits", ruleIds: ["r_zzzzz"] }, MASTER);
    expect(r).toEqual({ code: 400, body: { error: "unknown rule r_zzzzz" } });
    expect((await f.store.get(id))!.recommend).toBeUndefined();
  });

  it("one known and one unknown rule id → 400 naming the unknown one, nothing stored", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    const before = raw(f, id);
    f.changes.length = 0;
    const r = await f.actions.recommend(id, { value: "B", why: "fits", ruleIds: [f.ruleId, "r_zzzzz"] }, MASTER);
    expect(r).toEqual({ code: 400, body: { error: "unknown rule r_zzzzz" } });
    expect(raw(f, id)).toBe(before);
    expect(f.changes).toEqual([]);
  });

  it("a bad body is 400 and nothing is stored", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    const before = raw(f, id);
    f.changes.length = 0;
    expect((await f.actions.recommend(id, { value: "G", why: "x", ruleIds: [f.ruleId] }, MASTER)).code).toBe(400);
    expect(raw(f, id)).toBe(before);
    expect(f.changes).toEqual([]);
  });

  it("a worker caller is 403", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    expect((await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, WORKER)).code).toBe(403);
  });

  it.each(["fleet-master", "lead-x"])("an item of %s with no record is 409", async (agentId) => {
    const f = await setup([]);
    const { id } = await f.store.add(choice(agentId));
    const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER);
    expect(r.code).toBe(409);
    expect(r.code === 409 && r.body.error).toBe("the user answers this item");
    expect(r.code === 409 && (r.body.item as { id: string }).id).toBe(id);
    expect((await f.store.get(id))!.recommend).toBeUndefined();
  });

  it("a fleet-master record's item and a lead record's item are 409", async () => {
    const f = await setup([record(FLEET_MASTER_ID, { kind: "fleet-master" }), record("agent-9", { kind: "lead" as AgentRecord["kind"] })]);
    for (const agentId of [FLEET_MASTER_ID, "agent-9"]) {
      const { id } = await f.store.add(choice(agentId));
      expect((await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER)).code).toBe(409);
    }
  });

  it("an answered or withdrawn item is 409 item is not open, with the item; nothing stored", async () => {
    const f = await setup();
    const { id: a } = await f.store.add(choice("a1"));
    ok(await f.actions.answerUser(a, { value: "A" }, "tab"));
    const { id: w } = await f.store.add(choice("a1"));
    ok(await f.actions.withdraw(w, USER));
    for (const id of [a, w]) {
      const before = raw(f, id);
      f.changes.length = 0;
      const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER);
      expect(r).toEqual({ code: 409, body: { error: "item is not open", item: await get(f, id) } });
      expect(raw(f, id)).toBe(before);
      expect(f.changes).toEqual([]);
    }
  });

  // Decision 39 fails closed: a torn record (load → null, decision 37) or a
  // lead id without the `lead-` prefix must never get a recommend.
  it("no record for an item whose agentId has no persistent prefix → 409, nothing stored", async () => {
    const f = await setup([]);
    const { id } = await f.store.add(choice("agent-7"));
    const before = raw(f, id);
    f.changes.length = 0;
    const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER);
    expect(r).toEqual({ code: 409, body: { error: "the user answers this item", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    expect(f.changes).toEqual([]);
  });

  it.each(["lead", "fleet-master"] as const)("an item a %s created for itself → 409 even when the record says worker", async (kind) => {
    const f = await setup([record("agent-8")]);
    const { id } = await f.store.add({ ...choice("agent-8"), createdBy: { agentId: "agent-8", kind } });
    const before = raw(f, id);
    const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER);
    expect(r).toEqual({ code: 409, body: { error: "the user answers this item", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
  });

  it("an item the issue relay added for a worker can get a recommend", async () => {
    const f = await setup();
    const { id } = await f.store.add({ ...choice("a1"), createdBy: { agentId: "a1", kind: "relay" } });
    expect(ok(await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, MASTER)).recommend?.value).toBe("B");
  });
});

// Final fix wave, minor 6: the accepted value can never change under the user's cursor.
describe("QueueActions.recommend, a second time", () => {
  it("an item that already has a recommendation → 409 already recommended with the item; nothing stored", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("a1"));
    ok(await f.actions.recommend(id, { value: "B", why: "fits", ruleIds: [f.ruleId] }, MASTER));
    const before = raw(f, id);
    const r = await f.actions.recommend(id, { value: "A", why: "changed my mind", ruleIds: [f.ruleId] }, MASTER);
    expect(r).toEqual({ code: 409, body: { error: "already recommended", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    expect((await get(f, id)).recommend?.value).toBe("B");
  });
});

// Task 3-9 (spec §7 `recommend` by LEAD): a lead recommends only on an item
// whose agent's record has spawnedBy = the lead; the persistent-kind check
// (409, decision 39) still runs first, for every caller.
describe("QueueActions.recommend by a lead", () => {
  const LEAD: Caller = { level: "lead", agentHeaders: true, agentId: "lead-app-shop", kind: "lead" };
  const recs = () => [
    record("lead-app-shop", { kind: "lead", area: "app-shop" }),
    record("lead-indexer", { kind: "lead", area: "indexer" }),
    record(FLEET_MASTER_ID, { kind: "fleet-master" }),
    record("w-own", { spawnedBy: "lead-app-shop" }),
    record("w-other", { spawnedBy: "lead-indexer" }),
    record("w-master", { spawnedBy: FLEET_MASTER_ID }),
    record("w-user"),
  ];

  it("on its worker's item → 200, stored with by = the lead", async () => {
    const f = await setup(recs());
    const { id } = await f.store.add(choice("w-own"));
    const item = ok(await f.actions.recommend(id, { value: "B", why: "fits", ruleIds: [f.ruleId] }, LEAD));
    expect(item.recommend).toEqual({ value: "B", why: "fits", ruleIds: [f.ruleId], by: "lead-app-shop", at: 7_000 });
    expect(await get(f, id)).toEqual(item);
  });

  it.each([["another lead's worker", "w-other"], ["the master's worker", "w-master"], ["a user's worker", "w-user"]])(
    "on %s's item → 403, nothing stored", async (_n, agentId) => {
      const f = await setup(recs());
      const { id } = await f.store.add(choice(agentId));
      const before = raw(f, id);
      f.changes.length = 0;
      const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, LEAD);
      expect(r).toEqual({ code: 403, body: { error: "a lead recommends only on its own workers' items" } });
      expect(raw(f, id)).toBe(before);
      expect(f.changes).toEqual([]);
    });

  it("on its own item → 409 the user answers this item, nothing stored", async () => {
    const f = await setup(recs());
    const { id } = await f.store.add({ ...choice("lead-app-shop"), createdBy: { agentId: "lead-app-shop", kind: "lead" } });
    const before = raw(f, id);
    const r = await f.actions.recommend(id, { value: "B", why: "x", ruleIds: [f.ruleId] }, LEAD);
    expect(r).toEqual({ code: 409, body: { error: "the user answers this item", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
  });

  it("an unknown item → 404", async () => {
    const f = await setup(recs());
    expect((await f.actions.recommend("q99999999", { value: "B", why: "x", ruleIds: [f.ruleId] }, LEAD)).code).toBe(404);
  });

  it("the master still recommends on a lead's worker's item", async () => {
    const f = await setup(recs());
    const { id } = await f.store.add(choice("w-own"));
    expect(ok(await f.actions.recommend(id, { value: "A", why: "x", ruleIds: [f.ruleId] }, MASTER)).recommend?.by).toBe(FLEET_MASTER_ID);
  });
});
