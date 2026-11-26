// server/agents/sweep.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type AgentRecord } from "./store.js";
import { sweepDeadAgents, startDeadAgentSweep } from "./sweep.js";

const NOW = 1_000_000;

function rec(id: string, over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id, label: "choibot", repo: "/r", worktree: "/w",
    branch: `agent/${id}`, baseBranch: "master",
    sessionId: null, hookToken: "tok",
    status: "running", createdAt: NOW - 3_600_000, // an hour old: past any grace
    ...over,
  };
}

// Minimal fake TerminalManager: `live` = attached in this process, `sessions` =
// dtach sockets still on disk (reattachable).
function fakeTerminals(live: string[] = [], sessions: string[] = []) {
  return {
    has: (id: string) => live.includes(id),
    hasSession: async (id: string) => sessions.includes(id),
  };
}

describe("sweepDeadAgents", () => {
  let dir: string;
  let store: SessionStore;
  let dead: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sweep-"));
    store = new SessionStore(dir);
    dead = [];
  });
  const onDead = (r: AgentRecord) => { dead.push(r.id); };
  const now = () => NOW;

  it("marks a running agent whose session is gone as error", async () => {
    await store.save(rec("a"));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now });
    expect(marked).toEqual(["a"]);
    expect((await store.load("a"))?.status).toBe("error");
    expect(dead).toEqual(["a"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("marks an idle agent whose session is gone as error", async () => {
    await store.save(rec("a", { status: "idle" }));
    await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now });
    expect((await store.load("a"))?.status).toBe("error");
    await rm(dir, { recursive: true, force: true });
  });

  it("marks a closed agent whose session is gone as done, with no error ping", async () => {
    await store.save(rec("c", { status: "idle", closedAt: NOW - 1000 }));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now });
    expect(marked).toEqual([]);
    expect(dead).toEqual([]);
    expect((await store.load("c"))?.status).toBe("done");
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves an agent attached in this process alone", async () => {
    await store.save(rec("a"));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(["a"]), onDead, now });
    expect(marked).toEqual([]);
    expect((await store.load("a"))?.status).toBe("running");
    expect(dead).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves an agent with a live dtach session alone", async () => {
    await store.save(rec("a"));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals([], ["a"]), onDead, now });
    expect(marked).toEqual([]);
    expect((await store.load("a"))?.status).toBe("running");
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves an agent that waits for a login alone: no error, no ping", async () => {
    await store.save(rec("fleet-master", { status: "idle", kind: "fleet-master" }));
    await store.save(rec("lead-web", { status: "running", kind: "lead" }));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now, waits: (id) => id === "fleet-master" });
    expect(marked).toEqual(["lead-web"]);
    expect((await store.load("fleet-master"))?.status).toBe("idle");
    expect(dead).toEqual(["lead-web"]);
  });

  it("never re-notifies an agent already marked error or done", async () => {
    await store.save(rec("a", { status: "error" }));
    await store.save(rec("b", { status: "done" }));
    const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now });
    expect(marked).toEqual([]);
    expect(dead).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores a record younger than the grace window", async () => {
    // Created 5s ago: the PTY spawn that follows store.save() may not have
    // happened yet, so it is not dead — just being born.
    await store.save(rec("a", { createdAt: NOW - 5_000 }));
    const marked = await sweepDeadAgents({
      store, terminals: fakeTerminals(), onDead, now, graceMs: 30_000,
    });
    expect(marked).toEqual([]);
    expect((await store.load("a"))?.status).toBe("running");
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps sweeping after one record fails to patch", async () => {
    await store.save(rec("boom"));
    await store.save(rec("b"));
    const flaky = {
      list: () => store.list(),
      patch: async (id: string, fields: Partial<AgentRecord>) => {
        if (id === "boom") throw new Error("disk full");
        await store.patch(id, fields);
      },
    };
    const marked = await sweepDeadAgents({ store: flaky, terminals: fakeTerminals(), onDead, now });
    expect(marked).toEqual(["b"]);
    expect((await store.load("b"))?.status).toBe("error");
    await rm(dir, { recursive: true, force: true });
  });

  // A chief relaunch (spec §5.2) kills the PTY on purpose. Between the exit and
  // the respawn the record has no terminal and no session; `skip` keeps the
  // sweep from marking it `error` in that window.
  describe("skip", () => {
    it("leaves an id that skip names at the top alone", async () => {
      await store.save(rec("a"));
      const marked = await sweepDeadAgents({
        store, terminals: fakeTerminals(), onDead, now, skip: (id) => id === "a",
      });
      expect(marked).toEqual([]);
      expect(dead).toEqual([]);
      expect((await store.load("a"))?.status).toBe("running");
      await rm(dir, { recursive: true, force: true });
    });

    it("re-checks skip before the patch: a relaunch that starts during hasSession is not marked", async () => {
      await store.save(rec("a"));
      // false at the top, true from the pre-patch check on: the id entered
      // `relaunching` while hasSession was awaited.
      let calls = 0;
      const skip = () => ++calls > 1;
      const marked = await sweepDeadAgents({ store, terminals: fakeTerminals(), onDead, now, skip });
      expect(calls).toBe(2);
      expect(marked).toEqual([]);
      expect(dead).toEqual([]);
      expect((await store.load("a"))?.status).toBe("running");
      await rm(dir, { recursive: true, force: true });
    });

    it("re-checks has after skip: a respawn tracked during hasSession is not marked", async () => {
      await store.save(rec("a"));
      // The relaunch finished during hasSession: the id left `relaunching`,
      // and the new PTY is tracked.
      let hasCalls = 0;
      const terminals = {
        has: () => ++hasCalls > 1,
        hasSession: async () => false,
      };
      const marked = await sweepDeadAgents({ store, terminals, onDead, now, skip: () => false });
      expect(hasCalls).toBe(2);
      expect(marked).toEqual([]);
      expect(dead).toEqual([]);
      expect((await store.load("a"))?.status).toBe("running");
      await rm(dir, { recursive: true, force: true });
    });

    it("checks skip before has at the pre-patch check", async () => {
      await store.save(rec("a"));
      const order: string[] = [];
      const terminals = {
        has: () => { order.push("has"); return false; },
        hasSession: async () => { order.push("hasSession"); return false; },
      };
      const skip = () => { order.push("skip"); return false; };
      const marked = await sweepDeadAgents({ store, terminals, onDead, now, skip });
      expect(order).toEqual(["skip", "has", "hasSession", "skip", "has"]);
      expect(marked).toEqual(["a"]);
      expect((await store.load("a"))?.status).toBe("error");
      await rm(dir, { recursive: true, force: true });
    });

    it("still marks an id that skip does not name", async () => {
      await store.save(rec("a"));
      await store.save(rec("b"));
      const marked = await sweepDeadAgents({
        store, terminals: fakeTerminals(), onDead, now, skip: (id) => id === "a",
      });
      expect(marked).toEqual(["b"]);
      expect(dead).toEqual(["b"]);
      expect((await store.load("a"))?.status).toBe("running");
      expect((await store.load("b"))?.status).toBe("error");
      await rm(dir, { recursive: true, force: true });
    });
  });
});

// Drives the sweep loop without real time: captures the pending callback so the
// test decides when a tick happens.
function fakeClock() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void) => {
      pending = fn;
      return { clear: () => { pending = null; } };
    },
    pending: () => pending,
    fire: () => { const f = pending; pending = null; f?.(); },
  };
}

describe("startDeadAgentSweep", () => {
  let dir: string;
  let store: SessionStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sweep-loop-"));
    store = new SessionStore(dir);
  });

  it("sweeps on each tick and reschedules itself", async () => {
    await store.save(rec("a"));
    const clock = fakeClock();
    const dead: string[] = [];
    const stop = startDeadAgentSweep({
      store, terminals: fakeTerminals(), onDead: (r) => dead.push(r.id),
      now: () => NOW, setTimer: clock.setTimer,
    });

    clock.fire();
    await vi.waitFor(() => expect(dead).toEqual(["a"]));
    // The next tick is armed only after the previous one finished — ticks
    // can never overlap.
    await vi.waitFor(() => expect(clock.pending()).not.toBeNull());

    await store.save(rec("b"));
    clock.fire();
    await vi.waitFor(() => expect(dead).toEqual(["a", "b"]));

    stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("stop() cancels the pending tick", async () => {
    await store.save(rec("a"));
    const clock = fakeClock();
    const dead: string[] = [];
    const stop = startDeadAgentSweep({
      store, terminals: fakeTerminals(), onDead: (r) => dead.push(r.id),
      now: () => NOW, setTimer: clock.setTimer,
    });

    stop();
    expect(clock.pending()).toBeNull();
    clock.fire();
    expect(dead).toEqual([]);
    expect((await store.load("a"))?.status).toBe("running");
    await rm(dir, { recursive: true, force: true });
  });
});
