// server/agents/accounts-api.test.ts — the account routes and the account
// field on launch/switch, through the real API with fake terminals.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm, mkdir, writeFile, lstat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore } from "./store.js";
import { EventHub } from "../events.js";
import type { AccountPaths } from "./accounts.js";
import { AgentLoginStatus, agentLoginStatus } from "./agentlogin.js";
import type { AgentRecord } from "./store.js";
import { claudeJsonPath } from "./accounts.js";
import { continueText } from "./consoleline.js";
import { pasteOf } from "../issues/reply.js";

type SpawnCall = { id: string; cwd: string; args: string[]; command?: string; env?: Record<string, string> };

// Live ids end a tick after kill(), like the real manager (PTY exit + dtach
// socket removal are asynchronous), so the switch's wait is exercised.
function fakeTerminals() {
  const ids = new Set<string>();
  return {
    spawned: [] as SpawnCall[],
    killed: [] as string[],
    spawn(o: SpawnCall) { ids.add(o.id); this.spawned.push(o); },
    kill(id: string) { this.killed.push(id); setTimeout(() => ids.delete(id), 20); },
    has(id: string) { return ids.has(id); },
    hasSession: async () => false,
    reattach: async () => null,
    write() {}, resize() {}, attach() { return null; },
  };
}

let base: string;
let paths: AccountPaths;
let store: SessionStore;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "acct-api-"));
  paths = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
  await mkdir(join(paths.defaultDir, "projects"), { recursive: true });
  await writeFile(join(paths.defaultDir, "settings.json"), "{}");
  await writeFile(paths.defaultClaudeJson, JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "me@x.io" } }));
  store = new SessionStore(join(base, "store"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function app(terminals = fakeTerminals()) {
  const a = Fastify();
  registerAgentApi(a, { terminals: terminals as any, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths });
  return { a, terminals };
}

describe("accounts api", () => {
  it("GET lists the default first; POST creates a shadow dir; delete removes it", async () => {
    const { a } = app();
    let res = await a.inject({ method: "GET", url: "/api/accounts" });
    // userLogin: the main login is the Claude login of the server's own user (Sign out says so).
    expect(res.json().accounts).toEqual([{ id: "default", label: "me@x.io", email: "me@x.io", loggedIn: false, isDefault: true, use: null, agents: 0, userLogin: true }]);

    res = await a.inject({ method: "POST", url: "/api/accounts", payload: { id: " Work " } });
    expect(res.statusCode).toBe(201);
    expect(res.json().account).toMatchObject({ id: "work", loggedIn: false, label: "work" });
    expect((await lstat(join(paths.root, "work", "settings.json"))).isSymbolicLink()).toBe(true);

    res = await a.inject({ method: "GET", url: "/api/accounts" });
    expect(res.json().accounts.map((x: any) => x.id)).toEqual(["default", "work"]);

    res = await a.inject({ method: "POST", url: "/api/accounts/work/delete" });
    expect(res.statusCode).toBe(202);
    expect(existsSync(join(paths.root, "work"))).toBe(false);
  });

  it("POST rejects bad ids, the default, and duplicates", async () => {
    const { a } = app();
    expect((await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "../x" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/accounts", payload: { id: 7 } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "default" } })).statusCode).toBe(400);
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    expect((await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } })).statusCode).toBe(409);
  });

  it("delete refuses the default, an unknown id, and an account an agent still uses", async () => {
    const { a } = app();
    expect((await a.inject({ method: "POST", url: "/api/accounts/default/delete" })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/accounts/nope/delete" })).statusCode).toBe(404);
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    await store.save({
      id: "s1", label: "x", repo: "", worktree: "/ws", branch: "", baseBranch: "", sessionId: null,
      hookToken: "t", status: "done", createdAt: 1, account: "work",
    });
    const res = await a.inject({ method: "POST", url: "/api/accounts/work/delete" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("in use by 1 agent");
  });

  it("POST /api/agents pins a workspace agent to a named account via CLAUDE_CONFIG_DIR", async () => {
    const { a, terminals } = app();
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__", account: "work" } });
    expect(res.statusCode).toBe(202);
    const id = res.json().id as string;
    expect((await store.load(id))?.account).toBe("work");
    expect(terminals.spawned[0].env).toEqual({ CLAUDE_CONFIG_DIR: join(paths.root, "work") });
  });

  it("POST /api/agents leaves the record untouched for the default account, and 400s unknown / codex combos", async () => {
    const { a, terminals } = app();
    let res = await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__", account: "default" } });
    expect(res.statusCode).toBe(202);
    expect((await store.load(res.json().id))?.account).toBeUndefined();
    expect(terminals.spawned[0].env).toBeUndefined();

    res = await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__", account: "ghost" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown account: ghost. The logins are: default");
    res = await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__", account: "Bad Id" } });
    expect(res.statusCode).toBe(400);

    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    res = await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__", account: "work", runtime: "codex" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("accounts apply to Claude agents only");
    // nothing leaked from the rejected launches
    expect(await store.list()).toHaveLength(1);
  });

  it("POST /api/agents/:id/account relaunches a live agent under the new login", async () => {
    const { a, terminals } = app();
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    const id = (await a.inject({ method: "POST", url: "/api/agents", payload: { repo: "__workspace__" } })).json().id as string;
    expect(terminals.has(id)).toBe(true);

    const res = await a.inject({ method: "POST", url: `/api/agents/${id}/account`, payload: { account: "work" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe("cold"); // no session id yet → cold relaunch
    expect(terminals.killed).toEqual([id]);
    expect(terminals.spawned).toHaveLength(2);
    expect(terminals.spawned[1].env).toEqual({ CLAUDE_CONFIG_DIR: join(paths.root, "work") });
    expect((await store.load(id))?.account).toBe("work");

    // Same account again is a no-op, and back to default clears the field.
    expect((await a.inject({ method: "POST", url: `/api/agents/${id}/account`, payload: { account: "work" } })).json().outcome).toBe("unchanged");
    const back = await a.inject({ method: "POST", url: `/api/agents/${id}/account`, payload: { account: "default" } });
    expect(back.statusCode).toBe(202);
    expect((await store.load(id))?.account).toBeUndefined();
    expect(terminals.spawned[2].env).toBeUndefined();
  });

  it("POST /api/agents/:id/account only records the account for a dead agent; 404/400 otherwise", async () => {
    const { a, terminals } = app();
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    await store.save({
      id: "dead", label: "x", repo: "", worktree: "/ws", branch: "", baseBranch: "", sessionId: null,
      hookToken: "t", status: "done", createdAt: 1,
    });
    const res = await a.inject({ method: "POST", url: "/api/agents/dead/account", payload: { account: "work" } });
    expect(res.json().outcome).toBe("patched");
    expect(terminals.spawned).toEqual([]);
    expect((await store.load("dead"))?.account).toBe("work");
    expect((await a.inject({ method: "POST", url: "/api/agents/nope/account", payload: { account: "work" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/api/agents/dead/account", payload: { account: "ghost" } })).statusCode).toBe(400);
  });
});

// The Claude login from the page (claudelogin.ts), through its routes, with a fake `claude`.
describe("accounts api: the Claude login from the page", () => {
  const LINK = "https://claude.com/cai/oauth/authorize?code=true&state=s1";
  const GOOD = "the-good-code#state-1";

  async function withLogin() {
    const bin = join(base, "fake-claude");
    await writeFile(bin, `#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  if [ -f "${base}/in" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"pro"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
echo "If the browser didn't open, visit: ${LINK}"
printf 'Paste code here if prompted > '
IFS= read -r code || exit 1
[ "$code" = "${GOOD}" ] && { touch "${base}/in"; echo "Login successful."; exit 0; }
echo "Couldn't log in: That code wasn't accepted."; exit 1
`, { mode: 0o755 });
    const done: string[] = [];
    const a = Fastify();
    registerAgentApi(a, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths,
      claudeLogin: { bin, env: { PATH: process.env.PATH }, log: () => {} }, onClaudeLogin: (id) => done.push(id),
    });
    const until = async (state: string) => {
      for (let i = 0; i < 200; i++) {
        const j = (await a.inject({ method: "GET", url: "/api/accounts/login" })).json();
        if (j.state === state) return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`the login did not reach ${state}`);
    };
    return { a, until, done };
  }

  it("start gives the link; the code ends the login; the answers hold no code", async () => {
    const { a, until } = await withLogin();
    try {
      expect((await a.inject({ method: "GET", url: "/api/accounts/login" })).json()).toEqual({ state: "idle" });
      const start = await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      expect(start.statusCode).toBe(200);
      expect(start.json()).toMatchObject({ state: "waiting", account: "default", url: LINK });
      expect(start.json().leftMs).toBeGreaterThan(0);
      const code = await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: `  ${GOOD}\n` } });
      expect(code.json()).toEqual({ state: "checking", account: "default" });
      const end = await until("done");
      expect(end).toEqual({ state: "done", account: "default", email: "ada@example.invalid", plan: "Pro" });
      expect(`${start.body}${code.body}${JSON.stringify(end)}`).not.toContain(GOOD);
      // The page read the result: the next card starts clean.
      expect((await a.inject({ method: "POST", url: "/api/accounts/login/cancel", payload: {} })).json()).toEqual({ state: "idle" });
    } finally { await a.close(); }
  });

  it("a new login: made, then logged in with its own config dir; the hook of a good login runs", async () => {
    const { a, until, done } = await withLogin();
    try {
      await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "login-2" } });
      expect((await a.inject({ method: "POST", url: "/api/accounts/login-2/login", payload: {} })).json()).toMatchObject({ state: "waiting", account: "login-2" });
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } });
      await until("done");
      expect(done).toEqual(["login-2"]);
    } finally { await a.close(); }
  });

  it("refuses an account that is not there, a text that is not a code, and a code with no open link", async () => {
    const { a, until } = await withLogin();
    try {
      expect((await a.inject({ method: "POST", url: "/api/accounts/nope/login", payload: {} })).statusCode).toBe(404);
      expect((await a.inject({ method: "POST", url: "/api/accounts/..%2Fx/login", payload: {} })).statusCode).toBe(400);
      let r = await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/New link/);
      await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      r = await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: "two words" } });
      expect(r.statusCode).toBe(400);
      expect((await a.inject({ method: "GET", url: "/api/accounts/login" })).json().state).toBe("waiting");
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: "a-wrong-code-123" } });
      expect(await until("failed")).toEqual({ state: "failed", account: "default", reason: "wrong-code" });
    } finally { await a.close(); }
  });

  it("cancel ends a login that waits", async () => {
    const { a } = await withLogin();
    try {
      await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      expect((await a.inject({ method: "POST", url: "/api/accounts/login/cancel", payload: {} })).json()).toEqual({ state: "idle" });
      // No link is open any more: a code has nowhere to go.
      expect((await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } })).statusCode).toBe(409);
    } finally { await a.close(); }
  });
});

// The use of each login, the default login of the page, and the move of agents (pick A
// "one press", 2026-11-20).
describe("accounts api: a login at its limit", () => {
  const NOW_PLUS = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const win = (key: string, percent: number, resetsAt: string) =>
    ({ key, label: key, group: key.includes("weekly") ? "weekly" as const : "session" as const, percent, severity: "normal" as const, resetsAt, active: true });
  const FULL = { ok: true as const, windows: [win("default/session", 100, NOW_PLUS(2)), win("default/weekly:all", 40, NOW_PLUS(60)), win("work/session", 12, NOW_PLUS(4)), win("work/weekly:all", 3, NOW_PLUS(60))] };

  async function logIn(id: string) {
    const dir = id === "default" ? paths.defaultDir : join(paths.root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "not-a-real-token" } }));
  }
  const worker = (id: string, account?: string, over: Record<string, unknown> = {}) => store.save({
    id, repo: "", worktree: join(base, "ws"), cwd: join(base, "ws"), branch: "", baseBranch: "", sessionId: null,
    hookToken: "t", status: "idle", createdAt: 1, ...(account ? { account } : {}), ...over,
  } as never);

  async function setUp(over: { relaunch?: (id: string) => Promise<"relaunched" | "waits" | "gone" | "failed">; relaunchWaits?: () => string[] } = {}) {
    const a = Fastify();
    const terminals = fakeTerminals();
    const api = registerAgentApi(a, {
      terminals: terminals as any, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths,
      usage: () => FULL, defaultLoginFile: join(base, "data", "default-login.json"), relaunchPersistent: over.relaunch,
      relaunchWaits: over.relaunchWaits,
    });
    await mkdir(join(base, "ws"), { recursive: true });
    await logIn("default");
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
    await logIn("work");
    return { a, terminals, api };
  }

  afterEach(async () => { const { forgetDefaultLogin } = await import("./accounts.js"); forgetDefaultLogin(); });

  it("GET gives the use of each login and the number of its agents", async () => {
    const { a } = await setUp();
    await worker("11111111-1111-4111-8111-111111111111");
    await worker("22222222-2222-4222-8222-222222222222", "work");
    await worker("33333333-3333-4333-8333-333333333333", undefined, { closedAt: 5 });
    const list = (await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts;
    expect(list[0]).toMatchObject({ id: "default", agents: 1, use: { session: 100, week: 40, atLimit: true } });
    expect(list[0].use.until).toBeGreaterThan(Date.now());
    expect(list[1]).toMatchObject({ id: "work", agents: 1, use: { session: 12, week: 3, atLimit: false, until: null } });
    await a.close();
  });

  it("a new agent that names no login starts on a login with room", async () => {
    const { a, terminals } = await setUp();
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "hi" } });
    expect(res.statusCode).toBe(202);
    expect((await store.load(res.json().id))?.account).toBe("work");
    expect(terminals.spawned[0].env?.CLAUDE_CONFIG_DIR).toBe(join(paths.root, "work"));
    // A login that the request names is kept, also at its limit.
    const named = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "hi", account: "default" } });
    expect((await store.load(named.json().id))?.account).toBeUndefined();
    await a.close();
  });

  it("“Make default” keeps the pick; it is the login of new agents when it has room", async () => {
    const { a } = await setUp();
    expect((await a.inject({ method: "POST", url: "/api/accounts/default", payload: { id: "nope" } })).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/api/accounts/default", payload: { id: "../x" } })).statusCode).toBe(400);
    const res = await a.inject({ method: "POST", url: "/api/accounts/default", payload: { id: "work" } });
    expect(res.json()).toEqual({ preferred: "work" });
    expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().preferred).toBe("work");
    const { loadDefaultLogin, preferredAccount, forgetDefaultLogin } = await import("./accounts.js");
    forgetDefaultLogin();
    expect(preferredAccount({})).toBeUndefined();
    await loadDefaultLogin(join(base, "data", "default-login.json"));   // as the console does at its start
    expect(preferredAccount({})).toBe("work");
    expect((await a.inject({ method: "POST", url: "/api/accounts/default", payload: { id: "default" } })).json()).toEqual({ preferred: "default" });
    await a.close();
  });

  it("“Move all agents”: each agent of the login goes to the other one; a closed one only gets the login", async () => {
    const { a, terminals } = await setUp();
    const live = "11111111-1111-4111-8111-111111111111", dead = "22222222-2222-4222-8222-222222222222", closed = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
    await worker(live); await worker(dead); await worker(closed, undefined, { closedAt: 5 }); await worker(other, "work");
    terminals.spawn({ id: live, cwd: "/", args: [] });
    terminals.spawned.length = 0;
    const res = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } });
    expect(res.json()).toEqual({ moved: 2, waits: 0, failed: 0, working: 0 });
    for (const id of [live, dead, closed, other]) expect((await store.load(id))?.account, id).toBe("work");
    // Only the agent that ran was started again, on the new login.
    expect(terminals.killed).toEqual([live]);
    expect(terminals.spawned.map((x) => x.id)).toEqual([live]);
    expect(terminals.spawned[0].env?.CLAUDE_CONFIG_DIR).toBe(join(paths.root, "work"));
    await a.close();
  });

  it("“Move all agents” refuses the same login, an unknown one, and one that is not logged in", async () => {
    const { a } = await setUp();
    await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "empty" } });
    expect((await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "default" } })).statusCode).toBe(400);
    expect((await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "nope" } })).statusCode).toBe(404);
    const r = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "empty" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/not logged in/);
    await a.close();
  });

  it("a lead moves through the relaunch of the chief of staff: its record first, never a plain kill", async () => {
    const seen: (string | undefined)[] = [];
    let answer: "relaunched" | "waits" | "failed" = "relaunched";
    const { a, terminals } = await setUp({ relaunch: async (id) => { seen.push((await store.load(id))?.account); return answer; } });
    const lead = "55555555-5555-4555-8555-555555555555";
    await worker(lead, undefined, { kind: "lead" });
    terminals.spawn({ id: lead, cwd: "/", args: [] });
    let res = await a.inject({ method: "POST", url: `/api/agents/${lead}/account`, payload: { account: "work" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().outcome).toBe("resumed");
    expect(seen).toEqual(["work"]);                 // the relaunch saw the new login on the record
    expect(terminals.killed).toEqual([]);           // the relaunch owns the kill
    // Busy now: the answer says that it moves when it is quiet.
    answer = "waits";
    res = await a.inject({ method: "POST", url: `/api/agents/${lead}/account`, payload: { account: "default" } });
    expect(res.json().outcome).toBe("waits");
    expect((await store.load(lead))?.account).toBeUndefined();
    answer = "failed";
    res = await a.inject({ method: "POST", url: `/api/agents/${lead}/account`, payload: { account: "work" } });
    expect(res.statusCode).toBe(500);
    await a.close();
  });

  // The usage-limit ticket's "Moves when quiet" row (chief/limit/service.ts) asks waitsToMove: it
  // is true only while the relaunch of the chief of staff still waits to move the agent.
  it("the ticket's 'moves when quiet': true while the relaunch waits, false once it is done, failed or the agent is deleted", async () => {
    let answer: "relaunched" | "waits" = "waits";
    const armed = new Set<string>();
    const { a, api } = await setUp({ relaunch: async (id) => { if (answer === "waits") armed.add(id); else armed.delete(id); return answer; }, relaunchWaits: () => [...armed] });
    const removed: string[] = [];
    api.limitOps.onRemoved((id) => removed.push(id));
    const lead = "55555555-5555-4555-8555-555555555555";
    await worker(lead, undefined, { kind: "lead" });
    const { waitsToMove, move } = api.limitOps;
    expect(await move((await store.load(lead))!, "work")).toBe("waits");
    expect(waitsToMove(lead)).toBe(true);
    // The relaunch moved it when it was quiet: its wait list no longer has it.
    armed.delete(lead);
    expect(waitsToMove(lead)).toBe(false);
    // Busy again: waits; then a move that relaunches at once ends the wait, also if the list is late.
    expect(await move((await store.load(lead))!, "default")).toBe("waits");
    expect(waitsToMove(lead)).toBe(true);
    answer = "relaunched";
    armed.add(lead);
    expect(await move((await store.load(lead))!, "work")).toBe("resumed");
    expect(waitsToMove(lead)).toBe(false);
    // A delete: the ticket hears it at once, and the wait goes with the agent.
    answer = "waits";
    expect(await move((await store.load(lead))!, "default")).toBe("waits");
    expect(waitsToMove(lead)).toBe(true);
    expect((await a.inject({ method: "POST", url: `/api/agents/${lead}/delete` })).statusCode).toBe(202);
    expect(removed).toEqual([lead]);
    expect(waitsToMove(lead)).toBe(false);
    await a.close();
  });

  // The live console, 2026-11-24: the main login signed out with 4 leads, the Coordinator and 2
  // workers on it, all idle. The owner found no way to move them.
  describe("“Move all agents” from a login that is signed out", () => {
    const W = "11111111-1111-4111-8111-111111111111", CLOSED = "33333333-3333-4333-8333-333333333333";
    afterEach(async () => { const { forgetSignedOut } = await import("./accounts.js"); forgetSignedOut(); });

    it("the list counts each open session on it (the Coordinator too); the move takes each of them to the new login", async () => {
      const relaunched: [string, string | undefined][] = [];
      const { a, terminals } = await setUp({ relaunch: async (id) => { relaunched.push([id, (await store.load(id))?.account]); return "relaunched"; } });
      const { markSignedOut } = await import("./accounts.js");
      await worker(W, undefined, { status: "idle" });
      await worker("lead-console", undefined, { kind: "lead" });
      await worker("fleet-master", undefined, { kind: "fleet-master" });
      await worker("coordinator", undefined, { kind: "coordinator" });
      await worker(CLOSED, undefined, { closedAt: 5 });
      for (const id of [W, "lead-console", "fleet-master", "coordinator"]) terminals.spawn({ id, cwd: "/", args: [] });
      terminals.spawned.length = 0;
      expect(await markSignedOut(undefined, Date.now() + 5_000, paths)).toBe(true);

      const list = (await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts;
      expect(list[0]).toMatchObject({ id: "default", loggedIn: false, signedOut: true, agents: 4 });

      const res = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } });
      expect(res.json()).toEqual({ moved: 4, waits: 0, failed: 0, working: 0 });
      // A lead, the fleet master and the Coordinator: the relaunch of the chief of staff, with the
      // new login already on the record. Never a plain kill.
      expect(relaunched.sort()).toEqual([["coordinator", "work"], ["fleet-master", "work"], ["lead-console", "work"]]);
      // The worker: its session ends and starts again on the new login (--resume keeps its conversation).
      expect(terminals.killed).toEqual([W]);
      expect(terminals.spawned.map((x) => [x.id, x.env?.CLAUDE_CONFIG_DIR])).toEqual([[W, join(paths.root, "work")]]);
      // The closed one only gets the login, for its next start.
      for (const id of [W, "lead-console", "fleet-master", "coordinator", CLOSED]) expect((await store.load(id))?.account, id).toBe("work");
      expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts[0].agents).toBe(0);
      await a.close();
    });

    it("an agent that works on a signed-out login moves at once: its turn cannot go on there", async () => {
      const { a, terminals } = await setUp();
      const { markSignedOut } = await import("./accounts.js");
      await worker(W, undefined, { status: "running" });
      terminals.spawn({ id: W, cwd: "/", args: [] });
      await markSignedOut(undefined, Date.now() + 5_000, paths);
      const res = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } });
      expect(res.json()).toEqual({ moved: 1, waits: 0, failed: 0, working: 0 });
      expect(terminals.killed).toEqual([W]);
      await a.close();
    });

    it("a lead or the fleet master that is busy waits and moves when it is quiet; a failed relaunch is counted", async () => {
      const { a } = await setUp({ relaunch: async (id) => (id === "lead-console" ? "waits" : "failed") });
      const { markSignedOut } = await import("./accounts.js");
      await worker("lead-console", undefined, { kind: "lead" });
      await worker("fleet-master", undefined, { kind: "fleet-master" });
      await markSignedOut(undefined, Date.now() + 5_000, paths);
      const res = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } });
      expect(res.json()).toEqual({ moved: 0, waits: 1, failed: 1, working: 0 });
      await a.close();
    });
  });

  it("“Move all agents” from a login that works: an agent that works now stays, so its turn is not cut", async () => {
    const { a, terminals } = await setUp();
    const busy = "11111111-1111-4111-8111-111111111111", quiet = "22222222-2222-4222-8222-222222222222";
    await worker(busy, "work", { status: "running" });
    await worker(quiet, "work", { status: "idle" });
    terminals.spawn({ id: busy, cwd: "/", args: [] });
    terminals.spawn({ id: quiet, cwd: "/", args: [] });
    terminals.spawned.length = 0;
    // "work" has room (FULL: only the main login is at its limit).
    const res = await a.inject({ method: "POST", url: "/api/accounts/work/move", payload: { to: "default" } });
    expect(res.json()).toEqual({ moved: 1, waits: 0, failed: 0, working: 1 });
    expect(terminals.killed).toEqual([quiet]);
    expect((await store.load(busy))?.account).toBe("work");
    expect((await store.load(quiet))?.account).toBeUndefined();
    await a.close();
  });
});

// A limit cuts an agent (the lead's order of 2026-11-20): the reason in plain facts, "go on"
// after a move, a new agent on a login with room, and no session that stops at once.
describe("an agent and a Claude login at its limit", () => {
  const H = 3_600_000;
  const at = (h: number) => new Date(Date.now() + h * H).toISOString();
  const win = (key: string, percent: number, resetsAt: string) =>
    ({ key, label: key, group: key.includes("weekly") ? "weekly" as const : "session" as const, percent, severity: "normal" as const, resetsAt, active: true });
  // default: at its limit for 2 hours. work: room.
  const ONE_FULL = () => ({ ok: true as const, windows: [win("default/session", 100, at(2)), win("default/weekly:all", 40, at(60)), win("work/session", 12, at(4)), win("work/weekly:all", 3, at(60))] });
  const ALL_FULL = () => ({ ok: true as const, windows: [win("default/session", 100, at(2)), win("default/weekly:all", 40, at(60)), win("work/session", 100, at(1)), win("work/weekly:all", 3, at(60))] });
  const NONE_FULL = () => ({ ok: true as const, windows: [win("default/session", 20, at(2)), win("default/weekly:all", 40, at(60)), win("work/session", 12, at(4)), win("work/weekly:all", 3, at(60))] });
  const FABLE = "You've hit your Fable limit · resets Nov 23, 5pm (UTC)";
  const SID = "11111111-2222-4333-8444-555555555555";

  function terminals() {
    const live = new Set<string>();
    return {
      spawned: [] as SpawnCall[], killed: [] as string[], typed: [] as { id: string; data: string }[],
      spawn(o: SpawnCall) { live.add(o.id); this.spawned.push(o); },
      kill(id: string) { this.killed.push(id); setTimeout(() => live.delete(id), 10); },
      has(id: string) { return live.has(id); },
      inputReady(id: string) { return live.has(id); },
      hasSession: async () => false, reattach: async () => null,
      write(id: string, data: string) { this.typed.push({ id, data }); },
      resize() {}, attach() { return null; },
    };
  }

  async function setUp(o: { usage?: () => unknown; usageNow?: () => Promise<unknown>; waitsForUser?: (id: string) => Promise<boolean> } = {}) {
    const state = { usage: o.usage ?? ONE_FULL };
    const t = terminals();
    const hub = new EventHub();
    const events: { type: string; [k: string]: unknown }[] = [];
    hub.subscribe((e) => { events.push(e as never); });
    const a = Fastify();
    const api = registerAgentApi(a, {
      terminals: t as any, store, hub, workspaceDir: join(base, "ws"), accounts: paths, projectsRoot: join(base, "projects"),
      usage: () => state.usage() as never, defaultLoginFile: join(base, "data", "default-login.json"),
      waitsForUser: o.waitsForUser, sleep: async () => {}, ...(o.usageNow ? { usageNow: o.usageNow as never } : {}),
    });
    await mkdir(join(base, "ws"), { recursive: true });
    await mkdir(join(base, "projects", "p"), { recursive: true });
    for (const id of ["default", "work"]) {
      const dir = id === "default" ? paths.defaultDir : join(paths.root, id);
      if (id !== "default") await a.inject({ method: "POST", url: "/api/accounts", payload: { id } });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "not-a-real-token" } }));
    }
    return { a, t, api, events, state };
  }
  const line = (o: object) => JSON.stringify(o);
  // The session file of the agent: the user asked, the agent started, and then `last`.
  const session = (last: object) => writeFile(join(base, "projects", "p", `${SID}.jsonl`), [
    line({ type: "user", uuid: "u1", message: { role: "user", content: "do the task" } }),
    line({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "I start." }] } }),
    line(last), "",
  ].join("\n"));
  const cut = () => session({ type: "assistant", uuid: "a2", isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: FABLE }] } });
  const ended = () => session({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "The task is done." }] } });
  const worker = (id: string, over: Record<string, unknown> = {}) => store.save({
    id, repo: "", worktree: join(base, "ws"), cwd: join(base, "ws"), branch: "", baseBranch: "", sessionId: SID,
    hookToken: "tok", status: "idle", createdAt: 1, ...over,
  } as never);
  const hook = (a: ReturnType<typeof Fastify>, id: string, event: string) =>
    a.inject({ method: "POST", url: `/api/agents/${id}/hook?token=tok`, payload: { hook_event_name: event, session_id: SID } });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const W = "aaaaaaaa-1111-4111-8111-111111111111";

  afterEach(async () => { const { forgetDefaultLogin, forgetSignedOut } = await import("./accounts.js"); forgetDefaultLogin(); forgetSignedOut(); });

  // The live console, 2026-11-20: the token of a login was revoked. The console showed it as
  // logged in, new agents started on it, and the Coordinator would have ended on it.
  describe("a Claude login that is signed out", () => {
    const REVOKED = "OAuth token revoked · Please run /login";
    const revoked = () => session({ type: "assistant", uuid: "a2", isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: REVOKED }] } });
    const logins = async (a: ReturnType<typeof Fastify>) => {
      const r = (await a.inject({ method: "GET", url: "/api/accounts" })).json();
      return { list: r.accounts.map((x: any) => [x.id, x.loggedIn, x.signedOut === true]), preferred: r.preferred };
    };

    it("a worker that it cut: the record and the event say `login`, the login shows as signed out and is not the default", async () => {
      const { a, events, t } = await setUp({ usage: NONE_FULL });
      await a.inject({ method: "POST", url: "/api/accounts/default", payload: { id: "work" } });
      expect(await logins(a)).toEqual({ list: [["default", true, false], ["work", true, false]], preferred: "work" });
      await worker(W, { status: "running", account: "work" });
      await revoked();
      await hook(a, W, "Stop");
      await settle();
      expect((await store.load(W))?.stop).toMatchObject({ why: "login", text: REVOKED });
      expect(events.filter((e) => e.type === "agent-stop")).toEqual([{ type: "agent-stop", agentId: W, why: "login" }]);
      expect(await logins(a)).toEqual({ list: [["default", true, false], ["work", false, true]], preferred: "default" });
      // The worker keeps its login: the user moves it.
      expect((await store.load(W))?.account).toBe("work");
      expect(t.killed).toEqual([]);
      // No agent moves to that login.
      const other = "bbbbbbbb-1111-4111-8111-111111111111";
      await worker(other);
      const move = await a.inject({ method: "POST", url: `/api/agents/${other}/account`, payload: { account: "work" } });
      expect([move.statusCode, move.json().error]).toEqual([409, "That login is signed out. Log in to it again first."]);
      expect((await store.load(other))?.account).toBeUndefined();
      const all = await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } });
      expect(all.statusCode).not.toBe(200);
      await a.close();
    });

    it("the Coordinator that it cut is moved at once to a login that works, and goes on by itself", async () => {
      const { a, t } = await setUp({ usage: NONE_FULL });
      await worker("coordinator", { kind: "coordinator", status: "running", account: "work" });
      t.spawn({ id: "coordinator", cwd: "/", args: [] });
      t.spawned.length = 0;
      await revoked();
      await hook(a, "coordinator", "Stop");
      await settle(); await settle();
      const rec = await store.load("coordinator");
      expect(rec?.account).toBeUndefined();              // the main login
      expect(t.killed).toEqual(["coordinator"]);         // its session ended and started again
      expect(t.spawned.map((x) => x.id)).toEqual(["coordinator"]);
      expect(rec?.goOn).toMatchObject({ to: "me", signedOut: true });
      await hook(a, "coordinator", "SessionStart");
      await settle();
      const pastes = t.typed.filter((x) => x.data.includes("[console] Moved to me. The agent goes on."));
      expect(pastes).toHaveLength(1);
      expect(pastes[0].data).toContain("the Claude login that you used was signed out, so your last turn was cut.");
      await a.close();
    });

    it("no other login works: the Coordinator keeps its login", async () => {
      const { a, t } = await setUp({ usage: NONE_FULL });
      await rm(join(paths.defaultDir, ".credentials.json"));
      await worker("coordinator", { kind: "coordinator", status: "running", account: "work" });
      await revoked();
      await hook(a, "coordinator", "Stop");
      await settle();
      expect((await store.load("coordinator"))?.account).toBe("work");
      expect(t.killed).toEqual([]);
      expect((await logins(a)).list).toEqual([["default", false, false], ["work", false, true]]);
      await a.close();
    });
  });

  it("the agent stops and its last turn was cut by a limit: the record says why, and an event says so; it works again: gone", async () => {
    const { a, events } = await setUp();
    await worker(W, { status: "running" });
    await cut();
    await hook(a, W, "Stop");
    expect((await store.load(W))?.stop).toMatchObject({ why: "limit", text: FABLE });
    expect(events.filter((e) => e.type === "agent-stop")).toEqual([{ type: "agent-stop", agentId: W, why: "limit" }]);
    // The page gets the reason with the agent.
    expect((await a.inject({ method: "GET", url: "/api/agents" })).json().sessions[0].stop.why).toBe("limit");
    // A second stop hook for the same line is no second event.
    await hook(a, W, "Notification");
    expect(events.filter((e) => e.type === "agent-stop")).toHaveLength(1);
    await hook(a, W, "UserPromptSubmit");
    expect((await store.load(W))?.stop).toBeUndefined();
    await a.close();
  });

  it("a turn that ended in the normal way is not a stop", async () => {
    const { a, events } = await setUp();
    await worker(W, { status: "running" });
    await ended();
    await hook(a, W, "Stop");
    expect((await store.load(W))?.stop).toBeUndefined();
    expect(events.some((e) => e.type === "agent-stop")).toBe(false);
    await a.close();
  });

  it("a worker that a limit cut, moved to another login: it goes on with no input, one time", async () => {
    const { a, t } = await setUp();
    await worker(W);
    await cut();
    t.spawn({ id: W, cwd: "/", args: [] });
    t.spawned.length = 0;
    const res = await a.inject({ method: "POST", url: `/api/agents/${W}/account`, payload: { account: "work" } });
    expect(["resumed", "cold"]).toContain(res.json().outcome);   // a new session started on the new login
    expect((await store.load(W))?.goOn?.to).toBe("work");
    expect(t.typed).toEqual([]);                       // nothing before the session is up
    await hook(a, W, "SessionStart");                 // the new session is up on the new login
    await settle();
    const pastes = t.typed.filter((x) => x.data.includes("[console] Moved to work. The agent goes on."));
    expect(pastes).toHaveLength(1);
    expect(pastes[0].data).toMatch(/Go on with the work/);
    expect(t.typed.at(-1)?.data).toBe("\r");           // and Enter: the agent works, the user typed nothing
    expect((await store.load(W))?.goOn).toBeUndefined();
    // Never two for one move: a second start of the session gets nothing.
    const n = t.typed.length;
    await hook(a, W, "SessionStart");
    await settle();
    expect(t.typed.length).toBe(n);
    await a.close();
  });

  it("after the move the old limit line does not mark the agent as stopped again; a new one does", async () => {
    const { a } = await setUp();
    await worker(W, { status: "running" });
    await cut();
    await hook(a, W, "Stop");
    expect((await store.load(W))?.stop?.why).toBe("limit");
    await a.inject({ method: "POST", url: `/api/agents/${W}/account`, payload: { account: "work" } });
    expect((await store.load(W))?.stop).toBeUndefined();   // the mark was of the old login
    await hook(a, W, "Notification");                       // the session file still ends with the old line
    expect((await store.load(W))?.stop).toBeUndefined();
    // The new login is cut too, later: that is a new stop.
    await session({ type: "assistant", uuid: "a3", timestamp: new Date(Date.now() + 5_000).toISOString(), isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: FABLE }] } });
    await hook(a, W, "Stop");
    expect((await store.load(W))?.stop?.why).toBe("limit");
    await a.close();
  });

  it("an idle worker whose turn was complete, moved: it stays idle; so does one that waits for the user", async () => {
    const { a, t } = await setUp();
    await worker(W);
    await ended();
    t.spawn({ id: W, cwd: "/", args: [] });
    await a.inject({ method: "POST", url: `/api/agents/${W}/account`, payload: { account: "work" } });
    expect((await store.load(W))?.goOn).toBeUndefined();
    await hook(a, W, "SessionStart");
    await settle();
    expect(t.typed).toEqual([]);
    await a.close();

    const second = await setUp({ waitsForUser: async () => true });
    await worker(W, { account: undefined });
    await cut();
    second.t.spawn({ id: W, cwd: "/", args: [] });
    await second.a.inject({ method: "POST", url: `/api/agents/${W}/account`, payload: { account: "work" } });
    await hook(second.a, W, "SessionStart");
    await settle();
    expect(second.t.typed).toEqual([]);
    await second.a.close();
  });

  it("“Move its agents”: only the agents that a limit cut go on", async () => {
    const { a, t } = await setUp();
    const X = "bbbbbbbb-1111-4111-8111-111111111111";
    await worker(W);
    await worker(X, { sessionId: "99999999-2222-4333-8444-555555555555" });   // no session file: not cut
    await cut();
    t.spawn({ id: W, cwd: "/", args: [] }); t.spawn({ id: X, cwd: "/", args: [] });
    expect((await a.inject({ method: "POST", url: "/api/accounts/default/move", payload: { to: "work" } })).json()).toMatchObject({ moved: 2 });
    await hook(a, W, "SessionStart"); await hook(a, X, "SessionStart");
    await settle();
    expect([...new Set(t.typed.map((x) => x.id))]).toEqual([W]);
    await a.close();
  });

  it("a new agent with no login named, the default one at its limit: it starts on the login with room, and the record says why", async () => {
    const { a, t } = await setUp();
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "hi" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().startedOn.from).toBe("me@x.io");
    const rec = await store.load(res.json().id);
    expect(rec?.account).toBe("work");
    expect(rec?.startedOn?.until).toBeGreaterThan(Date.now());
    expect(t.spawned).toHaveLength(1);
    // The default login stays the default.
    expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().preferred).toBe("default");
    await a.close();
  });

  it("the console has no usage numbers yet (a start a moment ago): the pick waits for a new read", async () => {
    const { a } = await setUp({ usage: () => null, usageNow: async () => ONE_FULL() });
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "hi" } });
    expect((await store.load(res.json().id))?.account).toBe("work");
    await a.close();
  });

  it("no login has room: no session starts; the agent waits, and starts when a login comes back", async () => {
    const { a, t, api, state } = await setUp({ usage: ALL_FULL });
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "do the first task" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().waitsLogin.until).toBeGreaterThan(Date.now());
    const id = res.json().id as string;
    expect(t.spawned).toEqual([]);                    // no session that stops at its first answer
    expect((await store.load(id))?.waitsLogin?.prompt).toBe("do the first task");
    // The page gets "it waits" and the time, never the first message.
    const seen = (await a.inject({ method: "GET", url: `/api/agents/${id}` })).json();
    expect(seen.waitsLogin).toEqual({ until: res.json().waitsLogin.until });
    expect((await a.inject({ method: "GET", url: "/api/agents" })).json().sessions[0].waitsLogin).toEqual(seen.waitsLogin);
    // Still full: the check starts nothing.
    await api.checkWaiting();
    expect(t.spawned).toEqual([]);
    // A login has room again: the agent starts there with its first message.
    state.usage = ONE_FULL;
    await api.checkWaiting();
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].args.join(" ")).toContain("do the first task");
    expect(t.spawned[0].env?.CLAUDE_CONFIG_DIR).toBe(join(paths.root, "work"));
    const rec = await store.load(id);
    expect(rec?.waitsLogin).toBeUndefined();
    expect(rec?.account).toBe("work");
    // One start: a second check starts nothing.
    await api.checkWaiting();
    expect(t.spawned).toHaveLength(1);
    await a.close();
  });

  it("an agent that waits for a login starts when the user moves it", async () => {
    const { a, t } = await setUp({ usage: ALL_FULL });
    const id = (await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "do it" } })).json().id as string;
    const res = await a.inject({ method: "POST", url: `/api/agents/${id}/account`, payload: { account: "work" } });
    expect(res.statusCode).toBe(202);
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].args.join(" ")).toContain("do it");
    expect((await store.load(id))?.waitsLogin).toBeUndefined();
    await a.close();
  });

  it("each login has room: a new agent starts on the default login with no note", async () => {
    const { a } = await setUp({ usage: NONE_FULL });
    const res = await a.inject({ method: "POST", url: "/api/agents", payload: { prompt: "hi" } });
    const rec = await store.load(res.json().id);
    expect(rec?.account).toBeUndefined();
    expect(rec?.startedOn).toBeUndefined();
    expect(res.json()).toEqual({ id: res.json().id });
    await a.close();
  });

  // The usage-limit ticket's Continue (chief/limit/service.ts): the mark is read again in the
  // agent's typing lock, right before the line; it never doubles Claude's own continue.
  it("the ticket's Continue: the line goes only to a live agent that the limit still stops, with no menu on its screen", async () => {
    const { a, t, api } = await setUp();
    await worker(W, { status: "running" });
    await cut();
    await hook(a, W, "Stop");
    expect((await store.load(W))?.stop?.why).toBe("limit");
    const { goOn } = api.limitOps;
    expect(await goOn(W)).toBe("not-live");
    t.spawn({ id: W, cwd: "/", args: [] });
    const menu = { on: true };
    (t as unknown as { dialogOn: (id: string) => Promise<boolean> }).dialogOn = async () => menu.on;
    expect(await goOn(W)).toBe("dialog");
    menu.on = false;
    // Claude went on by itself after the reset: the session no longer ends with the limit line.
    await ended();
    expect(await goOn(W)).toBe("no-mark");
    expect(t.typed).toEqual([]);
    await cut();
    expect(await goOn(W)).toBe("sent");
    expect(t.typed).toEqual([{ id: W, data: pasteOf(continueText()) }, { id: W, data: "\r" }]);
    await store.patch(W, { status: "running" });
    expect(await goOn(W)).toBe("running");
    await store.patch(W, { status: "idle", stop: undefined });
    expect(await goOn(W)).toBe("no-mark");
    await store.patch(W, { closedAt: 5 });
    expect(await goOn(W)).toBe("gone");
    expect(await goOn("cccccccc-1111-4111-8111-111111111111")).toBe("gone");
    expect(t.typed).toHaveLength(2);
    await a.close();
  });

  // The ticket keeps a row when the session file could not be read: "could not read" is not
  // "no stop mark".
  it("the ticket's stopRead: no session file is 'could not read'; a session with no mark, or with the limit, is read", async () => {
    const { a, api } = await setUp();
    await worker(W);
    const rec = (await store.load(W))!;
    expect(await api.limitOps.stopRead(rec)).toEqual({ ok: false });
    await ended();
    expect(await api.limitOps.stopRead(rec)).toEqual({ ok: true, stop: null });
    await cut();
    expect(await api.limitOps.stopRead(rec)).toMatchObject({ ok: true, stop: { why: "limit" } });
    await a.close();
  });

  it("the ticket's logins: named as the console names them (no e-mail address), with their use", async () => {
    const { a, api } = await setUp();
    await writeFile(paths.defaultClaudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
    await writeFile(claudeJsonPath("work", paths), JSON.stringify({ oauthAccount: { emailAddress: "builder@example.com" } }));
    const logins = await api.limitOps.logins();
    expect(logins?.map((l) => [l.id, l.name, l.loggedIn, l.signedOut, l.use?.atLimit])).toEqual([
      ["default", "Main login", true, false, true], ["work", "builder", true, false, false],
    ]);
    expect(JSON.stringify(logins)).not.toContain("@");
    await a.close();
  });
});

// Strong protection with its helper ready (agentlogin.ts): one Claude login, the agents' own. The
// helper is reached through a fake sudo (a script that records its argv and runs a fake claude).
describe("accounts api, strong protection (the user's pick A: one login, the agents' own)", () => {
  const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
  const GOOD = "good-code_123#state-456";
  const STRONG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242" };
  afterEach(() => { vi.unstubAllEnvs(); });

  async function strongApp(o: { agentAuth?: boolean } = {}) {
    for (const [k, v] of Object.entries(STRONG)) vi.stubEnv(k, v);
    const claude = join(base, "fake-claude");
    await writeFile(claude, `#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/in" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
echo "If the browser didn't open, visit: ${LINK}"
IFS= read -r code || exit 1
[ "$code" = "${GOOD}" ] && { mkdir -p "$CLAUDE_CONFIG_DIR"; touch "$CLAUDE_CONFIG_DIR/in"; exit 0; }
exit 1
`, { mode: 0o755 });
    const sudo = join(base, "fake-sudo");
    await writeFile(sudo, `#!/usr/bin/env bash\necho "$*" >> "${base}/sudo.log"\nexec "${claude}" auth "\${@: -1}"\n`, { mode: 0o755 });
    const agentDir = join(base, "agent-claude");
    const done: string[] = [];
    const a = Fastify();
    registerAgentApi(a, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths,
      claudeLogin: { log: () => {} }, onClaudeLogin: (id) => done.push(id),
      ...(o.agentAuth === false ? {} : { agentAuth: { exec: { sudo, helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 }, configDir: agentDir, env: { PATH: process.env.PATH } } }),
    });
    const until = async (state: string) => {
      for (let i = 0; i < 200; i++) {
        const j = (await a.inject({ method: "GET", url: "/api/accounts/login" })).json();
        if (j.state === state) return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`the login did not reach ${state}`);
    };
    const sudoLog = () => (existsSync(join(base, "sudo.log")) ? readFileSync(join(base, "sudo.log"), "utf8") : "");
    return { a, until, done, sudoLog, agentDir };
  }

  it("the page makes the default login through the helper, as the agents' account, in their Claude folder", async () => {
    const { a, until, done, sudoLog, agentDir } = await strongApp();
    try {
      expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts).toEqual([
        { id: "default", label: "default", email: null, loggedIn: false, isDefault: true, use: null, agents: 0 },
      ]);
      expect((await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} })).json()).toMatchObject({ state: "waiting", account: "default", url: LINK });
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } });
      expect(await until("done")).toMatchObject({ state: "done", account: "default", email: "ada@example.invalid", plan: "Max" });
      expect(done).toEqual(["default"]);
      expect(existsSync(join(agentDir, "in"))).toBe(true);
      // Never the console's own Claude folder.
      expect(existsSync(join(paths.defaultDir, "in"))).toBe(false);
      expect(sudoLog().split("\n").filter((l) => l.includes("claude-auth login"))).toEqual([expect.stringMatching(/^-n -u #4242 \/usr\/local\/bin\/choibot-agent-exec claude-auth login$/)]);
      expect(sudoLog()).toContain("/usr/local/bin/choibot-agent-exec claude-auth status");
      expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts[0]).toMatchObject({ id: "default", label: "ada@example.invalid", loggedIn: true });
    } finally { await a.close(); }
  });

  it("the list of logins: N calls in a row and N at the same time run one status read; a login that ends and a cancel drop the kept answer", async () => {
    const { a, until, sudoLog } = await strongApp();
    const statusRuns = () => sudoLog().split("\n").filter((l) => l.endsWith("claude-auth status")).length;
    try {
      await Promise.all(Array.from({ length: 5 }, () => a.inject({ method: "GET", url: "/api/accounts" })));
      for (let i = 0; i < 10; i++) await a.inject({ method: "GET", url: "/api/accounts" });
      expect(statusRuns()).toBe(1);
      // A login: its own check of the result (1), then the kept answer is dropped: the next list reads again (1).
      await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } });
      await until("done");
      expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts[0].loggedIn).toBe(true);
      expect(statusRuns()).toBe(3);
      await a.inject({ method: "GET", url: "/api/accounts" });
      expect(statusRuns()).toBe(3);
      // A cancel drops it too.
      await a.inject({ method: "POST", url: "/api/accounts/login/cancel", payload: {} });
      await a.inject({ method: "GET", url: "/api/accounts" });
      expect(statusRuns()).toBe(4);
    } finally { await a.close(); }
  });

  it("refuses a second login, and the login of a named account", async () => {
    const { a, sudoLog } = await strongApp();
    try {
      await mkdir(join(paths.root, "login-2"), { recursive: true });
      const r = await a.inject({ method: "POST", url: "/api/accounts/login-2/login", payload: {} });
      expect([r.statusCode, r.json().error]).toEqual([409, "On this console the agents have one Claude login: the default one."]);
      const add = await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } });
      expect([add.statusCode, add.json().error]).toEqual([409, "On this console the agents have one Claude login: the default one."]);
      expect(sudoLog()).not.toContain("claude-auth login");
    } finally { await a.close(); }
  });

  it("with no helper ready (its probe failed): no login from the page, as before", async () => {
    const { a, sudoLog } = await strongApp({ agentAuth: false });
    try {
      const r = await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      expect([r.statusCode, r.json().error]).toEqual([409, "On this console the agents have their own Claude login. It is set up on the server, not from this page."]);
      expect(sudoLog()).toBe("");
    } finally { await a.close(); }
  });
});

// The second sign-in (chief/chiefaccount.ts): the persistent agents' own login, through their
// own helper uid, with its own flow. A start for one login never stops the other's flow, and a
// code typed for one login never goes to the other's.
describe("accounts api, the second sign-in", () => {
  const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
  const GOOD = "good-code_123#state-456";
  const STRONG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242" };
  afterEach(() => { vi.unstubAllEnvs(); });

  async function twoLogins(o: { chiefAuth?: boolean } = {}) {
    for (const [k, v] of Object.entries(STRONG)) vi.stubEnv(k, v);
    const claude = join(base, "fake-claude-2");
    await writeFile(claude, `#!/usr/bin/env bash
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$CLAUDE_CONFIG_DIR/in" ]; then echo '{"loggedIn":true,"email":"ada@example.invalid","subscriptionType":"max"}'; exit 0; fi
  echo '{"loggedIn":false}'; exit 1
fi
echo "If the browser didn't open, visit: ${LINK}"
IFS= read -r code || exit 1
[ "$code" = "${GOOD}" ] && { mkdir -p "$CLAUDE_CONFIG_DIR"; touch "$CLAUDE_CONFIG_DIR/in"; exit 0; }
exit 1
`, { mode: 0o755 });
    const sudo = join(base, "fake-sudo-2");
    await writeFile(sudo, `#!/usr/bin/env bash\necho "$*" >> "${base}/sudo2.log"\nexec "${claude}" auth "\${@: -1}"\n`, { mode: 0o755 });
    const agentDir = join(base, "agent-claude-2");
    const chiefDir = join(base, "chief-claude-2");
    const done: string[] = [];
    const chiefDone: number[] = [];
    await store.save({ id: "fleet-master", label: "fleet-master", repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null, hookToken: "t", status: "idle", createdAt: 1, kind: "fleet-master" } as AgentRecord);
    const a = Fastify();
    registerAgentApi(a, {
      terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: join(base, "ws"), accounts: paths,
      claudeLogin: { log: () => {} }, chiefLogin: { log: () => {} },
      onClaudeLogin: (id) => done.push(id), onChiefLogin: () => chiefDone.push(1),
      agentAuth: { exec: { sudo, helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 }, configDir: agentDir, env: { PATH: process.env.PATH } },
      ...(o.chiefAuth === false ? {} : {
        chiefAuth: { exec: { sudo, helper: "/usr/local/bin/choibot-agent-exec", uid: 4343 }, configDir: chiefDir, env: { PATH: process.env.PATH } },
        chiefStatus: new AgentLoginStatus(() => agentLoginStatus({ exec: { sudo, helper: "/usr/local/bin/choibot-agent-exec", uid: 4343 }, configDir: chiefDir, env: { PATH: process.env.PATH } })),
        chiefWait: { waits: () => ["fleet-master"] },
      }),
    });
    const state = async (account: string) => (await a.inject({ method: "GET", url: `/api/accounts/login?account=${account}` })).json();
    const until = async (account: string, want: string) => {
      for (let i = 0; i < 200; i++) {
        const j = await state(account);
        if (j.state === want) return j;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`${account} did not reach ${want}`);
    };
    const sudoLog = () => (existsSync(join(base, "sudo2.log")) ? readFileSync(join(base, "sudo2.log"), "utf8") : "");
    return { a, state, until, done, chiefDone, sudoLog, agentDir, chiefDir };
  }

  it("the list has the second sign-in, with the agents that wait for it; the persistent agents are not counted on the first", async () => {
    const { a } = await twoLogins();
    try {
      const rows = (await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts;
      expect(rows).toEqual([
        { id: "default", label: "default", email: null, loggedIn: false, isDefault: true, use: null, agents: 0 },
        { id: "persistent", label: "persistent", email: null, loggedIn: false, isDefault: false, use: null, agents: 1, persistent: true, waits: ["fleet-master"] },
      ]);
    } finally { await a.close(); }
  });

  it("two flows: a start of one does not stop the other; a code goes only to the flow of its login", async () => {
    const { a, state, until, done, chiefDone, sudoLog, agentDir, chiefDir } = await twoLogins();
    try {
      expect((await a.inject({ method: "POST", url: "/api/accounts/persistent/login", payload: {} })).json()).toMatchObject({ state: "waiting", account: "persistent" });
      expect((await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} })).json()).toMatchObject({ state: "waiting", account: "default" });
      // The second start did not stop the first flow.
      expect(await state("persistent")).toMatchObject({ state: "waiting", account: "persistent" });
      // The code of the second sign-in goes to its flow only.
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD, account: "persistent" } });
      expect(await until("persistent", "done")).toMatchObject({ account: "persistent", email: "ada@example.invalid" });
      expect(await state("default")).toMatchObject({ state: "waiting", account: "default" });
      expect(existsSync(join(chiefDir, "in"))).toBe(true);
      expect(existsSync(join(agentDir, "in"))).toBe(false);
      expect(chiefDone).toEqual([1]);
      expect(done).toEqual([]);
      // Each through the helper of its own account.
      expect(sudoLog()).toMatch(/-n -u #4343 \/usr\/local\/bin\/choibot-agent-exec claude-auth login/);
      expect(sudoLog()).toMatch(/-n -u #4242 \/usr\/local\/bin\/choibot-agent-exec claude-auth login/);
      // A code with no account goes to the first login's flow.
      await a.inject({ method: "POST", url: "/api/accounts/login/code", payload: { code: GOOD } });
      expect(await until("default", "done")).toMatchObject({ account: "default" });
      expect(done).toEqual(["default"]);
      expect(chiefDone).toEqual([1]);
    } finally { await a.close(); }
  });

  it("a cancel stops only its own flow", async () => {
    const { a, state } = await twoLogins();
    try {
      await a.inject({ method: "POST", url: "/api/accounts/persistent/login", payload: {} });
      await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      await a.inject({ method: "POST", url: "/api/accounts/login/cancel", payload: { account: "persistent" } });
      expect(await state("persistent")).toMatchObject({ state: "idle" });
      expect(await state("default")).toMatchObject({ state: "waiting", account: "default" });
    } finally { await a.close(); }
  });

  it("no second sign-in where it is not ready: 409 with a plain text, and no helper call", async () => {
    const { a, sudoLog } = await twoLogins({ chiefAuth: false });
    try {
      const r = await a.inject({ method: "POST", url: "/api/accounts/persistent/login", payload: {} });
      expect([r.statusCode, r.json().error]).toEqual([409, "The second sign-in is not ready on this console yet."]);
      expect(sudoLog()).not.toContain("#4343");
      expect((await a.inject({ method: "GET", url: "/api/accounts" })).json().accounts.map((x: { id: string }) => x.id)).toEqual(["default"]);
      // A code, a cancel or a read for the second sign-in never reaches the first login's flow.
      await a.inject({ method: "POST", url: "/api/accounts/default/login", payload: {} });
      for (const [method, url, payload] of [["POST", "/api/accounts/login/code", { code: GOOD, account: "persistent" }], ["POST", "/api/accounts/login/cancel", { account: "persistent" }], ["GET", "/api/accounts/login?account=persistent", undefined]] as const) {
        const x = await a.inject({ method, url, ...(payload ? { payload } : {}) });
        expect([x.statusCode, x.json().error], url).toEqual([409, "The second sign-in is not ready on this console yet."]);
      }
      expect((await a.inject({ method: "GET", url: "/api/accounts/login" })).json()).toMatchObject({ state: "waiting", account: "default" });
      expect(existsSync(join(base, "agent-claude-2", "in"))).toBe(false);
    } finally { await a.close(); }
  });
});
