// server/chief/relaunch.retry.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { FLEET_MASTER_ID } from "../master/paths.js";
import { CHIEF_PROMPT_REV } from "./paths.js";
import { IDLE_RETRY_MS, OUTPUT_QUIET_MS, RETRY_MS, RelaunchRetry, bootRelaunch, type RelaunchOutcome, type RelaunchResult } from "./relaunch.js";

const rec = (id: string, chiefRev?: number): AgentRecord => ({
  id, label: id, repo: "r", worktree: `/ws/r/.agent-worktrees/${id}`, branch: "b", baseBranch: "main",
  sessionId: `s-${id}`, hookToken: `tok-${id}`, status: "idle", createdAt: 1,
  ...(chiefRev === undefined ? {} : { chiefRev }),
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function storeWith(recs: AgentRecord[]): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "chief-relaunch-retry-"));
  dirs.push(dir);
  const store = new SessionStore(dir);
  for (const r of recs) await store.save(r);
  return store;
}

// A relaunch fake that answers from a per-id script (default "relaunched")
// and, like the real resume, gives a relaunched record the current chiefRev.
function bootDeps(store: SessionStore, answers: Record<string, RelaunchOutcome> = {}) {
  const calls: string[] = [];
  const armed: string[] = [];
  return {
    calls, armed,
    d: {
      store,
      relaunch: async (id: string) => {
        calls.push(id);
        const outcome = answers[id] ?? "relaunched";
        if (outcome === "relaunched") await store.patch(id, { chiefRev: CHIEF_PROMPT_REV });
        return { outcome };
      },
      retry: { arm: (id: string) => { armed.push(id); } },
    },
  };
}

describe("bootRelaunch", () => {
  it("relaunches only the alive records whose chiefRev is not current, the fleet master first", async () => {
    const store = await storeWith([rec("w1"), rec(FLEET_MASTER_ID, 0), rec("w2", CHIEF_PROMPT_REV)]);
    const { d, calls } = bootDeps(store);
    expect(await bootRelaunch(["w1", FLEET_MASTER_ID, "w2"], d)).toEqual([FLEET_MASTER_ID, "w1"]);
    expect(calls).toEqual([FLEET_MASTER_ID, "w1"]);
  });

  it("relaunches a record with a newer chiefRev (after a rollback)", async () => {
    const store = await storeWith([rec("w1", CHIEF_PROMPT_REV + 1)]);
    const { d, calls } = bootDeps(store);
    expect(await bootRelaunch(["w1"], d)).toEqual(["w1"]);
    expect(calls).toEqual(["w1"]);
  });

  it("relaunches nothing when every record is current", async () => {
    const store = await storeWith([rec(FLEET_MASTER_ID, CHIEF_PROMPT_REV), rec("w1", CHIEF_PROMPT_REV)]);
    const { d, calls } = bootDeps(store);
    expect(await bootRelaunch([FLEET_MASTER_ID, "w1"], d)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("relaunches nothing on a second boot", async () => {
    const store = await storeWith([rec("w1"), rec(FLEET_MASTER_ID, 0)]);
    const first = bootDeps(store);
    expect(await bootRelaunch(["w1", FLEET_MASTER_ID], first.d)).toEqual([FLEET_MASTER_ID, "w1"]);
    const second = bootDeps(store);
    expect(await bootRelaunch(["w1", FLEET_MASTER_ID], second.d)).toEqual([]);
    expect(second.calls).toEqual([]);
  });

  it("skips an alive id that has no record", async () => {
    const store = await storeWith([rec("w1")]);
    const { d, calls } = bootDeps(store);
    expect(await bootRelaunch(["gone", "w1"], d)).toEqual(["w1"]);
    expect(calls).toEqual(["w1"]);
  });

  it("arms the idle retry only for the ids that answered retry-on-idle", async () => {
    const store = await storeWith([rec(FLEET_MASTER_ID), rec("w1"), rec("w2"), rec("w3")]);
    const { d, armed } = bootDeps(store, { [FLEET_MASTER_ID]: "retry-on-idle", w2: "retry-on-idle", w3: "cannot-resume" });
    expect(await bootRelaunch(["w1", "w2", "w3", FLEET_MASTER_ID], d)).toEqual([FLEET_MASTER_ID, "w1", "w2", "w3"]);
    expect(armed).toEqual([FLEET_MASTER_ID, "w2"]);
  });

  it("runs the relaunches one by one", async () => {
    const store = await storeWith([rec(FLEET_MASTER_ID), rec("w1")]);
    const gate = deferred<{ outcome: RelaunchOutcome }>();
    const calls: string[] = [];
    const done = bootRelaunch([FLEET_MASTER_ID, "w1"], {
      store,
      relaunch: (id) => { calls.push(id); return id === FLEET_MASTER_ID ? gate.promise : Promise.resolve({ outcome: "relaunched" }); },
      retry: { arm: () => {} },
    });
    await vi.waitFor(() => expect(calls).toEqual([FLEET_MASTER_ID]));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([FLEET_MASTER_ID]);
    gate.resolve({ outcome: "relaunched" });
    expect(await done).toEqual([FLEET_MASTER_ID, "w1"]);
    expect(calls).toEqual([FLEET_MASTER_ID, "w1"]);
  });

  it("logs the error of a failed outcome and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await storeWith([rec(FLEET_MASTER_ID), rec("w1")]);
    const armed: string[] = [];
    const tried = await bootRelaunch([FLEET_MASTER_ID, "w1"], {
      store,
      relaunch: async (id) => (id === FLEET_MASTER_ID
        ? { outcome: "failed", error: "the running session did not end" }
        : { outcome: "relaunched" }),
      retry: { arm: (id) => { armed.push(id); } },
    });
    expect(tried).toEqual([FLEET_MASTER_ID, "w1"]);
    expect(armed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[chief] boot relaunch ${FLEET_MASTER_ID} failed:`, "the running session did not end");
  });

  it("goes on with the next id when a relaunch rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = await storeWith([rec(FLEET_MASTER_ID), rec("w1")]);
    const calls: string[] = [];
    const armed: string[] = [];
    const tried = await bootRelaunch([FLEET_MASTER_ID, "w1"], {
      store,
      relaunch: async (id) => {
        calls.push(id);
        if (id === FLEET_MASTER_ID) throw new Error("boom");
        return { outcome: "relaunched" };
      },
      retry: { arm: (id) => { armed.push(id); } },
    });
    expect(tried).toEqual([FLEET_MASTER_ID, "w1"]);
    expect(calls).toEqual([FLEET_MASTER_ID, "w1"]);
    expect(armed).toEqual([]);
    expect(warn).toHaveBeenCalledWith(`[chief] boot relaunch ${FLEET_MASTER_ID} failed:`, "boom");
  });
});

// A manual one-shot timer seam: tick() fires the newest live sweep timer
// (RETRY_MS); quiet() fires every live idle-retry timer (IDLE_RETRY_MS), as
// when the quiet window after an idle event has passed.
function fakeTimers() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => { t.cleared = true; } };
    },
    live: () => timers.filter((t) => !t.cleared),
    tick() {
      const t = timers.filter((x) => !x.cleared && x.ms === RETRY_MS).at(-1);
      if (!t) throw new Error("no live timer");
      t.cleared = true;
      t.fn();
    },
    quiet() {
      for (const t of timers.filter((x) => !x.cleared && x.ms === IDLE_RETRY_MS)) {
        t.cleared = true;
        t.fn();
      }
    },
  };
}

type Call = { id: string; force?: boolean };

// relaunch answers each call from a queue of outcomes per id (default
// "retry-on-idle"); `hold` makes the next call for an id wait on a deferred.
function retrySetup() {
  const hub = new EventHub();
  const t = fakeTimers();
  const calls: Call[] = [];
  const answers = new Map<string, RelaunchOutcome[]>();
  const holds = new Map<string, ReturnType<typeof deferred<RelaunchResult>>>();
  const retry = new RelaunchRetry({
    hub,
    setTimer: t.setTimer,
    relaunch: (id, o) => {
      calls.push({ id, ...(o?.force === undefined ? {} : { force: o.force }) });
      const held = holds.get(id);
      if (held) { holds.delete(id); return held.promise; }
      return Promise.resolve({ outcome: answers.get(id)?.shift() ?? "retry-on-idle" });
    },
  });
  const answer = (id: string, ...o: RelaunchOutcome[]) => { answers.set(id, o); };
  const hold = (id: string) => { const d = deferred<RelaunchResult>(); holds.set(id, d); return d; };
  // An idle event only; idle() is an idle event and then its quiet window.
  const idleEvent = (agentId: string) => hub.emitEvent({ type: "agent-status", agentId, status: "idle" });
  const idle = (agentId: string) => { idleEvent(agentId); t.quiet(); };
  return { hub, t, calls, retry, answer, hold, idle, idleEvent };
}

describe("RelaunchRetry", () => {
  it("retries an armed id once on its idle event, stays armed on retry-on-idle and disarms on relaunched", async () => {
    const { retry, calls, answer, idle } = retrySetup();
    retry.start();
    retry.arm("w1");
    expect(retry.armed()).toEqual(["w1"]);
    answer("w1", "retry-on-idle", "relaunched");
    idle("w1");
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }]);
    expect(retry.armed()).toEqual(["w1"]);
    idle("w1");
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }, { id: "w1", force: false }]);
    expect(retry.armed()).toEqual([]);
    idle("w1");
    await flush();
    expect(calls).toHaveLength(2);
  });

  it.each<RelaunchOutcome>(["not-needed", "cannot-resume", "gone", "failed"])("disarms on %s", async (outcome) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { retry, answer, idle } = retrySetup();
    retry.start();
    retry.arm("w1");
    answer("w1", outcome);
    idle("w1");
    await flush();
    expect(retry.armed()).toEqual([]);
  });

  it("logs the error of a failed outcome and disarms", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { retry, idle, hold } = retrySetup();
    retry.start();
    retry.arm("w1");
    hold("w1").resolve({ outcome: "failed", error: "the running session did not end" });
    idle("w1");
    await flush();
    expect(retry.armed()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[chief] relaunch retry w1 failed:", "the running session did not end");
  });

  it("keeps force when a later arm has none", async () => {
    const { retry, calls, idle } = retrySetup();
    retry.start();
    retry.arm("w1", { force: true });
    retry.arm("w1");
    idle("w1");
    await flush();
    expect(calls).toEqual([{ id: "w1", force: true }]);
  });

  it("ignores an idle event for an unarmed id and a non-idle event for an armed id", async () => {
    const { retry, calls, hub, idle } = retrySetup();
    retry.start();
    retry.arm("w1");
    idle("w2");
    hub.emitEvent({ type: "agent-status", agentId: "w1", status: "running" });
    await flush();
    expect(calls).toEqual([]);
  });

  it("retries every armed id on each timer tick of RETRY_MS", async () => {
    const { retry, calls, answer, t } = retrySetup();
    retry.start();
    expect(t.live().map((x) => x.ms)).toEqual([RETRY_MS]);
    expect(RETRY_MS).toBe(60_000);
    t.tick();
    await flush();
    expect(calls).toEqual([]);
    retry.arm("w1");
    retry.arm("w2");
    answer("w2", "relaunched");
    t.tick();
    await flush();
    expect(calls.map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(retry.armed()).toEqual(["w1"]);
    t.tick();
    await flush();
    expect(calls.map((c) => c.id)).toEqual(["w1", "w2", "w1"]);
    expect(t.live()).toHaveLength(1);
  });

  it("on a tick relaunches the fleet master first, then the others one by one", async () => {
    const { retry, calls, t, hold } = retrySetup();
    retry.start();
    retry.arm("w1");
    retry.arm(FLEET_MASTER_ID);
    const master = hold(FLEET_MASTER_ID);
    t.tick();
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID]);
    master.resolve({ outcome: "relaunched" });
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID, "w1"]);
  });

  it("a tick while an earlier tick's run is still going starts no second run", async () => {
    const { retry, calls, t, hold } = retrySetup();
    retry.start();
    retry.arm(FLEET_MASTER_ID);
    retry.arm("w1");
    const master = hold(FLEET_MASTER_ID);
    t.tick();
    await flush();
    t.tick();
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID]);
    master.resolve({ outcome: "retry-on-idle" });
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID, "w1"]);
    t.tick();
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID, "w1", FLEET_MASTER_ID, "w1"]);
    expect(t.live()).toHaveLength(1);
  });

  it("stop during a tick's run starts no further relaunch", async () => {
    const { retry, calls, t, hold } = retrySetup();
    const stop = retry.start();
    retry.arm(FLEET_MASTER_ID);
    retry.arm("w1");
    const master = hold(FLEET_MASTER_ID);
    t.tick();
    await flush();
    stop();
    master.resolve({ outcome: "relaunched" });
    await flush();
    expect(calls.map((c) => c.id)).toEqual([FLEET_MASTER_ID]);
  });

  it("keeps force for the retries", async () => {
    const { retry, calls, idle, t } = retrySetup();
    retry.start();
    retry.arm("w1", { force: true });
    idle("w1");
    await flush();
    t.tick();
    await flush();
    expect(calls).toEqual([{ id: "w1", force: true }, { id: "w1", force: true }]);
  });

  it("never runs two relaunches of one id at once", async () => {
    const { retry, calls, idle, t, hold, answer } = retrySetup();
    retry.start();
    retry.arm("w1");
    const first = hold("w1");
    idle("w1");
    t.tick();
    idle("w1");
    await flush();
    expect(calls).toHaveLength(1);
    first.resolve({ outcome: "retry-on-idle" });
    await flush();
    answer("w1", "relaunched");
    idle("w1");
    await flush();
    expect(calls).toHaveLength(2);
    expect(retry.armed()).toEqual([]);
  });

  it("keeps an arm that came while a try was in flight", async () => {
    const { retry, idle, hold } = retrySetup();
    retry.start();
    retry.arm("w1");
    const first = hold("w1");
    idle("w1");
    await flush();
    retry.arm("w1", { force: true });
    first.resolve({ outcome: "not-needed" });
    await flush();
    expect(retry.armed()).toEqual(["w1"]);
  });

  it("logs and disarms a relaunch that rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { retry, idle, hold } = retrySetup();
    retry.start();
    retry.arm("w1");
    const first = hold("w1");
    idle("w1");
    first.reject(new Error("boom"));
    await flush();
    expect(retry.armed()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[chief] relaunch retry w1 failed:", "boom");
  });

  it("stop ends the subscription and the timer", async () => {
    const { retry, calls, idle, t } = retrySetup();
    const stop = retry.start();
    retry.arm("w1");
    stop();
    idle("w1");
    await flush();
    expect(calls).toEqual([]);
    expect(t.live()).toEqual([]);
  });

  it("uses a 60 s timer by default", async () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    const calls: string[] = [];
    const retry = new RelaunchRetry({ hub, relaunch: async (id) => { calls.push(id); return { outcome: "retry-on-idle" }; } });
    const stop = retry.start();
    retry.arm("w1");
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["w1"]);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toEqual(["w1", "w1"]);
    stop();
  });
});

// An idle event comes right after the agent's last output, so a try at once
// always meets the output guard (OUTPUT_QUIET_MS) and answers retry-on-idle.
// The try waits until the output window has passed.
describe("RelaunchRetry: the try after an idle event waits for the output quiet window", () => {
  it("waits OUTPUT_QUIET_MS + 1 s", () => {
    expect(IDLE_RETRY_MS).toBe(OUTPUT_QUIET_MS + 1_000);
  });

  it("an idle event does not relaunch at once; the relaunch comes when the quiet window has passed", async () => {
    const { retry, calls, t, idleEvent } = retrySetup();
    retry.start();
    retry.arm("w1");
    idleEvent("w1");
    await flush();
    expect(calls).toEqual([]);
    expect(t.live().map((x) => x.ms).sort()).toEqual([IDLE_RETRY_MS, RETRY_MS].sort());
    t.quiet();
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }]);
  });

  it("with the default timer: no relaunch at IDLE_RETRY_MS - 1, one at IDLE_RETRY_MS", async () => {
    vi.useFakeTimers();
    const hub = new EventHub();
    const calls: string[] = [];
    const retry = new RelaunchRetry({ hub, relaunch: async (id) => { calls.push(id); return { outcome: "relaunched" }; } });
    const stop = retry.start();
    retry.arm("w1");
    hub.emitEvent({ type: "agent-status", agentId: "w1", status: "idle" });
    await vi.advanceTimersByTimeAsync(IDLE_RETRY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["w1"]);
    stop();
  });

  it("two idle events in a row give one relaunch: the newer one replaces the pending try", async () => {
    const { retry, calls, t, idleEvent } = retrySetup();
    retry.start();
    retry.arm("w1");
    idleEvent("w1");
    idleEvent("w1");
    expect(t.live().filter((x) => x.ms === IDLE_RETRY_MS)).toHaveLength(1);
    t.quiet();
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }]);
  });

  it("keeps one pending try per id", async () => {
    const { retry, calls, t, idleEvent } = retrySetup();
    retry.start();
    retry.arm("w1");
    retry.arm("w2");
    idleEvent("w1");
    idleEvent("w2");
    expect(t.live().filter((x) => x.ms === IDLE_RETRY_MS)).toHaveLength(2);
    t.quiet();
    await flush();
    expect(calls.map((c) => c.id)).toEqual(["w1", "w2"]);
  });

  it("an idle event for an unarmed id schedules nothing", async () => {
    const { retry, t, idleEvent } = retrySetup();
    retry.start();
    idleEvent("w1");
    expect(t.live().map((x) => x.ms)).toEqual([RETRY_MS]);
  });

  it("stop() cancels a pending try", async () => {
    const { retry, calls, t, idleEvent } = retrySetup();
    const stop = retry.start();
    retry.arm("w1");
    idleEvent("w1");
    const pending = t.live().filter((x) => x.ms === IDLE_RETRY_MS);
    expect(pending).toHaveLength(1);
    stop();
    expect(t.live()).toEqual([]);
    pending[0]!.fn(); // a timer that fires anyway after its clear
    await flush();
    expect(calls).toEqual([]);
  });

  it("an id disarmed while its try is pending is skipped", async () => {
    const { retry, calls, t, answer, idleEvent } = retrySetup();
    retry.start();
    retry.arm("w1");
    answer("w1", "relaunched");
    idleEvent("w1");
    t.tick(); // the sweep relaunches it first and disarms it
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }]);
    expect(retry.armed()).toEqual([]);
    t.quiet();
    await flush();
    expect(calls).toEqual([{ id: "w1", force: false }]);
  });
});
