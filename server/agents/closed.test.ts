// server/agents/closed.test.ts
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAgent, purgeClosedAgents, reopenIfClosed, resumeClosedWithPrompt, CLOSED_TTL_MS } from "./closed.js";
import { registerAgentApi } from "./api.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub } from "../events.js";
import { claudeTranscriptPath } from "./runtimes/claude.js";

const rec = (id: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "", worktree: "/tmp/none", branch: "", baseBranch: "",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...extra,
});

describe("purgeClosedAgents", () => {
  it("deletes only agents closed longer than the TTL", async () => {
    const now = 10 * CLOSED_TTL_MS;
    const list = async () => [
      rec("open"),
      rec("fresh", { closedAt: now - CLOSED_TTL_MS + 1000 }),
      rec("old", { closedAt: now - CLOSED_TTL_MS - 1000 }),
    ];
    const remove = vi.fn(async () => {});
    expect(await purgeClosedAgents({ store: { list }, remove, now: () => now })).toEqual(["old"]);
    expect(remove).toHaveBeenCalledWith("old");
  });

  it("one failing delete does not stop the pass", async () => {
    const list = async () => [rec("a", { closedAt: 0 }), rec("b", { closedAt: 0 })];
    const remove = vi.fn(async (id: string) => { if (id === "a") throw new Error("boom"); });
    expect(await purgeClosedAgents({ store: { list }, remove, now: () => CLOSED_TTL_MS * 2 })).toEqual(["b"]);
  });
});

describe("purgeClosedAgents with reminders (chief on: the reminderHolds dep)", () => {
  const now = 10 * CLOSED_TTL_MS;
  const DAY = 24 * 3600 * 1000;
  const run = async (holds: Record<string, "open" | number>, recs: AgentRecord[]) => {
    const remove = vi.fn(async () => {});
    const purged = await purgeClosedAgents({
      store: { list: async () => recs }, remove, now: () => now,
      reminderHolds: async () => new Map(Object.entries(holds)),
    });
    return { purged, remove };
  };

  it("never purges a closed agent with an open (or delivering) reminder, however long closed", async () => {
    const { purged, remove } = await run({ held: "open" }, [rec("held", { closedAt: 0 }), rec("free", { closedAt: 0 })]);
    expect(purged).toEqual(["free"]);
    expect(remove).not.toHaveBeenCalledWith("held");
  });

  it("purges it CLOSED_TTL_MS after the later of its close and its last reminder's settle time", async () => {
    const { purged } = await run(
      { recent: now - 2 * DAY, settledOld: now - 30 * DAY, settledDue: now - CLOSED_TTL_MS - 1000 },
      [
        rec("recent", { closedAt: now - 20 * DAY }), // cancelled 2 days ago: kept
        rec("settledOld", { closedAt: now - 8 * DAY }), // settled before the close: closedAt counts
        rec("settledDue", { closedAt: now - 20 * DAY }), // settled 7+ days ago: purged
        rec("none", { closedAt: now - 8 * DAY }), // no reminder: closedAt only
        rec("fresh", { closedAt: now - DAY }),
      ],
    );
    expect(purged).toEqual(["settledOld", "settledDue", "none"]);
  });

  it("a reminder lookup that throws purges nothing", async () => {
    const remove = vi.fn(async () => {});
    await expect(purgeClosedAgents({
      store: { list: async () => [rec("old", { closedAt: 0 })] }, remove, now: () => now,
      reminderHolds: async () => { throw new Error("reminders.json is not JSON"); },
    })).rejects.toThrow(/not JSON/);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("leads are persistent (never purged, closed or resumed)", () => {
  it("purgeClosedAgents never deletes a lead closed 8 days ago", async () => {
    const now = 20 * CLOSED_TTL_MS;
    const list = async () => [rec("lead-app-shop", { kind: "lead", closedAt: now - 8 * 24 * 3600 * 1000 })];
    const remove = vi.fn(async () => {});
    expect(await purgeClosedAgents({ store: { list }, remove, now: () => now })).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });
  it("closeAgent refuses a lead with master", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "lead-close-")));
    await store.save(rec("lead-app-shop", { kind: "lead" }));
    const kill = vi.fn();
    expect(await closeAgent({ store, kill, emit: () => {} } as any, "lead-app-shop")).toBe("master");
    expect(kill).not.toHaveBeenCalled();
    expect((await store.load("lead-app-shop"))?.closedAt).toBeUndefined();
  });
  it("resumeClosedWithPrompt on a lead is false", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "lead-resume-")));
    await store.save(rec("lead-app-shop", { kind: "lead", closedAt: 5, status: "done" }));
    const resume = vi.fn(async () => "resumed" as const);
    expect(await resumeClosedWithPrompt({ store, emit: () => {}, isLive: async () => false, resume } as any, "lead-app-shop", "hi")).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("close / reopen / order routes", () => {
  // A fake TerminalManager that records kills and spawns. Nothing is live.
  function fakeTerminals() {
    const killed: string[] = [];
    const spawned: { id: string; cwd: string; args: string[] }[] = [];
    const t = {
      kill: (id: string) => { killed.push(id); },
      has: () => false, hasSession: async () => false, reattach: async () => null,
      spawn: (o: { id: string; cwd: string; args: string[] }) => { spawned.push(o); },
      write() {}, resize() {}, attach: () => null,
    };
    return { t, killed, spawned };
  }
  async function setup() {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "closed-")));
    const app = Fastify();
    const hub = new EventHub();
    const events: any[] = [];
    hub.subscribe((e) => events.push(e));
    const terms = fakeTerminals();
    const api = registerAgentApi(app, { terminals: terms.t as any, store, hub, workspaceDir: "/tmp" });
    return { store, app, api, events, ...terms };
  }

  it("close stops the session for real and keeps the record, worktree and sessionId", async () => {
    const { store, app, killed, events } = await setup();
    await store.save(rec("x", { status: "idle", sessionId: "sess-x", repo: "/r", worktree: "/w/x", branch: "agent/x" }));
    expect((await app.inject({ method: "POST", url: "/api/agents/x/close" })).statusCode).toBe(202);
    expect(killed).toEqual(["x"]);
    const r = await store.load("x");
    expect(r?.closedAt).toBeTypeOf("number");
    expect(r?.status).toBe("done");
    expect(r).toMatchObject({ sessionId: "sess-x", worktree: "/w/x", branch: "agent/x" });
    expect(events).toContainEqual({ type: "agent-status", agentId: "x", status: "done" });
    expect((await app.inject({ method: "POST", url: "/api/agents/nope/close" })).statusCode).toBe(404);
  });

  it("never closes or stops the fleet master or a lead", async () => {
    const { store, app, killed } = await setup();
    await store.save(rec("fleet-master", { kind: "fleet-master", status: "idle" }));
    await store.save(rec("lead-app-shop", { kind: "lead", status: "idle" }));
    for (const id of ["fleet-master", "lead-app-shop"]) {
      expect((await app.inject({ method: "POST", url: `/api/agents/${id}/close` })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/agents/${id}/stop` })).statusCode).toBe(400);
      const r = await store.load(id);
      expect(r?.closedAt).toBeUndefined();
      expect(r?.status).toBe("idle");
    }
    expect(killed).toEqual([]);
  });

  it("reopen resumes the same Claude session in the worktree and moves the agent back", async () => {
    const cfg = await mkdtemp(join(tmpdir(), "closed-cfg-"));
    const worktree = await mkdtemp(join(tmpdir(), "closed-wt-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      // The transcript survives the stop, so the relaunch is `claude --resume`.
      const tp = claudeTranscriptPath(worktree, "sess-r", join(cfg, "projects"));
      await mkdir(join(tp, ".."), { recursive: true });
      await writeFile(tp, "{}\n");
      const { store, app, events, spawned } = await setup();
      await store.save(rec("r", { repo: "/r", worktree, cwd: worktree, sessionId: "sess-r", status: "done", closedAt: 5 }));
      const res = await app.inject({ method: "POST", url: "/api/agents/r/reopen" });
      expect(res.statusCode).toBe(202);
      expect(res.json().outcome).toBe("resumed");
      expect(spawned).toHaveLength(1);
      expect(spawned[0].cwd).toBe(worktree);
      const i = spawned[0].args.indexOf("--resume");
      expect(spawned[0].args[i + 1]).toBe("sess-r");
      const r = await store.load("r");
      expect(r?.closedAt).toBeUndefined();
      expect(r?.sessionId).toBe("sess-r");
      expect(events).toContainEqual({ type: "agent-reopened", agentId: "r" });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });

  it("order sets the list order; unordered agents follow by createdAt", async () => {
    const { store, app } = await setup();
    await store.save(rec("a", { createdAt: 1 }));
    await store.save(rec("b", { createdAt: 2 }));
    await store.save(rec("c", { createdAt: 3 }));
    await store.save(rec("d", { createdAt: 4 }));
    await app.inject({ method: "POST", url: "/api/agents/order", payload: { ids: ["c", "a"] } });
    const res = await app.inject({ method: "GET", url: "/api/agents" });
    expect(res.json().sessions.map((s: any) => s.id)).toEqual(["c", "a", "b", "d"]);
    expect((await app.inject({ method: "POST", url: "/api/agents/order", payload: { ids: [1] } })).statusCode).toBe(400);
  });

  it("removeAgent deletes the record", async () => {
    const { store, api } = await setup();
    await store.save(rec("z"));
    await api.removeAgent("z");
    expect(await store.load("z")).toBeNull();
  });

  const hook = (app: any, id: string, hook_event_name: string) =>
    app.inject({ method: "POST", url: `/api/agents/${id}/hook?token=t`, payload: { hook_event_name, session_id: "s1" } });

  it("a new prompt reopens a closed agent and tells the rail", async () => {
    const { store, app, events } = await setup();
    await store.save(rec("p", { closedAt: 5 }));
    await hook(app, "p", "UserPromptSubmit");
    const r = await store.load("p");
    expect(r?.closedAt).toBeUndefined();
    expect(r?.status).toBe("running");
    expect(events.filter((e) => e.type === "agent-reopened")).toEqual([{ type: "agent-reopened", agentId: "p" }]);
  });

  it("idle hooks and an open agent's prompt do not reopen or emit", async () => {
    const { store, app, events } = await setup();
    await store.save(rec("q", { closedAt: 5 }));
    await store.save(rec("o"));
    for (const name of ["SessionStart", "Stop", "Notification"]) await hook(app, "q", name);
    await hook(app, "o", "UserPromptSubmit");
    expect((await store.load("q"))?.closedAt).toBe(5);
    expect(events.some((e) => e.type === "agent-reopened")).toBe(false);
  });

  it("resume reopens a closed agent", async () => {
    const { store, app, events } = await setup();
    await store.save(rec("r", { closedAt: 5 }));
    await app.inject({ method: "POST", url: "/api/agents/r/resume" });
    expect((await store.load("r"))?.closedAt).toBeUndefined();
    expect(events.some((e) => e.type === "agent-reopened" && e.agentId === "r")).toBe(true);
  });
});

describe("reopenIfClosed", () => {
  it("clears closedAt once and reports whether it did", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "reopen-")));
    const emitted: any[] = [];
    const deps = { store, emit: (e: any) => emitted.push(e) };
    await store.save(rec("c", { closedAt: 5 }));
    await store.save(rec("o"));
    expect(await reopenIfClosed(deps, "c")).toBe(true);
    expect(await reopenIfClosed(deps, "c")).toBe(false);
    expect(await reopenIfClosed(deps, "o")).toBe(false);
    expect(await reopenIfClosed(deps, "missing")).toBe(false);
    expect((await store.load("c"))?.closedAt).toBeUndefined();
    expect(emitted).toEqual([{ type: "agent-reopened", agentId: "c" }]);
  });
});

describe("reopenIfClosed liveOnly (Enter in a tab)", () => {
  it("never reopens a stopped closed agent; reopens a live one", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "reopen-live-")));
    const emitted: any[] = [];
    const deps = { store, emit: (e: any) => emitted.push(e) };
    await store.save(rec("stopped", { closedAt: 5, status: "done" }));
    await store.save(rec("live", { closedAt: 5, status: "idle" }));
    expect(await reopenIfClosed(deps, "stopped", { liveOnly: true })).toBe(false);
    expect(await reopenIfClosed(deps, "live", { liveOnly: true })).toBe(true);
    expect((await store.load("stopped"))?.closedAt).toBe(5);
    expect(emitted).toEqual([{ type: "agent-reopened", agentId: "live" }]);
  });
});

describe("resumeClosedWithPrompt (a new prompt for a closed agent)", () => {
  async function setup(live = false) {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "resume-prompt-")));
    const emitted: any[] = [];
    const resumed: { id: string; sessionId: string | null; prompt?: string }[] = [];
    const deps = {
      store, emit: (e: any) => emitted.push(e),
      isLive: async () => live,
      resume: async (r: AgentRecord, o: { prompt?: string }) => {
        resumed.push({ id: r.id, sessionId: r.sessionId, prompt: o.prompt });
        return "resumed" as const;
      },
    };
    return { store, emitted, resumed, deps };
  }

  it("resumes the same session with the prompt and reopens the agent", async () => {
    const { store, emitted, resumed, deps } = await setup();
    await store.save(rec("c", { closedAt: 5, status: "done", sessionId: "sess-c" }));
    expect(await resumeClosedWithPrompt(deps, "c", "fix the test")).toBe(true);
    expect(resumed).toEqual([{ id: "c", sessionId: "sess-c", prompt: "fix the test" }]);
    expect((await store.load("c"))?.closedAt).toBeUndefined();
    expect(emitted).toContainEqual({ type: "agent-reopened", agentId: "c" });
  });

  it("does nothing for an open agent, a live session or a master", async () => {
    const { store, resumed, deps } = await setup();
    await store.save(rec("o", { status: "done" }));
    await store.save(rec("m", { kind: "fleet-master", closedAt: 5, status: "done" }));
    expect(await resumeClosedWithPrompt(deps, "o", "hi")).toBe(false);
    expect(await resumeClosedWithPrompt(deps, "m", "hi")).toBe(false);
    expect(await resumeClosedWithPrompt(deps, "missing", "hi")).toBe(false);
    const live = await setup(true);
    await live.store.save(rec("l", { closedAt: 5, status: "idle" }));
    expect(await resumeClosedWithPrompt(live.deps, "l", "hi")).toBe(false);
    expect([...resumed, ...live.resumed]).toEqual([]);
  });
});
