// server/chief/relaunch.route.test.ts — POST /api/agents/:id/relaunch (spec
// §5.2, §7): a tiny Fastify app with the real gate, relaunchForChief on a real
// SessionStore and a real RelaunchRetry; only the terminals and the
// kill/wait/resume seams are fakes.
import Fastify, { type FastifyInstance } from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { EventHub } from "../events.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "./auth.js";
import { makeGate } from "./gate.js";
import { CHIEF_PROMPT_REV } from "./paths.js";
import { IDLE_RETRY_MS, RelaunchRetry, registerRelaunchRoute, relaunchForChief, type ChiefRelaunchCtx } from "./relaunch.js";

const NOW = 1_000_000;
const USER_TOKEN = "u".repeat(43);
const user = { [USER_HEADER]: USER_TOKEN };

const worker = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "w1", label: "W", repo: "r", worktree: "/ws/r/.agent-worktrees/w1", branch: "b", baseBranch: "main",
  sessionId: "s1", hookToken: "tok-w1", status: "idle", createdAt: 1, ...over,
});

// The TerminalManager surface relaunchForChief reads; kill() is the only write.
class FakeTerms {
  inAt = new Map<string, number>();
  outAt = new Map<string, number>();
  constructor(private log: string[]) {}
  has() { return true; }
  async hasSession() { return true; }
  lastInputAt(id: string) { return this.inAt.get(id); }
  lastOutputAt(id: string) { return this.outAt.get(id); }
  kill(id: string) { this.log.push(`kill:${id}`); }
}

let app: FastifyInstance | undefined;
let stopRetry: (() => void) | undefined;
let dirs: string[] = [];
afterEach(async () => {
  stopRetry?.();
  stopRetry = undefined;
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function setup(o: {
  recs?: AgentRecord[]; misconfigured?: string | null; canResume?: boolean; gone?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "chief-relaunch-route-"));
  dirs.push(root);
  const storeDir = join(root, "agents");
  await mkdir(storeDir);
  const store = new SessionStore(storeDir);
  for (const r of o.recs ?? [worker()]) await store.save(r);
  const log: string[] = [];
  const terms = new FakeTerms(log);
  const hub = new EventHub();
  const ctx: ChiefRelaunchCtx = {
    terminals: terms as unknown as ChiefRelaunchCtx["terminals"],
    store, port: 0, workspaceDir: "/ws",
    hub, relaunching: new Set<string>(),
    onRelaunch: () => {},
    ensureFleet: async () => "master",
    masterHasDraft: () => false,
    afterRelaunch: async () => {},
    now: () => NOW,
    waitGone: async () => o.gone ?? true,
    resume: async (rec) => { log.push(`resume:${rec.id}`); },
    canResume: async () => o.canResume ?? true,
  };
  // The retry the route arms: the real class, driving the real relaunch, with
  // a sweep timer that never fires (only idle events trigger it here) and an
  // idle-retry timer whose quiet window has passed at once.
  const tries: Array<{ id: string; force?: boolean }> = [];
  const retry = new RelaunchRetry({
    hub,
    relaunch: (id, opts) => { tries.push({ id, ...opts }); return relaunchForChief(id, ctx, opts); },
    setTimer: (fn, ms) => {
      if (ms === IDLE_RETRY_MS) queueMicrotask(fn);
      return { clear: () => {} };
    },
  });
  const arm = vi.spyOn(retry, "arm");
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: "log",
    deps: {
      devices: { verify: async (t: string) => (t === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
      agents: store,
    },
  });
  const load = vi.spyOn(store, "load");
  app = Fastify();
  registerRelaunchRoute(app, { gate, ctx, retry });
  await app.ready();
  const post = (id: string, o2: { headers?: Record<string, string>; body?: unknown } = {}) =>
    app!.inject({
      method: "POST", url: `/api/agents/${id}/relaunch`, headers: o2.headers ?? user,
      ...(o2.body === undefined ? {} : { payload: o2.body as Record<string, unknown> }),
    });
  return { root, store, terms, hub, log, retry, arm, tries, load, post };
}

describe("POST /api/agents/:id/relaunch", () => {
  it("a request without headers gets 403 pair-required and relaunches nothing", async () => {
    const { post, log, arm } = await setup();
    const res = await post("w1", { headers: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(log).toEqual([]);
    expect(arm).not.toHaveBeenCalled();
  });

  it("an authenticated agent is not USER: 403 pair-required", async () => {
    const { post, log } = await setup();
    const res = await post("w1", { headers: { [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: "tok-w1" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "pair-required", userAuth: "log" });
    expect(log).toEqual([]);
  });

  it("misconfigured: 503 before any caller lookup or record load", async () => {
    const { post, log, load } = await setup({ misconfigured: "CHIEF_CONSOLE_URL is missing" });
    const res = await post("w1");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "chief-misconfigured" });
    expect(load).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("USER on an idle record with no chiefRev: 200 relaunched (kill then resume)", async () => {
    const { post, log, arm } = await setup();
    const res = await post("w1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "relaunched" });
    expect(log).toEqual(["kill:w1", "resume:w1"]);
    expect(arm).not.toHaveBeenCalled();
  });

  it("a record that already has the current chiefRev: 200 not-needed, no kill", async () => {
    const { post, log } = await setup({ recs: [worker({ chiefRev: CHIEF_PROMPT_REV })] });
    const res = await post("w1", { body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "not-needed" });
    expect(log).toEqual([]);
  });

  it("a running record: 409 retryOnIdle, the retry is armed without force, no kill", async () => {
    const { post, log, arm, retry } = await setup({ recs: [worker({ status: "running" })] });
    const res = await post("w1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ retryOnIdle: true });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm).toHaveBeenCalledWith("w1", { force: false });
    expect(retry.armed()).toEqual(["w1"]);
    expect(log).toEqual([]);
  });

  it("force on a running record: 200 relaunched", async () => {
    const { post, log, arm } = await setup({ recs: [worker({ status: "running" })] });
    const res = await post("w1", { body: { force: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "relaunched" });
    expect(log).toEqual(["kill:w1", "resume:w1"]);
    expect(arm).not.toHaveBeenCalled();
  });

  it("a forced call that hits the input guard is armed with force, and the retry passes force again", async () => {
    const { post, log, arm, retry, tries, terms, hub } = await setup({ recs: [worker({ status: "running" })] });
    terms.inAt.set("w1", NOW - 1_000);
    const res = await post("w1", { body: { force: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ retryOnIdle: true });
    expect(arm).toHaveBeenCalledWith("w1", { force: true });
    expect(log).toEqual([]);
    // The input goes quiet; the record still reads running (a stale status),
    // so only a forced retry can relaunch it.
    terms.inAt.delete("w1");
    stopRetry = retry.start();
    hub.emitEvent({ type: "agent-status", agentId: "w1", status: "idle" });
    await vi.waitFor(() => expect(log).toEqual(["kill:w1", "resume:w1"]));
    expect(tries).toEqual([{ id: "w1", force: true }]);
    await vi.waitFor(() => expect(retry.armed()).toEqual([]));
  });

  it("no resumable conversation: 409 cannot-resume, not armed, no kill", async () => {
    const { post, log, arm } = await setup({ canResume: false });
    const res = await post("w1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ outcome: "cannot-resume" });
    expect(arm).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("an unknown id: 404", async () => {
    const { post, log, arm } = await setup();
    const res = await post("nope");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not found" });
    expect(log).toEqual([]);
    expect(arm).not.toHaveBeenCalled();
  });

  it("an id that is not an agent id is 404 before any load (no planted record outside the store)", async () => {
    const { post, log, load, root } = await setup();
    // Fastify decodes %2F in a param, so `..%2Fx` reaches the handler as `../x`,
    // which SessionStore would join to <root>/x.json.
    await writeFile(join(root, "x.json"), JSON.stringify(worker({ id: "../x" })));
    for (const id of ["..%2Fx", "a".repeat(65), "-w1", "w.1"]) {
      const res = await post(id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json(), id).toEqual({ error: "not found" });
    }
    expect(load).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("a body whose force is not a boolean: 400, nothing loaded", async () => {
    const { post, log, load } = await setup();
    const res = await post("w1", { body: { force: "yes" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid request" });
    expect(load).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("a failed relaunch: 500 with the error, also logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { post, arm } = await setup({ gone: false });
    const res = await post("w1");
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "the running session did not end" });
    expect(arm).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[chief] relaunch w1 failed:", "the running session did not end");
  });
});
