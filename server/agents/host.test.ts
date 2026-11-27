// server/agents/host.test.ts — the seam of the hosts: with no host registered every path calls
// the terminal (the tests of each path); an agent that another host owns goes to that host.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addHost, hostOf, type AgentHost } from "./host.js";
import { typeIntoAgentWhy } from "../issues/reply.js";
import { ComposerGate } from "./composer.js";
import { sweepDeadAgents } from "./sweep.js";
import { resumeAgent, waitUntilGone, type RecoveryCtx } from "./recovery.js";
import { SessionStore, type AgentRecord } from "./store.js";

// A host that owns `owned`; `live` = the programs that it holds now.
function fakeHost(owned: string[], live: string[] = []) {
  const sent: [string, string][] = [];
  const killed: string[] = [];
  const held = new Set(live);
  const host: AgentHost = {
    owns: (id) => owned.includes(id),
    has: (id) => held.has(id),
    hasSession: async () => false,
    reattach: async () => false,
    inputReady: (id) => held.has(id),
    kill: (id) => { killed.push(id); held.delete(id); },
    send: async (id, text) => {
      if (!held.has(id)) return "not-live";
      sent.push([id, text]);
      return "sent";
    },
  };
  return { host, sent, killed };
}

// A terminal set that fails the test when a path calls it for an agent that another host owns.
function noTerminal() {
  const calls: string[] = [];
  const t = (name: string) => (id: string) => { calls.push(`${name} ${id}`); throw new Error(`terminal ${name} called`); };
  return {
    calls,
    has: t("has") as (id: string) => boolean,
    hasSession: t("hasSession") as (id: string) => Promise<boolean>,
    reattach: t("reattach") as (id: string) => Promise<unknown>,
    write: (id: string) => { calls.push(`write ${id}`); },
    inputReady: t("inputReady") as (id: string) => boolean,
    kill: t("kill") as (id: string) => void,
    spawn: t("spawn"),
  };
}

let remove: (() => void) | null = null;
afterEach(() => { remove?.(); remove = null; });

describe("hostOf", () => {
  it("is null with no host: the terminal holds every agent", () => {
    expect(hostOf("a1")).toBeNull();
  });

  it("answers the host that owns the agent, and null again after its removal", () => {
    const { host } = fakeHost(["a1"]);
    remove = addHost(host);
    expect(hostOf("a1")).toBe(host);
    expect(hostOf("a2")).toBeNull();
    remove();
    remove = null;
    expect(hostOf("a1")).toBeNull();
  });
});

describe("an agent that another host owns", () => {
  it("typeIntoAgentWhy sends the line to the host, and writes nothing to the terminal", async () => {
    const f = fakeHost(["a1"], ["a1"]);
    remove = addHost(f.host);
    const terms = noTerminal();
    expect(await typeIntoAgentWhy(terms, "a1", "hello\nthere", async () => {})).toBe("sent");
    expect(f.sent).toEqual([["a1", "hello\nthere"]]);
    expect(terms.calls).toEqual([]);
    expect(await typeIntoAgentWhy(terms, "a2-not-owned", "x", async () => {}).catch(() => "terminal")).toBe("terminal");
  });

  it("the composer delivers through the host; a host with no live program gives not-live", async () => {
    const f = fakeHost(["a1", "a2"], ["a1"]);
    remove = addHost(f.host);
    const terms = noTerminal();
    const gate = new ComposerGate({ terminals: terms, agentExists: async () => true, sleep: async () => {} });
    expect(await gate.input("a1", { msgId: "msg-00001", text: "hi" })).toEqual({ code: 200, body: { delivered: true } });
    expect(await gate.input("a2", { msgId: "msg-00002", text: "hi" })).toEqual({ code: 409, body: { reason: "not-live" } });
    expect(f.sent).toEqual([["a1", "hi"]]);
    expect(terms.calls).toEqual([]);
  });

  it("resumeAgent answers alive for a program that the host holds, and starts nothing", async () => {
    const f = fakeHost(["a1"], ["a1"]);
    remove = addHost(f.host);
    const terms = noTerminal();
    const ctx = { terminals: terms } as unknown as RecoveryCtx;
    expect(await resumeAgent({ id: "a1" } as AgentRecord, ctx)).toBe("alive");
    expect(terms.calls).toEqual([]);
  });

  it("waitUntilGone asks the host that it gets", async () => {
    const f = fakeHost(["a1"], ["a1"]);
    f.host.kill("a1");
    expect(await waitUntilGone(f.host, "a1", 500)).toBe(true);
  });

  describe("the sweep", () => {
    const NOW = 1_000_000;
    let dir: string;
    let store: SessionStore;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "host-sweep-"));
      store = new SessionStore(dir);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const rec = (id: string): AgentRecord => ({
      id, label: "x", repo: "/r", worktree: "/w", branch: `agent/${id}`, baseBranch: "main",
      sessionId: null, hookToken: "tok", status: "running", createdAt: NOW - 3_600_000,
    });

    it("leaves a program that the host holds, and marks one that it does not hold", async () => {
      const f = fakeHost(["a1", "a2"], ["a1"]);
      remove = addHost(f.host);
      await store.save(rec("a1"));
      await store.save(rec("a2"));
      const dead: string[] = [];
      const marked = await sweepDeadAgents({ store, terminals: noTerminal(), onDead: (r) => dead.push(r.id), now: () => NOW });
      expect(marked).toEqual(["a2"]);
      expect((await store.load("a1"))?.status).toBe("running");
      expect((await store.load("a2"))?.status).toBe("error");
    });
  });
});
