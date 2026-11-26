// Task 2a-13: undo of the user's own answer (spec §5.6 "Races and undo", §5.1, §15).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputResult } from "../../agents/composer.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import { InputTracker } from "../../master/draft.js";
import { InboxError, MasterInbox } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import { QueueActions } from "./actions.js";
import { deferred, get, harness, lines, ok, patch as patchItem, raw, reset, ruleEvents, settledState } from "./actions.fixture.js";
import { Deliverer } from "./deliver.js";
import type { NewItem } from "./store.js";
import type { Delivery, QueueItem } from "./types.js";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-undo-"));
  clock = 9_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const W = "a1"; // a worker
const UNDO_MS = 600_000;
const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: agentId === FLEET_MASTER_ID ? "fleet-master" : "worker" },
  repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] },
});
const PR_URL = "https://github.com/o/app-shop/pull/12";
const base = { agentId: W, createdBy: { agentId: W, kind: "worker" as const }, repo: "app-shop", area: "app-shop", body: "b" };
const pr: NewItem = { ...base, kind: "pr", title: "PR #12", blocking: false, pr: { url: PR_URL, number: 12 } };
const question: NewItem = { ...base, kind: "question", title: "How?", blocking: true };
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});
const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };
const OK: InputResult = { code: 200, body: { delivered: true } };
const NOT_LIVE: InputResult = { code: 409, body: { reason: "not-live" } };
const answerLine = (id: string, v = "B", label = "Registry-driven") => `[queue ${id}] choice: ${v} (${label})`;
const withdrawalLine = (id: string, v = "B") => `[queue ${id}] the earlier answer (${v}) is withdrawn; wait for the user`;

type Pushed = { msgId?: string; p: Promise<void> };

// The shared harness (actions.fixture.ts) with a real Deliverer. The inbox is
// a fake whose cancel answers `cancel` (default "absent"), or a real
// MasterInbox when one is given.
function setup(o: {
  input?: (m: { msgId: string; text: string }) => Promise<InputResult>;
  cancel?: "removed" | "in-flight" | "absent";
  inbox?: MasterInbox;
  failDecision?: boolean;
} = {}) {
  const h = harness(root, () => clock, o);
  const records = new Map([record(W), record(FLEET_MASTER_ID, { kind: "fleet-master" })].map((r) => [r.id, r]));
  const agents = { load: async (id: string) => records.get(id) ?? null, exists: async (id: string) => records.has(id) };
  const inputs: { agentId: string; msgId: string; text: string }[] = [];
  const pushed: Pushed[] = [];
  const cancels: string[] = [];
  const deliverer = new Deliverer({
    store: h.store, agents, rules: h.rules, hub: new EventHub(), now: () => clock, undoMs: UNDO_MS, log: () => {},
    composer: {
      inputInternal: async (agentId, m) => {
        inputs.push({ agentId, ...m });
        return o.input ? o.input(m) : OK;
      },
    },
    inbox: {
      pushConsole: (text, surface, opts) => {
        const p = o.inbox ? o.inbox.pushConsole(text, surface, opts) : new Promise<void>(() => {});
        pushed.push({ msgId: opts?.msgId, p });
        return p;
      },
    },
  });
  const actions = new QueueActions({
    store: h.store, rules: h.rules, decisions: h.decisions, agents, deliverer: h.kicker,
    inbox: o.inbox ?? { cancel: (msgId) => { cancels.push(msgId); return o.cancel ?? "absent"; } }, audit: h.audit,
    undoMs: UNDO_MS, now: () => clock, log: h.log,
    mergeState: async () => ({ state: "not-merged", detail: "open" }),
  });
  return { ...h, actions, deliverer, agents, inputs, pushed, cancels };
}
type F = ReturnType<typeof setup>;

// A setup write; it forgets the kicks too.
async function patch(f: F, id: string, fn: (it: QueueItem) => QueueItem): Promise<void> {
  await patchItem(f, id, fn);
  reset(f);
}
// A committed user answer `B` on a new item of `agentId`; nothing sent yet.
async function answered(f: F, agentId = W, value = "B"): Promise<string> {
  const { id } = await f.store.add(choice(agentId));
  ok(await f.actions.answerUser(id, { value }, "tab"));
  reset(f);
  return id;
}
const setDelivery = (f: F, id: string, state: Delivery["state"]) =>
  patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state, attempts: 1, at: clock } }));

// A real inbox whose send waits until the test settles it.
function realInbox() {
  const sent: string[] = [];
  const sends: ((ok: boolean) => void)[] = [];
  const inbox = new MasterInbox({
    hub: new EventHub(), tracker: new InputTracker(() => clock), now: () => clock,
    events: { size: () => 0, digest: () => null, clear: () => {} },
    send: (t) => { sent.push(t); return new Promise<boolean>((r) => { sends.push(r); }); },
  });
  return { inbox, sent, sends };
}

describe("undo: who, what and when", () => {
  it("USER inside the window: answer → history, status open, recommend and delivery cleared; one hub event; kick after the lock", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    const rid = (await f.rules.add({ text: "Prefer hand-rolled lists.", state: "active", kind: "decision", scope: { area: "*" }, source: { origin: "panel" } })).rule.id;
    await patch(f, id, (it) => ({ ...it, recommend: { value: "A", why: "rule", ruleIds: [rid], by: "fleet-master", at: clock } }));
    const answer = ok(await f.actions.answerUser(id, { value: "B" }, "tab")).answer!;
    reset(f);
    const rulesBefore = await ruleEvents(f);
    clock += 60_000;
    const item = ok(await f.actions.undo(id, USER));
    expect(item.status).toBe("open");
    expect(item.answer).toBeUndefined();
    expect(item.history).toEqual([answer]);
    expect(item.answerSeq).toBe(1);
    expect(item.recommend).toBeUndefined();
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toBeUndefined(); // the line was still pending
    expect(await get(f, id)).toEqual(item);
    expect(f.changes).toEqual([item]);
    expect(f.kicks).toEqual([id]);
    // No hit or strike: the commit, then the decision line under the item lock; the kick after it.
    expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: "decision", held: 1 }, { what: `kick ${id}`, held: 0 }]);
    expect(await ruleEvents(f)).toEqual(rulesBefore);
  });

  it("the decision line: correction false, reason undo-own, the undone value", async () => {
    const f = setup();
    const id = await answered(f);
    clock += 1_000;
    ok(await f.actions.undo(id, USER));
    const all = await lines(f);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({
      at: clock, via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "B", text: "", correction: false, reason: "undo-own",
    });
  });

  it("a pr undo: the decision line carries prUrl; the answer and its text go to history; no rule event", async () => {
    const f = setup();
    const { id } = await f.store.add(pr);
    const answer = ok(await f.actions.answerUser(id, { value: "changes", text: "Split the migration out." }, "tab")).answer!;
    const rulesBefore = await ruleEvents(f); // the pr-changes candidate
    clock += 1_000;
    const item = ok(await f.actions.undo(id, USER));
    expect(item.history).toEqual([answer]);
    expect(answer.text).toBe("Split the migration out.");
    const all = await lines(f);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({
      at: clock, via: "queue-tab", by: "user", itemId: id, agentId: W, prUrl: PR_URL, repo: "app-shop", area: "app-shop",
      value: "changes", text: "", correction: false, reason: "undo-own",
    });
    expect(await ruleEvents(f)).toEqual(rulesBefore);
  });

  it("a question undo: the answer with its text goes to history; the decision line has the value and no text", async () => {
    const f = setup();
    const { id } = await f.store.add(question);
    const answer = ok(await f.actions.answerUser(id, { value: "reply", text: "Use Postgres." }, "tab")).answer!;
    clock += 1_000;
    const item = ok(await f.actions.undo(id, USER));
    expect(item.status).toBe("open");
    expect(item.answer).toBeUndefined();
    expect(item.history).toEqual([answer]);
    expect(answer.text).toBe("Use Postgres.");
    const all = await lines(f);
    expect(all[0]).toMatchObject({ value: "reply", text: "Use Postgres." });
    expect(all[1]).toEqual({
      at: clock, via: "queue-tab", by: "user", itemId: id, agentId: W, repo: "app-shop", area: "app-shop",
      value: "reply", text: "", correction: false, reason: "undo-own",
    });
  });

  it("a failing decision-log write is logged; the undo stands, 200 and kick", async () => {
    const f = setup({ failDecision: true });
    const id = await answered(f);
    const item = ok(await f.actions.undo(id, USER));
    expect(item.status).toBe("open");
    expect(await get(f, id)).toEqual(item);
    expect(f.kicks).toEqual([id]);
    expect(f.logs.join("\n")).toMatch(/decisions disk full/);
  });

  it("the window: undoMs after the answer → 200; undoMs + 1 → 409 undo window passed, nothing written", async () => {
    const f = setup();
    const a = await answered(f);
    const b = await answered(f);
    clock += UNDO_MS;
    ok(await f.actions.undo(a, USER));
    clock += 1;
    const before = raw(f, b);
    reset(f);
    expect(await f.actions.undo(b, USER)).toEqual({ code: 409, body: { error: "undo window passed", item: await get(f, b) } });
    expect(raw(f, b)).toBe(before);
    expect(f.changes).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect(await lines(f)).toHaveLength(3); // two answers, one undo
  });

  it("an item the scanner closed (delivered, window passed) → 409 undo window passed", async () => {
    const f = setup();
    const id = await answered(f);
    await patch(f, id, (it) => ({ ...it, delivery: { ...it.delivery!, state: "delivered" }, closedAt: clock }));
    const before = raw(f, id);
    expect(await f.actions.undo(id, USER)).toEqual({ code: 409, body: { error: "undo window passed", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
  });

  it("no answer → 409 with the current item: an open item, and the second of two fast undos; unknown id → 404", async () => {
    const f = setup();
    const { id: open } = await f.store.add(choice(W));
    expect(await f.actions.undo(open, USER)).toEqual({ code: 409, body: { error: "nothing to undo", item: await get(f, open) } });
    const id = await answered(f);
    const rs = await Promise.all([f.actions.undo(id, USER), f.actions.undo(id, USER)]);
    const now = await get(f, id);
    expect(rs.filter((r) => r.code === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.code === 409)).toEqual([{ code: 409, body: { error: "nothing to undo", item: now } }]);
    expect(now.history).toHaveLength(1);
    expect(await lines(f)).toHaveLength(2);
    expect(f.kicks).toEqual([id]);
    expect(await f.actions.undo("q00000000", USER)).toEqual({ code: 404, body: { error: "not found" } });
  });

  // The undo of an auto answer (Task 2b-7) is tested in auto.races.test.ts.
  it("a caller that is not USER on a user answer (the item's own agent, the master, none) → 403, nothing written", async () => {
    const f = setup();
    const id = await answered(f);
    const before = raw(f, id);
    const callers: Caller[] = [
      { level: "agent", agentHeaders: true, agentId: W, kind: "worker" },
      { level: "master", agentHeaders: true, agentId: FLEET_MASTER_ID, kind: "fleet-master" },
      { level: "none", agentHeaders: false },
    ];
    for (const c of callers) expect((await f.actions.undo(id, c)).code, c.level).toBe(403);
    expect(raw(f, id)).toBe(before);
    expect(f.kicks).toEqual([]);
  });
});

describe("undo per delivery state (§5.6 table)", () => {
  it("held, pending, failed → silent: delivery cleared, no withdrawal, no cancel", async () => {
    const f = setup();
    for (const state of ["held", "pending", "failed"] as const) {
      const id = await answered(f);
      await setDelivery(f, id, state);
      const item = ok(await f.actions.undo(id, USER));
      expect(item.delivery, state).toBeUndefined();
      expect(item.withdrawal, state).toBeUndefined();
    }
    expect(f.cancels).toEqual([]);
  });

  it("delivered and unknown (worker) → withdrawal q…-w1, pending, attempts 0", async () => {
    const f = setup();
    for (const state of ["delivered", "unknown"] as const) {
      const id = await answered(f);
      await setDelivery(f, id, state);
      const item = ok(await f.actions.undo(id, USER));
      expect(item.delivery, state).toBeUndefined();
      expect(item.withdrawal, state).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    }
    expect(f.cancels).toEqual([]);
  });

  it("master delivering, cancel → absent: withdrawal q…-w1 without afterMsgId", async () => {
    const f = setup({ cancel: "absent" });
    const id = await answered(f, FLEET_MASTER_ID);
    await setDelivery(f, id, "delivering");
    const item = ok(await f.actions.undo(id, USER));
    expect(f.cancels).toEqual([`${id}-1`]);
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
  });

  it("an item write that fails after the inbox cancel → a clear warning, the error goes on; cancel absent or none → no warning", async () => {
    for (const [agentId, cancel] of [[FLEET_MASTER_ID, "removed"], [FLEET_MASTER_ID, "in-flight"], [FLEET_MASTER_ID, "absent"], [W, undefined]] as const) {
      const f = setup({ cancel: cancel ?? "absent" });
      const id = await answered(f, agentId);
      await setDelivery(f, id, agentId === W ? "delivered" : "delivering");
      const before = raw(f, id);
      f.store.write = async () => { throw new Error("queue disk full"); };
      await expect(f.actions.undo(id, USER)).rejects.toThrow("queue disk full");
      expect(raw(f, id)).toBe(before);
      expect(f.kicks).toEqual([]);
      expect(f.cancels).toEqual(cancel === undefined ? [] : [`${id}-1`]);
      if (cancel === undefined || cancel === "absent") {
        expect(f.logs).toEqual([]);
      } else {
        expect(f.logs).toEqual([`[queue] ${id}: undo write failed after the inbox cancel of ${id}-1 (${cancel}): queue disk full;`
          + " the item keeps its answer and its slot stays delivering (unknown after a restart): undo again, or Mark delivered, not Resend"]);
      }
    }
  });

  it("the withdrawal names the undone answer's seq: the second undo of an item → q…-w2", async () => {
    const f = setup();
    const id = await answered(f);
    await setDelivery(f, id, "delivered");
    ok(await f.actions.undo(id, USER));
    await patch(f, id, (it) => ({ ...it, withdrawal: { ...it.withdrawal!, state: "delivered" } }));
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    await setDelivery(f, id, "delivered");
    const item = ok(await f.actions.undo(id, USER));
    expect(item.history.map((a) => a.value)).toEqual(["B", "A"]);
    expect(item.withdrawal).toEqual({ msgId: `${id}-w2`, state: "pending", attempts: 0 });
  });

  it("an undo that makes no withdrawal keeps the one still waiting (one slot, §5.6)", async () => {
    const f = setup();
    const id = await answered(f);
    await setDelivery(f, id, "delivered");
    ok(await f.actions.undo(id, USER));
    // The re-answer waits behind w1; its undo finds it pending.
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    const item = ok(await f.actions.undo(id, USER));
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    expect(item.history.map((a) => a.value)).toEqual(["B", "A"]);
  });

  it("after every undo `delivery` is absent: a restart leaves it absent and Resend / Mark delivered refuse the answer slot", async () => {
    const f = setup({ cancel: "absent" });
    const ids: string[] = [];
    for (const [agentId, state] of [[W, "held"], [W, "pending"], [W, "failed"], [W, "delivered"], [W, "unknown"],
      [FLEET_MASTER_ID, "delivering"]] as const) {
      const id = await answered(f, agentId);
      await setDelivery(f, id, state);
      expect(ok(await f.actions.undo(id, USER)).delivery, state).toBeUndefined();
      ids.push(id);
    }
    // A restart: a new Deliverer over the same store runs its boot scan.
    const after = new Deliverer({ store: f.store, agents: f.agents, rules: f.rules, hub: new EventHub(), now: () => clock, undoMs: UNDO_MS,
      log: () => {}, composer: { inputInternal: async () => OK }, inbox: { pushConsole: async () => {} } });
    await after.bootScan([]);
    for (const id of ids) {
      const it = await get(f, id);
      expect(it.delivery).toBeUndefined();
      for (const action of ["resend", "mark-delivered"]) {
        expect(await f.actions.deliveryAction(id, action)).toEqual({ code: 409, body: { error: "only an unknown or failed slot", item: it } });
      }
    }
  });

  it("worker paste in progress: undo waits on the item lock and acts on the settled state (delivered → withdrawal)", async () => {
    const paste = deferred<InputResult>();
    const f = setup({ input: () => paste.promise });
    const id = await answered(f);
    const d = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(f.queued()).toBe(0); // the paste holds the item lock
    reset(f); // the Deliverer's `delivering` write
    const u = f.actions.undo(id, USER);
    // Not settled: the undo waits for that lock, its body has not run.
    expect(f.queued()).toBe(1);
    expect(await settledState(u)).toBe("pending");
    expect(f.queued()).toBe(1);
    expect(f.steps).toEqual([]);
    expect((await get(f, id)).delivery?.state).toBe("delivering");
    paste.resolve(OK);
    await d;
    const item = ok(await u);
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
  });

  it("worker paste in progress that settles failed (not-live) → silent, no withdrawal", async () => {
    const paste = deferred<InputResult>();
    const f = setup({ input: () => paste.promise });
    const id = await answered(f);
    const d = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const u = f.actions.undo(id, USER);
    paste.resolve(NOT_LIVE);
    await d;
    const item = ok(await u);
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toBeUndefined();
  });

  it("master queued (real inbox) → cancel removed: no withdrawal, the push rejects `cancelled`, the slot gets nothing", async () => {
    const { inbox, sent } = realInbox();
    const f = setup({ inbox });
    const id = await answered(f, FLEET_MASTER_ID);
    const d = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(inbox.queuedMessages()).toBe(1));
    expect((await get(f, id)).delivery?.state).toBe("delivering");
    f.changes.length = 0;
    const item = ok(await f.actions.undo(id, USER));
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toBeUndefined();
    expect(f.pushed.map((p) => p.msgId)).toEqual([`${id}-1`]);
    await expect(f.pushed[0]!.p).rejects.toEqual(new InboxError("cancelled"));
    await d;
    expect(await get(f, id)).toEqual(item);
    expect(f.changes).toEqual([item]); // the undo's write only
    expect(inbox.queuedMessages()).toBe(0);
    await inbox.tick(); // idle, no draft, quiet: a queued line would go out now
    expect(sent).toEqual([]);
  });

  it("master in flight (real inbox) → withdrawal with afterMsgId, released when the send resolves; then the withdrawal goes", async () => {
    const { inbox, sent, sends } = realInbox();
    const f = setup({ inbox });
    const id = await answered(f, FLEET_MASTER_ID);
    const d = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(inbox.queuedMessages()).toBe(1));
    const t = inbox.tick();
    await vi.waitFor(() => expect(sent).toEqual([answerLine(id)]));
    const item = ok(await f.actions.undo(id, USER));
    expect(item.delivery).toBeUndefined();
    expect(item.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0, afterMsgId: `${id}-1` });
    // It waits on the in-flight send: nothing is pushed for it yet.
    await f.deliverer.deliver(id);
    expect(f.pushed).toHaveLength(1);
    sends[0]!(true);
    await t;
    await d;
    let it = await get(f, id);
    expect(it.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    expect(it.delivery).toBeUndefined();
    // Released: the withdrawal line is pushed next.
    inbox.onHook("Stop");
    const d2 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(inbox.queuedMessages()).toBe(1));
    const t2 = inbox.tick();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toBe(withdrawalLine(id));
    sends[1]!(true);
    await t2;
    await d2;
    it = await get(f, id);
    expect(it.withdrawal).toMatchObject({ msgId: `${id}-w1`, state: "delivered" });
  });

  it("master in flight (real inbox) whose send returns false → the withdrawal is dropped and the answer never re-sent", async () => {
    const { inbox, sent, sends } = realInbox();
    const f = setup({ inbox });
    const id = await answered(f, FLEET_MASTER_ID);
    const d = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(inbox.queuedMessages()).toBe(1));
    const t = inbox.tick();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(ok(await f.actions.undo(id, USER)).withdrawal).toMatchObject({ afterMsgId: `${id}-1` });
    sends[0]!(false);
    await t;
    await d;
    await expect(f.pushed[0]!.p).rejects.toEqual(new InboxError("cancelled"));
    const it = await get(f, id);
    expect(it.withdrawal).toBeUndefined();
    expect(it.delivery).toBeUndefined();
    expect(it.status).toBe("open");
    expect(inbox.queuedMessages()).toBe(0);
    await inbox.tick();
    expect(sent).toHaveLength(1);
  });

  it("answer → undo → re-answer: the new answer waits until the withdrawal is delivered", async () => {
    const results: InputResult[] = [OK, NOT_LIVE, OK, OK];
    const f = setup({ input: async () => results.shift()! });
    const id = await answered(f);
    await f.deliverer.deliver(id); // B delivered
    ok(await f.actions.undo(id, USER));
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    await f.deliverer.deliver(id); // the withdrawal goes first and fails (not-live)
    expect((await get(f, id)).withdrawal).toMatchObject({ state: "failed", lastError: "not-live" });
    await f.deliverer.deliver(id); // the new answer waits behind the failed withdrawal
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`]);
    expect((await get(f, id)).delivery).toEqual({ msgId: `${id}-2`, state: "pending", attempts: 0 });
    ok(await f.actions.deliveryAction(id, "resend", "withdrawal"));
    await f.deliverer.deliver(id); // the withdrawal again
    expect((await get(f, id)).delivery?.state).toBe("pending");
    await f.deliverer.deliver(id); // now the answer
    expect(f.inputs.map((i) => [i.msgId, i.text])).toEqual([
      [`${id}-1`, answerLine(id)], [`${id}-w1`, withdrawalLine(id)], [`${id}-w1`, withdrawalLine(id)],
      [`${id}-2`, answerLine(id, "A", "Hand-rolled")],
    ]);
    const it = await get(f, id);
    expect(it.withdrawal?.state).toBe("delivered");
    expect(it.delivery?.state).toBe("delivered");
  });

  it("Mark delivered on the failed withdrawal kicks the item, and the waiting answer goes out", async () => {
    const results: InputResult[] = [OK, NOT_LIVE, OK];
    const f = setup({ input: async () => results.shift()! });
    const id = await answered(f);
    await f.deliverer.deliver(id);
    ok(await f.actions.undo(id, USER));
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    await f.deliverer.deliver(id); // the withdrawal fails (not-live)
    f.kicks.length = 0;
    ok(await f.actions.deliveryAction(id, "mark-delivered", "withdrawal"));
    expect(f.kicks).toEqual([id]);
    for (const k of f.kicks) await f.deliverer.deliver(k);
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`, `${id}-2`]);
    expect((await get(f, id)).delivery?.state).toBe("delivered");
  });
});

// Ruling P5 (Task 2b-4): the Telegram [Undo] names its answer by seq (overview
// decision 51) and writes its decision line via queue-telegram.
describe("undo opts: expectSeq and via", () => {
  it("expectSeq equal to answerSeq undoes; via telegram writes the decision line via queue-telegram", async () => {
    const f = setup();
    const id = await answered(f);
    clock += 1_000;
    const item = ok(await f.actions.undo(id, USER, { expectSeq: 1, via: "telegram" }));
    expect(item.status).toBe("open");
    const all = await lines(f);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ via: "queue-telegram", reason: "undo-own", value: "B" });
  });

  it("a stale expectSeq (undone and answered again) → 409 with the item, nothing written, no kick", async () => {
    const f = setup();
    const id = await answered(f);
    ok(await f.actions.undo(id, USER));
    ok(await f.actions.answerUser(id, { value: "A" }, "tab"));
    reset(f);
    const before = raw(f, id);
    const linesBefore = await lines(f);
    const r = await f.actions.undo(id, USER, { expectSeq: 1, via: "telegram" });
    expect(r).toEqual({ code: 409, body: { error: "stale undo", item: await get(f, id) } });
    expect(raw(f, id)).toBe(before);
    expect(f.changes).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect(await lines(f)).toEqual(linesBefore);
  });

  it("expectSeq is compared under the item lock: an answer queued first on the lock wins", async () => {
    const f = setup();
    const id = await answered(f);
    ok(await f.actions.undo(id, USER));
    reset(f);
    // The item is open at answerSeq 1. Hold its lock, queue a new answer, then
    // the undo of seq 1: a check before the lock would still see seq 1.
    const hold = deferred<void>();
    const blocker = f.store.withItem(id, () => hold.promise);
    const answer = f.actions.answerUser(id, { value: "A" }, "tab");
    const undo = f.actions.undo(id, USER, { expectSeq: 1 });
    expect(await settledState(undo)).toBe("pending");
    hold.resolve();
    await blocker;
    expect(ok(await answer).answerSeq).toBe(2);
    expect(await undo).toMatchObject({ code: 409, body: { error: "stale undo" } });
    const now = await get(f, id);
    expect(now.status).toBe("answered");
    expect(now.answer?.value).toBe("A");
  });

  it("without opts the decision line stays via queue-tab", async () => {
    const f = setup();
    const id = await answered(f);
    ok(await f.actions.undo(id, USER, {}));
    expect((await lines(f))[1]).toMatchObject({ via: "queue-tab" });
  });
});
