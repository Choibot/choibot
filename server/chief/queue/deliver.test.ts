import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { InputResult } from "../../agents/composer.js";
import type { AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import type { ActedLog } from "../../master/acted.js";
import { InputTracker } from "../../master/draft.js";
import { BUSY_TIMEOUT_MS, InboxError, MasterInbox, type Surface } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { Deliverer, type DelivererDeps } from "./deliver.js";
import { closedMerged } from "./lines.js";
import { QueueStore, type NewItem } from "./store.js";
import type { Answer, QueueItem } from "./types.js";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-deliver-"));
  clock = 5_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const W = "a1"; // a worker agent id
const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: agentId === FLEET_MASTER_ID ? "fleet-master" : "worker" },
  repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] },
});
const user = (o: Partial<Answer> = {}): Answer => ({ value: "B", by: "user", via: "tab", at: clock, ...o });
const auto = (o: Partial<Answer> = {}): Answer =>
  ({ value: "B", by: "master", via: "cli", at: clock, ruleIds: ["r_8f3k2"], confidence: 0.95, ...o });
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});
const answerLine = (id: string) => `[queue ${id}] choice: B (Registry-driven)`;
const withdrawalLine = (id: string, v = "B") => `[queue ${id}] the earlier answer (${v}) is withdrawn; wait for the user`;
const OK: InputResult = { code: 200, body: { delivered: true } };

type Push = {
  text: string; surface: Surface | null; opts: { msgId?: string; timeoutMs?: number; since?: number };
  resolve: () => void; reject: (e: Error) => void;
};

function setup(o: {
  input?: (agentId: string, m: { msgId: string; text: string }) => Promise<InputResult>;
  records?: AgentRecord[];
  exists?: (id: string) => boolean;
  inbox?: Pick<MasterInbox, "pushConsole">;
  onChange?: (item: QueueItem) => void;
} = {}) {
  const store = new QueueStore(join(root, "queue"), { now: () => clock, log: () => {}, onChange: o.onChange });
  const records = new Map((o.records ?? [record(W), record(FLEET_MASTER_ID, { kind: "fleet-master" })]).map((r) => [r.id, r]));
  const inputs: { agentId: string; msgId: string; text: string }[] = [];
  const pushes: Push[] = [];
  const logs: string[] = [];
  const deps: DelivererDeps = {
    store,
    agents: {
      load: async (id) => records.get(id) ?? null,
      exists: async (id) => (o.exists ? o.exists(id) : records.has(id)),
    },
    composer: {
      inputInternal: async (agentId, m) => {
        inputs.push({ agentId, ...m });
        return o.input ? o.input(agentId, m) : OK;
      },
    },
    inbox: o.inbox ?? {
      pushConsole: (text, surface, opts = {}) =>
        new Promise<void>((resolve, reject) => { pushes.push({ text, surface, opts, resolve, reject }); }),
    },
    rules: { hit: async () => {} },
    hub: new EventHub(),
    now: () => clock,
    undoMs: 600_000,
    log: (s) => logs.push(s),
  };
  return { store, records, inputs, pushes, logs, deliverer: new Deliverer(deps) };
}

// The answer commit of Task 2a-12 (an auto answer as the scanner leaves it
// once its 60 s hold ends: pending).
async function commit(s: QueueStore, id: string, a: Answer): Promise<void> {
  await s.withItem(id, async () => {
    const it = (await s.get(id))!;
    const seq = it.answerSeq + 1;
    await s.write({
      ...it, status: a.by === "master" ? "auto" : "answered", answer: a, answerSeq: seq,
      delivery: { msgId: `${id}-${seq}`, state: "pending", attempts: 0 },
    });
  });
}

// The undo of Task 2a-13, already holding the item lock: the answer goes to
// history, `delivery` is always cleared, and `withdraw` decides the withdrawal.
async function undoLocked(s: QueueStore, id: string, withdraw?: { afterMsgId?: string }): Promise<void> {
  const it = (await s.get(id))!;
  const { answer, delivery: _cleared, ...rest } = it;
  const next: QueueItem = { ...rest, status: "open", history: [...it.history, answer!] };
  if (withdraw) next.withdrawal = { msgId: `${id}-w${it.answerSeq}`, state: "pending", attempts: 0, ...withdraw };
  await s.write(next);
}
const undo = (s: QueueStore, id: string, withdraw?: { afterMsgId?: string }) =>
  s.withItem(id, () => undoLocked(s, id, withdraw));

async function patch(s: QueueStore, id: string, f: (it: QueueItem) => QueueItem): Promise<void> {
  await s.withItem(id, async () => { await s.write(f((await s.get(id))!)); });
}

const get = async (s: QueueStore, id: string) => (await s.get(id))!;

describe("Deliverer, worker or lead slot", () => {
  it("200 → delivered; the paste sees `delivering` already on disk (written first)", async () => {
    let seen: unknown;
    const f = setup({
      input: async () => {
        seen = (JSON.parse(readFileSync(join(root, "queue", `${id}.json`), "utf8")) as QueueItem).delivery;
        return OK;
      },
    });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-1`, text: answerLine(id) }]);
    expect(seen).toEqual({ msgId: `${id}-1`, state: "delivering", attempts: 1, at: clock });
    const it = await get(f.store, id);
    expect(it.delivery).toEqual({ msgId: `${id}-1`, state: "delivered", attempts: 1, at: clock });
    expect(it.status).toBe("answered");
  });

  it("409 starting → pending; a retry counts attempts and keeps `at` from the first try", async () => {
    const results: InputResult[] = [{ code: 409, body: { reason: "starting" } }, OK];
    const f = setup({ input: async () => results.shift()! });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    const first = clock;
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-1`, state: "pending", attempts: 1, at: first });
    clock += 5_000;
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-1`, state: "delivered", attempts: 2, at: first });
    expect(f.inputs).toHaveLength(2);
  });

  it("409 not-live → failed `not-live`", async () => {
    const f = setup({ input: async () => ({ code: 409, body: { reason: "not-live" } }) });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "not-live", attempts: 1 });
  });

  it("404 with the record file gone → in one write the item is `withdrawn` (agent-gone, closedAt) and the slot `failed`", async () => {
    const seen: QueueItem[] = [];
    const f = setup({
      input: async () => ({ code: 404, body: { reason: "agent-gone" } }), exists: () => false, onChange: (i) => seen.push(i),
    });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    clock += 1_000;
    await f.deliverer.deliver(id);
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "agent-gone", closedAt: clock });
    expect(it.delivery).toMatchObject({ state: "failed", lastError: "agent-gone" });
    // The write before the last one is `delivering`; no write shows the slot
    // failed on a live item or a withdrawn item with a live slot.
    expect(seen.at(-2)).toMatchObject({ status: "answered", delivery: { state: "delivering" } });
    expect(seen.at(-1)).toMatchObject({ status: "withdrawn", delivery: { state: "failed" } });
  });

  it("404 on a withdrawal with the record file gone → the OTHER waiting slot (the re-answer) fails agent-gone in the same write", async () => {
    const seen: QueueItem[] = [];
    let gone = false;
    const f = setup({
      input: async () => (gone ? { code: 404, body: { reason: "agent-gone" } } : OK), exists: () => !gone, onChange: (i) => seen.push(i),
    });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await commit(f.store, id, user({ value: "A" }));
    gone = true;
    await f.deliverer.deliver(id); // the withdrawal goes first and gets 404
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "agent-gone", closedAt: clock });
    expect(it.withdrawal).toMatchObject({ state: "failed", lastError: "agent-gone", attempts: 1 });
    expect(it.delivery).toEqual({ msgId: `${id}-2`, state: "failed", lastError: "agent-gone", attempts: 0 });
    // One write takes both slots from waiting to failed.
    expect(seen.at(-2)).toMatchObject({ status: "answered", withdrawal: { state: "delivering" }, delivery: { state: "pending" } });
    expect(seen.at(-1)).toMatchObject({ status: "withdrawn", withdrawal: { state: "failed" }, delivery: { state: "failed" } });
    await f.deliverer.deliver(id);
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`]);
  });

  it("404 while the record file still exists (half-written) → `pending`, not withdrawn (decision 37)", async () => {
    const f = setup({ input: async () => ({ code: 404, body: { reason: "agent-gone" } }), exists: () => true });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    const it = await get(f.store, id);
    expect(it.status).toBe("answered");
    expect(it.closedAt).toBeUndefined();
    expect(it.delivery).toMatchObject({ state: "pending", attempts: 1 });
  });

  it("400 from the gate → `failed` with its error (a retry cannot fix it)", async () => {
    const f = setup({ input: async () => ({ code: 400, body: { error: "text over 32000 chars" } }) });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "text over 32000 chars" });
  });

  it("an inputInternal that throws after `delivering` was written → `unknown` with lastError (offered for Resend)", async () => {
    const f = setup({ input: async () => { throw new Error("pty write EPIPE"); } });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "unknown", lastError: "pty write EPIPE", attempts: 1 });
  });

  it("an auto answer to a closed agent → `failed` agent-closed, no inputInternal", async () => {
    const f = setup({ records: [record(W, { closedAt: 1 })] });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, auto());
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "agent-closed" });
  });

  it("the withdrawal of an auto answer to a closed agent → `failed` agent-closed, no inputInternal", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, auto());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    f.records.set(W, record(W, { closedAt: 1 }));
    await f.deliverer.deliver(id);
    expect(f.inputs).toHaveLength(1);
    expect((await get(f.store, id)).withdrawal).toMatchObject({ msgId: `${id}-w1`, state: "failed", lastError: "agent-closed" });
  });

  it("an auto answer whose record reads as null but still exists (half-written) stays `pending`, no inputInternal", async () => {
    const f = setup({ records: [], exists: () => true });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, auto());
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-1`, state: "pending", attempts: 0 });
    expect(f.logs.some((l) => l.includes(id) && l.includes(W) && l.includes("half-written"))).toBe(true);
  });

  it("the withdrawal of a user answer to a closed agent → inputInternal is called (the gate resumes it)", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    f.records.set(W, record(W, { closedAt: 1 }));
    await f.deliverer.deliver(id);
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`]);
  });

  it("a withdrawal whose seq names no history entry fails closed: taken as an auto answer's, so a closed agent → agent-closed", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await patch(f.store, id, (it) => ({ ...it, withdrawal: { ...it.withdrawal!, msgId: `${id}-w7` } }));
    f.records.set(W, record(W, { closedAt: 1 }));
    await f.deliverer.deliver(id);
    expect(f.inputs).toHaveLength(1);
    expect((await get(f.store, id)).withdrawal).toMatchObject({ msgId: `${id}-w7`, state: "failed", lastError: "agent-closed" });
  });

  it("a withdrawal with no answer in history → `failed` no-answer, nothing sent", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, (it) => ({ ...it, answerSeq: 1, withdrawal: { msgId: `${id}-w1`, state: "pending", attempts: 0 } }));
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    expect((await get(f.store, id)).withdrawal).toMatchObject({ state: "failed", lastError: "no-answer", attempts: 0 });
  });

  it("a 404 on an item already `withdrawn` keeps its closedAt and lastError; the slot fails agent-gone", async () => {
    const f = setup({ input: async () => ({ code: 404, body: { reason: "agent-gone" } }), exists: () => false });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id); // 404: withdrawn now
    await patch(f.store, id, (it) => ({ ...it, closedAt: 123, lastError: "merged", delivery: { ...it.delivery!, state: "pending" } }));
    clock += 60_000;
    await f.deliverer.deliver(id);
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", closedAt: 123, lastError: "merged" });
    expect(it.delivery).toMatchObject({ state: "failed", lastError: "agent-gone" });
  });

  it("a user answer to a closed agent → inputInternal is called (the gate resumes it)", async () => {
    const f = setup({ records: [record(W, { closedAt: 1 })] });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect(f.inputs).toHaveLength(1);
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
  });

  it("an item with `answer` absent and a stale `delivery` → nothing is sent, nothing written", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await patch(f.store, id, (it) => ({ ...it, delivery: { msgId: `${id}-1`, state: "pending", attempts: 0 } }));
    const before = readFileSync(join(root, "queue", `${id}.json`), "utf8");
    clock += 1_000;
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    expect(readFileSync(join(root, "queue", `${id}.json`), "utf8")).toBe(before);
  });

  it("a slot that is not `pending` (held, delivering, delivered, failed, unknown) is not sent", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    for (const state of ["held", "delivering", "delivered", "failed", "unknown"] as const) {
      await patch(f.store, id, (it) => ({ ...it, delivery: { ...it.delivery!, state } }));
      await f.deliverer.deliver(id);
    }
    expect(f.inputs).toEqual([]);
  });

  it("a missing item → nothing", async () => {
    const f = setup();
    await f.deliverer.deliver("q00000000");
    expect(f.inputs).toEqual([]);
  });
});

// Overview decision 60: an item closed as merged has no answer; its `delivery` slot is the
// merged notice, and the agent gets one line through the answers' own path.
describe("Deliverer, the merged notice of a pr item", () => {
  const prOf = (agentId: string): NewItem => ({
    kind: "pr", agentId, createdBy: { agentId, kind: agentId === FLEET_MASTER_ID ? "fleet-master" : "worker" },
    repo: "app-shop", area: "app-shop", title: "PR #12", body: "", blocking: false, pr: { url: "https://github.com/o/app-shop/pull/12", number: 12 },
  });
  const mergedLine = (id: string) => `[queue ${id}] pr: merged — continue or finish`;
  const merge = (s: QueueStore, id: string) => patch(s, id, (it) => closedMerged(it, clock));

  it("a worker gets one line, `[queue <id>] pr: merged — continue or finish`, msgId `<id>-m`; the slot ends `delivered`", async () => {
    const f = setup();
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-m`, text: mergedLine(id) }]);
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", delivery: { msgId: `${id}-m`, state: "delivered", attempts: 1 } });
    // Nothing more goes out for it.
    await f.deliverer.deliver(id);
    await f.deliverer.tick();
    expect(f.inputs).toHaveLength(1);
  });

  it("the scanner picks a pending notice up by itself (a kick lost in a restart)", async () => {
    const f = setup();
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.tick();
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("delivered"));
    expect(f.inputs).toEqual([{ agentId: W, msgId: `${id}-m`, text: mergedLine(id) }]);
  });

  it("the fleet master's own pr item: the line is pushed to its inbox on the tab surface", async () => {
    const f = setup();
    const { id } = await f.store.add(prOf(FLEET_MASTER_ID));
    await merge(f.store, id);
    const run = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    expect(f.pushes[0]).toMatchObject({ text: mergedLine(id), surface: "tab", opts: { msgId: `${id}-m` } });
    f.pushes[0]!.resolve();
    await run;
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
    expect(f.inputs).toEqual([]);
  });

  it("a closed agent is not resumed for it: no paste, the slot is dropped, the item stays closed as merged", async () => {
    const f = setup({ records: [record(W, { closedAt: 1 })] });
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged" });
    expect(it.delivery).toBeUndefined();
    expect(f.logs).toEqual([expect.stringContaining("is closed; no merged line")]);
  });

  it("an agent whose record is gone: the slot is dropped (no agent-gone rewrite of the item)", async () => {
    const f = setup({ input: async () => ({ code: 404, body: { reason: "agent-gone" } }), exists: () => false });
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    const it = await get(f.store, id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: clock });
    expect(it.delivery).toBeUndefined();
  });

  it("a half-written record: the notice waits, nothing is sent", async () => {
    const f = setup({ records: [], exists: () => true });
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    expect(f.inputs).toEqual([]);
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-m`, state: "pending", attempts: 0 });
  });

  it("an agent with no session: `failed` not-live, and the line goes out when the agent comes back (retryAgent)", async () => {
    let live = false;
    const f = setup({ input: async () => (live ? OK : { code: 409, body: { reason: "not-live" } }) });
    const { id } = await f.store.add(prOf(W));
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "not-live" });
    live = true;
    f.deliverer.start()();
    await f.deliverer.retryAgent(W);
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery?.state).toBe("delivered"));
    expect(f.inputs.at(-1)).toEqual({ agentId: W, msgId: `${id}-m`, text: mergedLine(id) });
  });

  it("a withdrawal still owed (an undone answer) goes first, then the merged line", async () => {
    const f = setup();
    const { id } = await f.store.add(prOf(W));
    await commit(f.store, id, user({ value: "changes", text: "x" }));
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await merge(f.store, id);
    await f.deliverer.deliver(id);
    await f.deliverer.deliver(id);
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`, `${id}-m`]);
  });

  it("an item closed as `closed` (not merged), or merged with another slot id, sends nothing", async () => {
    const f = setup();
    const a = (await f.store.add(prOf(W))).id;
    await patch(f.store, a, (it) => ({ ...closedMerged(it, clock), lastError: "closed" }));
    const b = (await f.store.add({ ...prOf(W), pr: { url: "https://github.com/o/app-shop/pull/13", number: 13 } })).id;
    await patch(f.store, b, (it) => ({ ...closedMerged(it, clock), delivery: { msgId: `${b}-1`, state: "pending", attempts: 0 } }));
    await f.deliverer.deliver(a);
    await f.deliverer.deliver(b);
    expect(f.inputs).toEqual([]);
  });
});

describe("Deliverer slot order", () => {
  it("withdrawal pending + answer pending → the withdrawal line is sent first, the answer on the next call", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await commit(f.store, id, user({ value: "A" }));
    await f.deliverer.deliver(id);
    expect(f.inputs.slice(1)).toEqual([{ agentId: W, msgId: `${id}-w1`, text: withdrawalLine(id) }]);
    let it = await get(f.store, id);
    expect(it.withdrawal).toMatchObject({ state: "delivered", attempts: 1 });
    expect(it.delivery).toEqual({ msgId: `${id}-2`, state: "pending", attempts: 0 });
    await f.deliverer.deliver(id);
    expect(f.inputs.slice(2)).toEqual([{ agentId: W, msgId: `${id}-2`, text: `[queue ${id}] choice: A (Hand-rolled)` }]);
    it = await get(f.store, id);
    expect(it.delivery?.state).toBe("delivered");
  });

  it("withdrawal `failed` → the answer is not sent (answer → undo → re-answer: the new answer waits)", async () => {
    const results: InputResult[] = [OK, { code: 409, body: { reason: "not-live" } }];
    const f = setup({ input: async () => results.shift() ?? OK });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await f.deliverer.deliver(id);
    expect((await get(f.store, id)).withdrawal).toMatchObject({ state: "failed", lastError: "not-live" });
    await commit(f.store, id, user({ value: "A" }));
    await f.deliverer.deliver(id);
    await f.deliverer.deliver(id);
    expect(f.inputs.map((i) => i.msgId)).toEqual([`${id}-1`, `${id}-w1`]);
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-2`, state: "pending", attempts: 0 });
  });

  it("the withdrawal line names the answer it takes back by its seq, not the last history entry", async () => {
    const f = setup({ input: async (_a, m) => (m.msgId.endsWith("-w1") ? { code: 409, body: { reason: "not-live" } } : OK) });
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    await undo(f.store, id, {});
    await f.deliverer.deliver(id); // w1 failed
    await commit(f.store, id, user({ value: "A" })); // waits behind w1
    await undo(f.store, id); // pending → silent, no new withdrawal
    await patch(f.store, id, (it) => ({ ...it, withdrawal: { ...it.withdrawal!, state: "pending" } })); // Resend
    f.inputs.length = 0;
    await f.deliverer.deliver(id);
    expect(f.inputs.map((i) => i.text)).toEqual([withdrawalLine(id, "B")]);
  });
});

describe("Deliverer, fleet master slot", () => {
  it("no master record → `failed` no-master, pushConsole not called", async () => {
    const f = setup({ records: [] });
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    await f.deliverer.deliver(id);
    expect(f.pushes).toEqual([]);
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "failed", lastError: "no-master" });
  });

  it("pushes with msgId, BUSY_TIMEOUT_MS and since = the first try; resolve → `delivered`", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user({ via: "telegram" }));
    const first = clock;
    const p = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    expect(f.pushes[0]).toMatchObject({
      text: answerLine(id), surface: "telegram", opts: { msgId: `${id}-1`, timeoutMs: BUSY_TIMEOUT_MS, since: first },
    });
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "delivering", attempts: 1, at: first });
    clock += 90_000;
    f.pushes[0].resolve();
    await p;
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-1`, state: "delivered", attempts: 1, at: first });
    expect(f.inputs).toEqual([]);
  });

  it("an answer from the tab or the CLI goes on the `tab` surface", async () => {
    const f = setup();
    for (const via of ["tab", "cli"] as const) {
      const { id } = await f.store.add(choice(FLEET_MASTER_ID));
      await commit(f.store, id, user({ via }));
      const p = f.deliverer.deliver(id);
      await vi.waitFor(() => expect(f.pushes.at(-1)?.opts.msgId).toBe(`${id}-1`));
      expect(f.pushes.at(-1)!.surface).toBe("tab");
      f.pushes.at(-1)!.resolve();
      await p;
    }
  });

  it("timeout → `pending`; the re-push keeps `since` from the first push", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const first = clock;
    const p1 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    clock += BUSY_TIMEOUT_MS;
    f.pushes[0].reject(new InboxError("timeout"));
    await p1;
    expect((await get(f.store, id)).delivery).toEqual({ msgId: `${id}-1`, state: "pending", attempts: 1, at: first });
    clock += 5_000;
    const p2 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(2));
    expect(f.pushes[1].opts).toEqual({ msgId: `${id}-1`, timeoutMs: BUSY_TIMEOUT_MS, since: first });
    f.pushes[1].resolve();
    await p2;
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "delivered", attempts: 2, at: first });
  });

  it("a push rejection that is not an InboxError is logged and handled as a timeout (`pending`)", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const p = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    f.pushes[0].reject(new Error("inbox exploded"));
    await p;
    expect((await get(f.store, id)).delivery).toMatchObject({ state: "pending", attempts: 1 });
    expect(f.logs.some((l) => l.includes(`${id}-1`) && l.includes("inbox exploded"))).toBe(true);
  });

  it("a second deliver while the line waits in the inbox pushes nothing (the slot is `delivering`)", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const p = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    await f.deliverer.deliver(id);
    expect(f.pushes).toHaveLength(1);
    f.pushes[0].resolve();
    await p;
  });

  it("a push that resolves after an undo cleared `delivery` releases the waiting withdrawal and writes nothing to `delivery`", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user({ via: "telegram" }));
    const p = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    await undo(f.store, id, { afterMsgId: `${id}-1` }); // cancel said "in-flight"
    await commit(f.store, id, user({ value: "A" }));
    // The withdrawal waits on the in-flight send, and the re-answer waits on it.
    await f.deliverer.deliver(id);
    expect(f.pushes).toHaveLength(1);
    f.pushes[0].resolve();
    await p;
    let it = await get(f.store, id);
    expect(it.withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    expect(it.delivery).toEqual({ msgId: `${id}-2`, state: "pending", attempts: 0 });
    // Now the withdrawal goes, on the undone answer's surface.
    const p2 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(2));
    expect(f.pushes[1]).toMatchObject({ text: withdrawalLine(id), surface: "telegram", opts: { msgId: `${id}-w1` } });
    f.pushes[1].resolve();
    await p2;
    it = await get(f.store, id);
    expect(it.withdrawal?.state).toBe("delivered");
  });

  it("a `cancelled` reject drops the waiting withdrawal and leaves `delivery` cleared", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const p = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    await undo(f.store, id, { afterMsgId: `${id}-1` });
    f.pushes[0].reject(new InboxError("cancelled"));
    await p;
    const it = await get(f.store, id);
    expect(it.withdrawal).toBeUndefined();
    expect(it.delivery).toBeUndefined();
    expect(it.status).toBe("open");
  });

  it("master withdrawal round trip: delivered → undo → `-w1` pushed and resolves → `delivered` → the re-answer is pushed next", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const p1 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    f.pushes[0].resolve();
    await p1;
    await undo(f.store, id, {}); // delivered → withdrawal
    await commit(f.store, id, user({ value: "A" }));
    const p2 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(2));
    expect(f.pushes[1]).toMatchObject({ text: withdrawalLine(id), opts: { msgId: `${id}-w1`, timeoutMs: BUSY_TIMEOUT_MS } });
    f.pushes[1].resolve();
    await p2;
    expect((await get(f.store, id)).withdrawal?.state).toBe("delivered");
    const p3 = f.deliverer.deliver(id);
    await vi.waitFor(() => expect(f.pushes).toHaveLength(3));
    expect(f.pushes[2]).toMatchObject({ text: `[queue ${id}] choice: A (Hand-rolled)`, opts: { msgId: `${id}-2` } });
    f.pushes[2].resolve();
    await p3;
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
  });

  it("an undo queued on the item lock right after a master delivery sees cancel(msgId) return `removed` (real inbox)", async () => {
    const sent: string[] = [];
    const inbox = new MasterInbox({
      hub: new EventHub(), tracker: new InputTracker(() => clock), now: () => clock,
      events: { size: () => 0, digest: () => null, clear: () => {} },
      send: async (t) => { sent.push(t); return true; },
    });
    const f = setup({ inbox });
    const { id } = await f.store.add(choice(FLEET_MASTER_ID));
    await commit(f.store, id, user());
    const d = f.deliverer.deliver(id);
    // The undo of Task 2a-13 queues on the item lock right behind the delivery.
    const u = f.store.withItem(id, async () => {
      const r = inbox.cancel(`${id}-1`);
      await undoLocked(f.store, id, r === "removed" ? undefined : {});
      return r;
    });
    expect(await u).toBe("removed");
    await d;
    const it = await get(f.store, id);
    expect(it.delivery).toBeUndefined();
    expect(it.withdrawal).toBeUndefined();
    expect(inbox.queuedMessages()).toBe(0);
    await inbox.tick(); // idle, no draft, quiet: a queued line would go out now
    expect(sent).toEqual([]);
  });
});

describe("Deliverer deps and kick", () => {
  it("the deps have no acted log (a mark would hide the agent's real status events)", () => {
    expectTypeOf<DelivererDeps>().not.toHaveProperty("acted");
    // No dep can carry an ActedLog, whatever its name.
    type Dep = Exclude<DelivererDeps[keyof DelivererDeps], undefined>;
    expectTypeOf<Extract<Dep, ActedLog>>().toBeNever();
    expectTypeOf<Extract<Dep, { mark: unknown }>>().toBeNever();
  });

  it("kick before start() only marks the id: nothing is delivered", async () => {
    const f = setup();
    const { id } = await f.store.add(choice(W));
    await commit(f.store, id, user());
    f.deliverer.kick(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.inputs).toEqual([]);
    expect((await get(f.store, id)).delivery?.state).toBe("pending");
  });
});

// I3 (final fix wave): a line the formatter refuses (a pr answer that is not exactly approve or
// changes, e.g. a hand-edited file) fails its slot once, with the reason: no paste, no push, no
// rejection out of deliver(), and the 5 s scan does not pick the slot again.
describe("Deliverer, a line the formatter refuses (I3)", () => {
  const pr = (agentId: string): NewItem => {
    const { choice: _c, ...rest } = choice(agentId);
    return { ...rest, kind: "pr", pr: { url: "https://github.com/acme/app-shop/pull/7", number: 7 } };
  };
  for (const who of [W, FLEET_MASTER_ID]) {
    it(`${who === W ? "worker" : "fleet master"} item: the slot is failed with lastError, nothing is sent, a tick does not retry`, async () => {
      const f = setup();
      const { id } = await f.store.add(pr(who));
      await commit(f.store, id, user({ value: "merge" }));
      await expect(f.deliverer.deliver(id)).resolves.toBeUndefined();
      const it1 = await get(f.store, id);
      expect(it1.delivery).toMatchObject({ msgId: `${id}-1`, state: "failed", attempts: 0 });
      expect(it1.delivery?.lastError).toMatch(/pr answer/);
      expect(f.inputs).toEqual([]);
      expect(f.pushes).toEqual([]);
      expect(f.logs.join("\n")).toMatch(new RegExp(`${id}.*pr answer`));
      clock += 10_000;
      await f.deliverer.tick();
      await new Promise((r) => setTimeout(r, 20));
      expect((await get(f.store, id)).delivery).toEqual(it1.delivery);
      expect(f.inputs).toEqual([]);
      expect(f.pushes).toEqual([]);
    });
  }
});
