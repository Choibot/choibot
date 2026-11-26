// server/services/manager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceStore, type ServiceRecord } from "./store.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { createServiceManager, svcTermId } from "./manager.js";

// Minimal fake TerminalManager — records spawn/kill calls; hasSession is scripted.
function fakeTerminals() {
  const spawned: any[] = [];
  const killed: string[] = [];
  const reattached: string[] = [];
  const live = new Set<string>();
  const subs = new Map<string, (chunk: string) => void>();
  let sessions = new Set<string>();
  return {
    api: {
      spawn(o: any) { spawned.push(o); live.add(o.id); },
      kill(id: string) { killed.push(id); live.delete(id); },
      has: (id: string) => live.has(id),
      hasSession: async (id: string) => sessions.has(id),
      // attach()/reattach() return an Attachment whose subscribe lets the manager
      // capture output; tests drive output via emit(id, chunk).
      attach: (id: string) => live.has(id)
        ? { snapshot: "", subscribe: (cb: (c: string) => void) => { subs.set(id, cb); return () => subs.delete(id); } }
        : null,
      reattach: async (id: string) => {
        reattached.push(id);
        return sessions.has(id)
          ? { snapshot: "", subscribe: (cb: (c: string) => void) => { subs.set(id, cb); return () => subs.delete(id); } }
          : null;
      },
    } as any,
    spawned, killed, reattached,
    setSessions: (ids: string[]) => { sessions = new Set(ids); },
    emit: (id: string, chunk: string) => subs.get(id)?.(chunk),
  };
}

// Manual timer scheduler so backoff fires deterministically.
function fakeScheduler() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear() { t.cleared = true; } };
    },
    flush() { for (const t of timers) if (!t.cleared) t.fn(); timers.length = 0; },
    pending: () => timers.filter((t) => !t.cleared).length,
  };
}

function rec(over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: "svc1", name: "Pusher", description: "",
    command: "/run.sh", args: ["a"], cwd: "/cwd", env: { RPC_URL: "x" },
    requiresConfirm: false, confirmMessage: "danger", autoRestart: true, createdAt: 1,
    ...over,
  };
}

describe("ServiceManager", () => {
  let dir: string, store: ServiceStore, hub: EventHub, events: ConsoleEvent[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "svc-mgr-"));
    store = new ServiceStore(dir);
    hub = new EventHub();
    events = [];
    hub.subscribe((e) => events.push(e));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("start() spawns the command under a persisted svc: id", async () => {
    await store.save(rec());
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    const r = await mgr.start("svc1", false);
    expect(r.ok).toBe(true);
    expect(ft.spawned).toHaveLength(1);
    expect(ft.spawned[0]).toMatchObject({
      id: svcTermId("svc1"), command: "/run.sh", args: ["a"], cwd: "/cwd",
      env: { RPC_URL: "x" }, persist: true,
    });
    expect(mgr.snapshot("svc1").status).toBe("running");
  });

  it("start() requires confirmation for a requiresConfirm service", async () => {
    await store.save(rec({ requiresConfirm: true }));
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    const r = await mgr.start("svc1", false);
    expect(r.ok).toBe(false);
    expect(r.needsConfirm).toBe(true);
    expect(ft.spawned).toHaveLength(0);
  });

  it("start() proceeds when confirm is passed", async () => {
    await store.save(rec({ requiresConfirm: true }));
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    expect((await mgr.start("svc1", true)).ok).toBe(true);
    expect(ft.spawned).toHaveLength(1);
  });

  it("start() refuses to double-start a running service", async () => {
    await store.save(rec());
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    await mgr.start("svc1", false);
    const r = await mgr.start("svc1", false);
    expect(r.ok).toBe(false);
    expect(ft.spawned).toHaveLength(1);
  });

  it("stop() kills and prevents auto-restart", async () => {
    await store.save(rec());
    const ft = fakeTerminals();
    const sch = fakeScheduler();
    const mgr = createServiceManager(ft.api, store, hub, { setTimer: sch.setTimer });
    await mgr.start("svc1", false);
    mgr.stop("svc1");
    expect(ft.killed).toContain(svcTermId("svc1"));
    // Exit arriving after an intentional kill must NOT schedule a restart.
    mgr.handleExit(svcTermId("svc1"), 0, true);
    expect(sch.pending()).toBe(0);
    expect(mgr.snapshot("svc1").status).toBe("stopped");
  });

  it("handleExit ignores non-service terminal ids", async () => {
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    expect(mgr.handleExit("shell-123", 0, false)).toBe(false);
  });

  it("auto-restarts with backoff after an unexpected crash", async () => {
    await store.save(rec());
    const ft = fakeTerminals();
    const sch = fakeScheduler();
    const backoff = vi.fn((n: number) => n * 1000);
    const mgr = createServiceManager(ft.api, store, hub, { setTimer: sch.setTimer, backoffMs: backoff });
    await mgr.start("svc1", false);
    expect(mgr.handleExit(svcTermId("svc1"), 1, false)).toBe(true);
    expect(backoff).toHaveBeenCalledWith(1);
    expect(sch.pending()).toBe(1);
    sch.flush();                       // fire the scheduled restart
    expect(ft.spawned).toHaveLength(2); // initial + 1 restart
  });

  it("trips the circuit breaker after maxRestarts in the window", async () => {
    await store.save(rec());
    const ft = fakeTerminals();
    const sch = fakeScheduler();
    let t = 0;
    const mgr = createServiceManager(ft.api, store, hub, {
      setTimer: sch.setTimer, now: () => t,
      breaker: { maxRestarts: 3, windowMs: 1000 },
      backoffMs: () => 0, notify: vi.fn(),
    });
    await mgr.start("svc1", false);
    for (let i = 0; i < 3; i++) { mgr.handleExit(svcTermId("svc1"), 1, false); sch.flush(); }
    // 4th crash within the window trips the breaker — no further restart scheduled.
    mgr.handleExit(svcTermId("svc1"), 1, false);
    expect(sch.pending()).toBe(0);
    const snap = mgr.snapshot("svc1");
    expect(snap.status).toBe("crashed");
    expect(snap.autoRestartDisabled).toBe(true);
  });

  it("does not auto-restart when the record has autoRestart=false", async () => {
    await store.save(rec({ autoRestart: false }));
    const ft = fakeTerminals();
    const sch = fakeScheduler();
    const mgr = createServiceManager(ft.api, store, hub, { setTimer: sch.setTimer });
    await mgr.start("svc1", false);
    mgr.handleExit(svcTermId("svc1"), 1, false);
    expect(sch.pending()).toBe(0);
    expect(mgr.snapshot("svc1").status).toBe("crashed");
  });

  it("captures run output and retains it after a crash (for post-mortem)", async () => {
    await store.save(rec({ autoRestart: false }));
    const ft = fakeTerminals();
    const mgr = createServiceManager(ft.api, store, hub);
    await mgr.start("svc1", false);
    ft.emit(svcTermId("svc1"), "RPC_URL is required\n");
    // The PTY exits (crash); the captured tail must survive the terminal's death.
    mgr.handleExit(svcTermId("svc1"), 1, false);
    expect(mgr.snapshot("svc1").status).toBe("crashed");
    expect(mgr.lastOutput("svc1")).toContain("RPC_URL is required");
  });

  it("reconcile marks a survivor running and a phantom stopped", async () => {
    await store.save(rec({ id: "alive" }));
    await store.save(rec({ id: "dead" }));
    const ft = fakeTerminals();
    ft.setSessions([svcTermId("alive")]);
    const mgr = createServiceManager(ft.api, store, hub);
    await mgr.reconcile();
    expect(mgr.snapshot("alive").status).toBe("running");
    expect(mgr.snapshot("dead").status).toBe("stopped");
    // The survivor must be reattached so its onExit watcher is armed at boot;
    // the phantom must not be.
    expect(ft.reattached).toContain(svcTermId("alive"));
    expect(ft.reattached).not.toContain(svcTermId("dead"));
  });
});
