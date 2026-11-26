import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InputResult } from "../../agents/composer.js";
import { SessionStore, type AgentRecord } from "../../agents/store.js";
import { EventHub } from "../../events.js";
import type { Surface } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { Deliverer } from "./deliver.js";
import { QueueStore, type NewItem } from "./store.js";
import type { Delivery, QueueItem } from "./types.js";

const W = "a1";
const W2 = "a2";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-deliver-boot-"));
  clock = 9_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: agentId === FLEET_MASTER_ID ? "fleet-master" : "worker" },
  repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] },
});
const record = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
});
const OK: InputResult = { code: 200, body: { delivered: true } };

async function setup(o: { input?: () => Promise<InputResult> } = {}) {
  const store = new QueueStore(join(root, "queue"), { now: () => clock, log: () => {} });
  const sessions = new SessionStore(join(root, "agents"));
  for (const id of [W, W2]) await sessions.save(record(id));
  await sessions.save(record(FLEET_MASTER_ID, { kind: "fleet-master" }));
  const hub = new EventHub();
  const inputs: { agentId: string; msgId: string; text: string }[] = [];
  const pushes: { text: string; surface: Surface | null; msgId?: string; resolve: () => void }[] = [];
  const logs: string[] = [];
  const deliverer = new Deliverer({
    store, agents: sessions, rules: { hit: async () => {} }, hub, now: () => clock, undoMs: 600_000, tickMs: 60_000, log: (s) => logs.push(s),
    composer: {
      inputInternal: async (agentId, m) => {
        inputs.push({ agentId, ...m });
        return o.input ? o.input() : OK;
      },
    },
    inbox: {
      pushConsole: (text, surface, opts = {}) =>
        new Promise<void>((resolve) => { pushes.push({ text, surface, msgId: opts.msgId, resolve }); }),
    },
  });
  return { store, sessions, hub, inputs, pushes, logs, deliverer };
}

// An answered item whose answer slot (and optional withdrawal) are as given.
async function seed(s: QueueStore, agentId: string, delivery: Partial<Delivery>, withdrawal?: Partial<Delivery> & { afterMsgId?: string }) {
  const { id } = await s.add(choice(agentId));
  await s.withItem(id, async () => {
    const it = (await s.get(id))!;
    const next: QueueItem = {
      ...it, status: "answered", answerSeq: 2,
      history: [{ value: "B", by: "user", via: "tab", at: clock }],
      answer: { value: "A", by: "user", via: "tab", at: clock },
      delivery: { msgId: `${id}-2`, state: "pending", attempts: 0, ...delivery },
    };
    if (withdrawal) next.withdrawal = { msgId: `${id}-w1`, state: "pending", attempts: 0, ...withdrawal };
    await s.write(next);
  });
  return id;
}
const get = async (s: QueueStore, id: string) => (await s.get(id))!;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Deliverer.bootScan", () => {
  it("a slot left `delivering` → `unknown`, never re-sent (worker answer, master answer, worker withdrawal)", async () => {
    const f = await setup();
    const a = await seed(f.store, W, { state: "delivering", attempts: 1, at: clock - 1_000 });
    const m = await seed(f.store, FLEET_MASTER_ID, { state: "delivering", attempts: 1, at: clock - 1_000 });
    const w = await seed(f.store, W, {}, { state: "delivering", attempts: 1, at: clock - 1_000 });
    await f.deliverer.bootScan([]);
    expect((await get(f.store, a)).delivery).toEqual({ msgId: `${a}-2`, state: "unknown", attempts: 1, at: clock - 1_000 });
    expect((await get(f.store, m)).delivery).toMatchObject({ state: "unknown", attempts: 1 });
    expect((await get(f.store, w)).withdrawal).toMatchObject({ state: "unknown", attempts: 1 });
    expect((await get(f.store, w)).delivery?.state).toBe("pending");
    await f.deliverer.tick();
    await settle();
    expect(f.inputs).toEqual([]);
    expect(f.pushes).toEqual([]);
  });

  it("a withdrawal's afterMsgId is removed, and the withdrawal is then sent (the `absent` case)", async () => {
    const f = await setup();
    const id = await seed(f.store, FLEET_MASTER_ID, { state: "pending" }, { state: "pending", afterMsgId: "gone-1" });
    await f.deliverer.bootScan([]);
    expect((await get(f.store, id)).withdrawal).toEqual({ msgId: `${id}-w1`, state: "pending", attempts: 0 });
    await f.deliverer.tick();
    await vi.waitFor(() => expect(f.pushes).toHaveLength(1));
    expect(f.pushes[0]).toMatchObject({ msgId: `${id}-w1`, text: `[queue ${id}] the earlier answer (B) is withdrawn; wait for the user` });
  });

  it("`pending` and `held` slots stay as they are", async () => {
    const f = await setup();
    const p = await seed(f.store, W, { state: "pending" });
    const h = await seed(f.store, W, { state: "held", deliverAfter: clock + 60_000 });
    const before = [await get(f.store, p), await get(f.store, h)];
    await f.deliverer.bootScan([]);
    expect([await get(f.store, p), await get(f.store, h)]).toEqual(before);
    expect(f.inputs).toEqual([]);
  });

  it("then calls retryAgent for each resumed id only", async () => {
    const f = await setup();
    const resumed = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    const other = await seed(f.store, W2, { state: "failed", lastError: "not-live", attempts: 1 });
    await f.deliverer.bootScan([W]);
    await vi.waitFor(async () => expect((await get(f.store, resumed)).delivery?.state).toBe("delivered"));
    expect((await get(f.store, other)).delivery).toMatchObject({ state: "failed", lastError: "not-live" });
    expect(f.inputs.map((i) => i.agentId)).toEqual([W]);
  });

  it("an item that throws is logged and the scan goes on; bootScan never rejects", async () => {
    const f = await setup();
    const id = await seed(f.store, W, { state: "delivering", attempts: 1 });
    const realGet = f.store.get.bind(f.store);
    let first = true;
    vi.spyOn(f.store, "list").mockImplementation(async () => {
      const ok = (await realGet(id))!;
      return [{ ...ok, id: "q00000000" }, ok];
    });
    vi.spyOn(f.store, "get").mockImplementation(async (x) => {
      if (x === "q00000000" && first) { first = false; throw new Error("EIO"); }
      return realGet(x);
    });
    await expect(f.deliverer.bootScan([])).resolves.toBeUndefined();
    expect(f.logs.some((l) => l.includes("q00000000") && l.includes("EIO"))).toBe(true);
    expect((await get(f.store, id)).delivery?.state).toBe("unknown");
  });

  it("a store.list() that throws is logged; retryAgent still runs for the resumed ids; bootScan resolves", async () => {
    const f = await setup();
    const id = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    const retry = vi.spyOn(f.deliverer, "retryAgent");
    vi.spyOn(f.store, "list").mockRejectedValueOnce(new Error("EMFILE"));
    await expect(f.deliverer.bootScan([W])).resolves.toBeUndefined();
    expect(f.logs.some((l) => l.includes("[queue] boot scan failed") && l.includes("EMFILE"))).toBe(true);
    expect(retry.mock.calls).toEqual([[W]]);
    await f.store.withItem(id, async () => {}); // the delivery the retry started
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
  });
});

describe("Deliverer.retryAgent", () => {
  it("moves that agent's `failed` not-live slots to `pending` and delivers; leaves no-master and other agents alone", async () => {
    const f = await setup();
    const nl = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1, at: clock - 5_000 });
    const nlw = await seed(f.store, W, { state: "pending" }, { state: "failed", lastError: "not-live", attempts: 1 });
    const closed = await seed(f.store, W, { state: "failed", lastError: "agent-closed", attempts: 0 });
    const other = await seed(f.store, W2, { state: "failed", lastError: "not-live", attempts: 1 });
    const nm = await seed(f.store, FLEET_MASTER_ID, { state: "failed", lastError: "no-master", attempts: 0 });
    await f.deliverer.retryAgent(W);
    await vi.waitFor(async () => expect((await get(f.store, nl)).delivery?.state).toBe("delivered"));
    expect((await get(f.store, nl)).delivery).toEqual({ msgId: `${nl}-2`, state: "delivered", attempts: 2, at: clock - 5_000 });
    await vi.waitFor(async () => expect((await get(f.store, nlw)).withdrawal?.state).toBe("delivered"));
    expect((await get(f.store, closed)).delivery).toMatchObject({ state: "failed", lastError: "agent-closed" });
    expect((await get(f.store, other)).delivery).toMatchObject({ state: "failed", lastError: "not-live" });
    await f.deliverer.retryAgent(FLEET_MASTER_ID);
    await settle();
    expect((await get(f.store, nm)).delivery).toMatchObject({ state: "failed", lastError: "no-master" });
    expect(f.pushes).toEqual([]);
  });

  it("a retry that answers 409 starting leaves the slot `pending` for the 5 s tick", async () => {
    const f = await setup({ input: async () => ({ code: 409, body: { reason: "starting" } }) });
    const id = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    await f.deliverer.retryAgent(W);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    await vi.waitFor(async () => expect((await get(f.store, id)).delivery).toMatchObject({ state: "pending", attempts: 2 }));
    expect((await get(f.store, id)).delivery?.lastError).toBeUndefined();
  });
});

describe("Deliverer agent-status subscription", () => {
  // The hub calls subscribers synchronously, so the spy shows at once whether
  // an event started a retry. drain() awaits the retries started so far, then
  // the item lock: a delivery a retry starts queues on that lock before the
  // retry resolves. So every check below is deterministic.
  function watch(f: Awaited<ReturnType<typeof setup>>) {
    const retry = vi.spyOn(f.deliverer, "retryAgent");
    const drain = async (id: string) => {
      await Promise.all(retry.mock.results.map((r) => r.value as Promise<void>));
      await f.store.withItem(id, async () => {});
    };
    return { retry, drain };
  }

  it("an event before start() triggers nothing; after start() an idle event retries that agent only; stop() ends it", async () => {
    const f = await setup();
    const { retry, drain } = watch(f);
    const id = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    f.hub.emitEvent({ type: "agent-status", agentId: W, status: "idle" });
    expect(retry).not.toHaveBeenCalled();
    await drain(id);
    expect((await get(f.store, id)).delivery?.state).toBe("failed");
    const stop = f.deliverer.start();
    f.hub.emitEvent({ type: "agent-status", agentId: W2, status: "idle" }); // another agent: nothing of W moves
    expect(retry.mock.calls).toEqual([[W2]]);
    await drain(id);
    expect((await get(f.store, id)).delivery?.state).toBe("failed");
    f.hub.emitEvent({ type: "agent-status", agentId: W, status: "idle" });
    expect(retry.mock.calls).toEqual([[W2], [W]]);
    await drain(id);
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
    stop();
    const later = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    f.hub.emitEvent({ type: "agent-status", agentId: W, status: "idle" });
    expect(retry).toHaveBeenCalledTimes(2);
    await drain(later);
    expect((await get(f.store, later)).delivery?.state).toBe("failed");
  });

  it("`done`, `error` (the session ended) and `running` retry nothing: a not-live user answer stays `failed`, no inputInternal; `idle` still retries", async () => {
    const f = await setup();
    const { drain } = watch(f);
    const id = await seed(f.store, W, { state: "failed", lastError: "not-live", attempts: 1 });
    const stop = f.deliverer.start();
    for (const status of ["done", "error", "running"] as const) {
      f.hub.emitEvent({ type: "agent-status", agentId: W, status });
      await drain(id);
      expect((await get(f.store, id)).delivery, status).toMatchObject({ state: "failed", lastError: "not-live" });
      expect(f.inputs, status).toEqual([]);
    }
    f.hub.emitEvent({ type: "agent-status", agentId: W, status: "idle" });
    await drain(id);
    expect((await get(f.store, id)).delivery?.state).toBe("delivered");
    expect(f.inputs).toHaveLength(1);
    stop();
  });
});
