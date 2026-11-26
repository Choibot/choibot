// server/chief/relaunch.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub, type ConsoleEvent } from "../events.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { agentExitHandler } from "../agents/exit.js";
import { ComposerGate } from "../agents/composer.js";
import { withTypingLock } from "../issues/reply.js";
import { FLEET_MASTER_ID } from "../master/paths.js";
import { CHIEF_PROMPT_REV } from "./paths.js";
import {
  INPUT_QUIET_MS, OUTPUT_QUIET_MS, relaunchForChief, restartSession, type ChiefRelaunchCtx,
} from "./relaunch.js";
import { AreaStore } from "./leads/areas.js";
import { holdOnRelaunch, LeadRuntimes } from "./leads/lead.js";

const NOW = 1_000_000;

type Spawned = { id: string; cwd: string; args: string[]; env?: Record<string, string> };

// The TerminalManager surface relaunchForChief, waitUntilGone, resumeAgent and
// the ComposerGate touch. `live` = a Term tracked here, `sessions` = a dtach
// socket. kill() ends both; with a local Term it fires onExit, as the real
// manager does (terminal.ts kill → the PTY's exit).
class FakeTerms {
  live = new Set<string>();
  sessions = new Set<string>();
  ready = new Set<string>();
  inAt = new Map<string, number>();
  outAt = new Map<string, number>();
  writes: string[] = [];
  spawned: Spawned[] = [];
  onExit?: (id: string, code: number, killed: boolean) => void;
  constructor(private onKill: (id: string) => void) {}
  has(id: string) { return this.live.has(id); }
  async hasSession(id: string) { return this.sessions.has(id); }
  async reattach(id: string) {
    if (!this.sessions.has(id)) return null;
    this.live.add(id);
    return {};
  }
  write(_id: string, d: string) { this.writes.push(d); }
  inputReady(id: string) { return this.live.has(id) && this.ready.has(id); }
  lastInputAt(id: string) { return this.inAt.get(id); }
  lastOutputAt(id: string) { return this.outAt.get(id); }
  kill(id: string) {
    this.onKill(id);
    const local = this.live.delete(id);
    this.sessions.delete(id);
    this.ready.delete(id);
    if (local) this.onExit?.(id, 0, true);
  }
  spawn(o: Spawned) { this.spawned.push(o); this.live.add(o.id); }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const worker = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "w1", label: "W", repo: "r", worktree: "/ws/r/.agent-worktrees/w1", branch: "b", baseBranch: "main",
  sessionId: "s1", hookToken: "tok-w1", status: "idle", createdAt: 1, ...over,
});
const fleet = (over: Partial<AgentRecord> = {}): AgentRecord => worker({
  id: FLEET_MASTER_ID, label: "Master", kind: "fleet-master", repo: "", worktree: "/m/agent", cwd: "/m/agent",
  branch: "", baseBranch: "", ...over,
});

let dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

// Every record live (a tracked, ready Term) unless the test changes it.
async function setup(recs: AgentRecord[] = [worker()]) {
  const dir = await mkdtemp(join(tmpdir(), "chief-relaunch-"));
  dirs.push(dir);
  const store = new SessionStore(dir);
  for (const r of recs) await store.save(r);
  const log: string[] = [];
  const relaunching = new Set<string>();
  const terms = new FakeTerms((id) => log.push(`kill:${id}:${relaunching.has(id)}`));
  for (const r of recs) { terms.live.add(r.id); terms.sessions.add(r.id); terms.ready.add(r.id); }
  const events: ConsoleEvent[] = [];
  const hub = new EventHub();
  hub.subscribe((e) => { events.push(e); });
  const canResumeCalls: Array<[string, string]> = [];
  const ctx: ChiefRelaunchCtx = {
    terminals: terms as unknown as ChiefRelaunchCtx["terminals"],
    store, port: 0, workspaceDir: "/ws",
    hub, relaunching,
    onRelaunch: (rec) => { log.push(`onRelaunch:${rec.id}`); },
    ensureFleet: async () => { log.push(`ensureFleet:${relaunching.has(FLEET_MASTER_ID)}`); return FLEET_MASTER_ID; },
    masterHasDraft: () => false,
    afterRelaunch: async (id) => { log.push(`after:${id}`); },
    now: () => NOW,
    waitGone: async (id) => { log.push(`waitGone:${id}`); return true; },
    resume: async (rec) => {
      log.push(`resume:${rec.id}:${relaunching.has(rec.id)}`);
      terms.live.add(rec.id);
      terms.sessions.add(rec.id);
    },
    canResume: async (rec, cwd) => { canResumeCalls.push([rec.id, cwd]); return true; },
  };
  return { ctx, terms, store, hub, log, events, relaunching, canResumeCalls };
}

describe("restartSession (a session that sits at a dialog of its start)", () => {
  it("ends the session and starts the agent again, with its inbox held and no resume check", async () => {
    const coordinator = { ...worker(), id: "coordinator", kind: "coordinator" as const, repo: "", sessionId: null };
    const { ctx, log, relaunching, canResumeCalls } = await setup([coordinator]);
    expect(await restartSession("coordinator", ctx)).toEqual({ outcome: "relaunched" });
    expect(log).toEqual(["onRelaunch:coordinator", "kill:coordinator:true", "waitGone:coordinator", "resume:coordinator:true"]);
    expect(canResumeCalls).toEqual([]);
    expect(relaunching.has("coordinator")).toBe(false);
  });
  it("the fleet master comes back through ensureFleet; a worker is never restarted this way", async () => {
    const master = { ...worker(), id: FLEET_MASTER_ID, kind: "fleet-master" as const, repo: "" };
    const { ctx, log } = await setup([master, worker()]);
    expect(await restartSession(FLEET_MASTER_ID, ctx)).toEqual({ outcome: "relaunched" });
    expect(log).toEqual([`onRelaunch:${FLEET_MASTER_ID}`, `kill:${FLEET_MASTER_ID}:true`, `waitGone:${FLEET_MASTER_ID}`, "ensureFleet:true"]);
    log.length = 0;
    expect(await restartSession("w1", ctx)).toEqual({ outcome: "not-needed" });
    expect(await restartSession("nobody", ctx)).toEqual({ outcome: "gone" });
    expect(log).toEqual([]);
  });
});

describe("relaunchForChief", () => {
  it("kills then resumes an idle record with no chiefRev; the id is in relaunching only meanwhile", async () => {
    const { ctx, log, relaunching } = await setup();
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    expect(log).toEqual(["kill:w1:true", "waitGone:w1", "resume:w1:true", "after:w1"]);
    expect(relaunching.has("w1")).toBe(false);
  });

  it("emits no agent-status event and has no act log, even when the kill fires onExit", async () => {
    const { ctx, terms, store, hub, events, relaunching, log } = await setup();
    // The real exit handler of index.ts, on the same hub and set.
    terms.onExit = agentExitHandler({
      services: () => ({ handleExit: () => false }),
      store, hub, relaunching,
    });
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    await pause();
    expect(log).toContain("kill:w1:true");
    expect(events).toEqual([]);
    expect((await store.load("w1"))?.status).toBe("idle");
    expect("acted" in ctx).toBe(false);
  });

  it("runs inside the typing lock: an earlier holder finishes before the kill", async () => {
    const { ctx, log } = await setup();
    const held = deferred();
    const holder = withTypingLock("w1", async () => { await held.promise; log.push("holder-done"); });
    const p = relaunchForChief("w1", ctx);
    await pause(50);
    expect(log).toEqual([]);
    held.resolve();
    await holder;
    expect(await p).toEqual({ outcome: "relaunched" });
    expect(log.slice(0, 2)).toEqual(["holder-done", "kill:w1:true"]);
  });

  it("gives up as not-needed when chiefRev is current; force relaunches", async () => {
    const { ctx, log } = await setup([worker({ chiefRev: CHIEF_PROMPT_REV })]);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "not-needed" });
    expect(log).toEqual([]);
    expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "relaunched" });
    expect(log).toContain("kill:w1:true");
  });

  it("relaunches an older or a newer chiefRev", async () => {
    const { ctx } = await setup([
      worker({ chiefRev: CHIEF_PROMPT_REV - 1 }), worker({ id: "w2", chiefRev: CHIEF_PROMPT_REV + 1 }),
    ]);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    expect(await relaunchForChief("w2", ctx)).toEqual({ outcome: "relaunched" });
  });

  it("waits for idle on a running record; force relaunches", async () => {
    const { ctx, log } = await setup([worker({ status: "running" })]);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "retry-on-idle" });
    expect(log).toEqual([]);
    expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "relaunched" });
    expect(log).toContain("kill:w1:true");
  });

  it("waits on input in the last 5 s, also with force", async () => {
    const { ctx, terms, log } = await setup();
    terms.inAt.set("w1", NOW - 4000);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "retry-on-idle" });
    expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "retry-on-idle" });
    expect(log).toEqual([]);
    terms.inAt.set("w1", NOW - INPUT_QUIET_MS);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
  });

  it("waits on output in the last 10 s, also with force", async () => {
    const { ctx, terms, log } = await setup();
    terms.outAt.set("w1", NOW - 9000);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "retry-on-idle" });
    expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "retry-on-idle" });
    expect(log).toEqual([]);
    terms.outAt.set("w1", NOW - OUTPUT_QUIET_MS);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
  });

  it("waits on a master draft, also with force; a worker ignores the draft", async () => {
    const { ctx, log } = await setup([fleet(), worker()]);
    ctx.masterHasDraft = () => true;
    expect(await relaunchForChief(FLEET_MASTER_ID, ctx)).toEqual({ outcome: "retry-on-idle" });
    expect(await relaunchForChief(FLEET_MASTER_ID, ctx, { force: true })).toEqual({ outcome: "retry-on-idle" });
    expect(log).toEqual([]);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
  });

  it("gives up as cannot-resume without a kill; force relaunches and skips the check", async () => {
    const { ctx, log, canResumeCalls } = await setup();
    ctx.canResume = async (rec, cwd) => { canResumeCalls.push([rec.id, cwd]); return false; };
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "cannot-resume" });
    expect(log).toEqual([]);
    expect(canResumeCalls).toEqual([["w1", "/ws/r/.agent-worktrees/w1"]]);
    expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "relaunched" });
    expect(canResumeCalls).toHaveLength(1);
  });

  it("checks canResume at the record's cwd, else the workspace root for a repo-less agent", async () => {
    const { ctx, canResumeCalls } = await setup([fleet(), worker({ id: "ws1", repo: "" })]);
    await relaunchForChief(FLEET_MASTER_ID, ctx);
    await relaunchForChief("ws1", ctx);
    expect(canResumeCalls).toEqual([[FLEET_MASTER_ID, "/m/agent"], ["ws1", "/ws"]]);
  });

  it("defaults canResume to the runtime's check (no session id → cannot-resume)", async () => {
    const { ctx, log } = await setup([worker({ sessionId: null })]);
    delete ctx.canResume;
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "cannot-resume" });
    expect(log).toEqual([]);
  });

  it("fails when resume throws; the set is empty", async () => {
    const { ctx, log, relaunching } = await setup();
    ctx.resume = async (rec) => {
      log.push(`resume:${rec.id}:${relaunching.has(rec.id)}`);
      throw new Error("spawn failed");
    };
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "failed", error: "spawn failed" });
    expect(log).toEqual(["kill:w1:true", "waitGone:w1", "resume:w1:true", "after:w1"]);
    expect(relaunching.size).toBe(0);
  });

  it("fails when the running session does not end; no resume, the set is empty", async () => {
    const { ctx, log, relaunching } = await setup();
    ctx.waitGone = async () => false;
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "failed", error: "the running session did not end" });
    expect(log).toEqual(["kill:w1:true", "after:w1"]);
    expect(relaunching.size).toBe(0);
  });

  it("relaunches a dtach-only session (no local Term, no onExit) and clears the set", async () => {
    const { ctx, terms, log, relaunching } = await setup();
    terms.live.delete("w1"); // a session that survived a restart, not attached here
    let exits = 0;
    terms.onExit = () => { exits++; };
    delete ctx.waitGone; // the real waitUntilGone
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    expect(exits).toBe(0);
    expect(log).toEqual(["kill:w1:true", "resume:w1:true", "after:w1"]);
    expect(relaunching.size).toBe(0);
  });

  it("holds the fleet master's inbox before the kill and brings it back with ensureFleet", async () => {
    const { ctx, log, relaunching } = await setup([fleet()]);
    expect(await relaunchForChief(FLEET_MASTER_ID, ctx)).toEqual({ outcome: "relaunched" });
    expect(log).toEqual([
      `onRelaunch:${FLEET_MASTER_ID}`, `kill:${FLEET_MASTER_ID}:true`, `waitGone:${FLEET_MASTER_ID}`,
      "ensureFleet:true", `after:${FLEET_MASTER_ID}`,
    ]);
    expect(relaunching.size).toBe(0);
  });

  it("fails when ensureFleet throws; the set is empty", async () => {
    const { ctx, relaunching } = await setup([fleet()]);
    ctx.ensureFleet = async () => { throw new Error("no master"); };
    expect(await relaunchForChief(FLEET_MASTER_ID, ctx)).toEqual({ outcome: "failed", error: "no master" });
    expect(relaunching.size).toBe(0);
  });

  it("a worker gets no onRelaunch", async () => {
    const { ctx, log } = await setup([worker()]);
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    expect(log.some((l) => l.startsWith("onRelaunch"))).toBe(false);
  });

  it("a lead's relaunch calls onRelaunch, which marks that lead's inbox starting (index.ts's holdOnRelaunch)", async () => {
    const lead = worker({
      id: "lead-app-shop", label: "Lead · app-shop", kind: "lead", area: "app-shop", repo: "", worktree: "/l/agent", cwd: "/l/agent",
      branch: "", baseBranch: "",
    });
    const { ctx, log, hub, store, terms } = await setup([lead, fleet(), worker()]);
    const runtimes = new LeadRuntimes({
      hub, agents: store, issues: { list: async () => [] }, acted: { recent: () => false },
      terminals: terms as unknown as ConstructorParameters<typeof LeadRuntimes>[0]["terminals"],
      areas: new AreaStore("/nonexistent/areas.json", { exists: async () => true }),
    });
    const rt = runtimes.ensure("lead-app-shop", { starting: false, recordExists: true });
    const other = runtimes.ensure("lead-infra", { starting: false, recordExists: true });
    const master = { markStarting: vi.fn() };
    const hold = holdOnRelaunch({ fleet: master, leads: runtimes });
    ctx.onRelaunch = (rec) => { log.push(`onRelaunch:${rec.id}`); hold(rec); };
    expect(rt.inbox.turn()).toBe("idle");
    expect(await relaunchForChief("lead-app-shop", ctx)).toEqual({ outcome: "relaunched" });
    expect(log).toEqual(["onRelaunch:lead-app-shop", "kill:lead-app-shop:true", "waitGone:lead-app-shop",
      "resume:lead-app-shop:true", "after:lead-app-shop"]);
    expect(rt.inbox.turn()).toBe("busy");
    expect(other.inbox.turn()).toBe("idle");
    expect(master.markStarting).not.toHaveBeenCalled();
    // The master's relaunch still holds the master's inbox only.
    expect(await relaunchForChief(FLEET_MASTER_ID, ctx)).toEqual({ outcome: "relaunched" });
    expect(master.markStarting).toHaveBeenCalledTimes(1);
    expect(other.inbox.turn()).toBe("idle");
    runtimes.stopAll();
  });

  it("gives gone with no kill for an unknown id", async () => {
    const { ctx, log } = await setup();
    expect(await relaunchForChief("nope", ctx)).toEqual({ outcome: "gone" });
    expect(log).toEqual([]);
  });

  it("gives gone with no kill for a record deleted between the list and its turn", async () => {
    const { ctx, store, log } = await setup();
    expect((await store.list()).map((r) => r.id)).toEqual(["w1"]);
    const held = deferred();
    const holder = withTypingLock("w1", () => held.promise);
    const p = relaunchForChief("w1", ctx);
    await store.delete("w1");
    held.resolve();
    await holder;
    expect(await p).toEqual({ outcome: "gone" });
    expect(log).toEqual([]);
  });

  it("gives gone with no resume for a record deleted during the kill; afterRelaunch still runs", async () => {
    for (const r of [worker(), fleet()]) {
      const { ctx, store, log, relaunching } = await setup([r]);
      ctx.waitGone = async (id) => { log.push(`waitGone:${id}`); await store.delete(id); return true; };
      expect(await relaunchForChief(r.id, ctx)).toEqual({ outcome: "gone" });
      await pause(10);
      expect(log.filter((l) => !l.startsWith("onRelaunch"))).toEqual([`kill:${r.id}:true`, `waitGone:${r.id}`, `after:${r.id}`]);
      expect(relaunching.size).toBe(0);
    }
  });

  it("calls afterRelaunch after the typing lock is released", async () => {
    const { ctx, log } = await setup();
    const done = deferred();
    ctx.afterRelaunch = async (id) => {
      // Would never finish if relaunchForChief awaited this inside its lock.
      await withTypingLock(id, async () => { log.push("after-lock"); });
      done.resolve();
    };
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    await done.promise;
    expect(log.at(-1)).toBe("after-lock");
  });

  it("logs a rejected afterRelaunch instead of leaving it unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = await setup();
    ctx.afterRelaunch = async () => { throw new Error("retry failed"); };
    expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
    await pause(10);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toContain("retry failed");
  });

  it("a composer send that waited on the lock answers 409 starting into the new PTY", async () => {
    const { ctx, terms } = await setup();
    const inResume = deferred();
    const resumed = deferred();
    ctx.resume = async (rec) => {
      inResume.resolve();
      await resumed.promise;
      terms.live.add(rec.id); // the new PTY: tracked, bracketed paste not on yet
    };
    const gate = new ComposerGate({ terminals: terms, agentExists: async () => true, sleep: async () => {} });
    const p = relaunchForChief("w1", ctx);
    await Promise.race([inResume.promise, p]); // the relaunch now holds the lock
    const sent = gate.input("w1", { msgId: "msg-00001", text: "hello" });
    await pause();
    resumed.resolve();
    expect(await p).toEqual({ outcome: "relaunched" });
    expect(await sent).toEqual({ code: 409, body: { reason: "starting" } });
    expect(terms.writes).toEqual([]);
  });

  describe("default resume (resumeAgent)", () => {
    function seams(ctx: ChiefRelaunchCtx) {
      delete ctx.resume;
      ctx.claudeHooksPathFor = () => "/tmp/h.json";
      ctx.writeClaudeHookSettings = async () => {};
    }

    it("gives the env identity and the current chiefRev with the flag on", async () => {
      vi.stubEnv("CHIEF_ENABLED", "1");
      vi.stubEnv("CHIEF_USER_AUTH", "log");
      vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
      const { ctx, terms, store } = await setup([worker({ repo: "" })]);
      seams(ctx);
      expect(await relaunchForChief("w1", ctx)).toEqual({ outcome: "relaunched" });
      expect(terms.spawned).toHaveLength(1);
      expect(terms.spawned[0].env).toMatchObject({ CHOIBOT_AGENT_ID: "w1", CHOIBOT_AGENT_PASS: "tok-w1" });
      expect((await store.load("w1"))?.chiefRev).toBe(CHIEF_PROMPT_REV);
    });

    it("flag off: launches with no CHOIBOT_* env and clears chiefRev", async () => {
      const { ctx, terms, store } = await setup([worker({ repo: "", chiefRev: CHIEF_PROMPT_REV })]);
      seams(ctx);
      expect(await relaunchForChief("w1", ctx, { force: true })).toEqual({ outcome: "relaunched" });
      expect(terms.spawned).toHaveLength(1);
      expect(Object.keys(terms.spawned[0].env ?? {}).filter((k) => k.startsWith("CHOIBOT_"))).toEqual([]);
      expect((await store.load("w1"))?.chiefRev).toBeUndefined();
    });
  });
});
