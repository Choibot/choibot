// server/agents/settings-gate.test.ts — the Settings page's actions on the agents API (add a repo,
// add or delete a Claude login): with chief on, only the paired user. Every agent header (a worker,
// a lead, the fleet master, a token that does not match) and an unpaired browser are refused before
// anything is written. Flag off: open as before.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub } from "../events.js";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import type { AccountPaths } from "./accounts.js";

const CHIEF_UT = "user-token";
const TOKEN = "hook-token-1";

function fakeTerminals() {
  return { spawn() {}, kill() {}, has: () => false, hasSession: async () => false, reattach: async () => null, write() {}, resize() {}, attach() { return null; } };
}

let base: string;
let paths: AccountPaths;
let store: SessionStore;
let ws: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "settings-gate-"));
  ws = join(base, "ws");
  await mkdir(ws, { recursive: true });
  paths = { root: join(base, "accounts"), defaultDir: join(base, "claude"), defaultClaudeJson: join(base, ".claude.json") };
  await mkdir(join(paths.defaultDir, "projects"), { recursive: true });
  await writeFile(join(paths.defaultDir, "settings.json"), "{}");
  await writeFile(paths.defaultClaudeJson, "{}");
  store = new SessionStore(join(base, "store"));
  const rec = (id: string, kind?: string): AgentRecord => ({
    id, label: id, repo: "", worktree: base, cwd: base, branch: "", baseBranch: "", sessionId: null,
    hookToken: TOKEN, status: "idle", createdAt: 1, ...(kind ? { kind } : {}),
  } as AgentRecord);
  await store.save(rec("w1"));
  await store.save(rec("lead-app", "lead"));
  await store.save(rec("fleet-master", "fleet-master"));
});
afterEach(() => rm(base, { recursive: true, force: true }));

function app(chief: { misconfigured: string | null } | null) {
  const a = Fastify();
  const gate = chief && makeGate({
    misconfigured: chief.misconfigured, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === CHIEF_UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) }, agents: store },
  });
  registerAgentApi(a, { terminals: fakeTerminals() as any, store, hub: new EventHub(), workspaceDir: ws, accounts: paths, chief: gate ?? undefined });
  return a;
}

const agentAs = (id: string, token = TOKEN) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
// Every caller that is not the paired user. The user token rides along on the agent calls: an
// agent header is never USER, whatever else the request carries.
const NOT_USER: Array<[string, Record<string, string>]> = [
  ["no token", {}],
  ["a wrong user token", { [USER_HEADER]: "nope" }],
  ["a worker", { ...agentAs("w1"), [USER_HEADER]: CHIEF_UT }],
  ["a lead", agentAs("lead-app")],
  ["the fleet master", agentAs("fleet-master")],
  ["an agent header that does not match", agentAs("w1", "wrong")],
];

describe("Settings actions on the agents API, chief on", () => {
  it("POST /api/repos: every caller but the paired user is refused and no folder is made", async () => {
    const a = app({ misconfigured: null });
    for (const [who, headers] of NOT_USER) {
      const res = await a.inject({ method: "POST", url: "/api/repos", headers, payload: { name: "newproj" } });
      expect(res.statusCode, who).toBe(403);
      expect(res.json().error, who).toBe("pair-required");
    }
    expect(await readdir(ws)).toEqual([]);
    const ok = await a.inject({ method: "POST", url: "/api/repos", headers: { [USER_HEADER]: CHIEF_UT }, payload: { name: "newproj" } });
    expect(ok.statusCode).toBe(201);
    expect(existsSync(join(ws, "newproj", ".git"))).toBe(true);
  });

  it("POST /api/accounts: every caller but the paired user is refused and no login dir is made", async () => {
    const a = app({ misconfigured: null });
    for (const [who, headers] of NOT_USER) {
      const res = await a.inject({ method: "POST", url: "/api/accounts", headers, payload: { id: "work" } });
      expect(res.statusCode, who).toBe(403);
    }
    expect(existsSync(join(paths.root, "work"))).toBe(false);
    const ok = await a.inject({ method: "POST", url: "/api/accounts", headers: { [USER_HEADER]: CHIEF_UT }, payload: { id: "work" } });
    expect(ok.statusCode).toBe(201);
  });

  it("POST /api/accounts/:id/delete: every caller but the paired user is refused and the login stays", async () => {
    const a = app({ misconfigured: null });
    await a.inject({ method: "POST", url: "/api/accounts", headers: { [USER_HEADER]: CHIEF_UT }, payload: { id: "work" } });
    for (const [who, headers] of NOT_USER) {
      const res = await a.inject({ method: "POST", url: "/api/accounts/work/delete", headers });
      expect(res.statusCode, who).toBe(403);
    }
    expect(existsSync(join(paths.root, "work"))).toBe(true);
    const ok = await a.inject({ method: "POST", url: "/api/accounts/work/delete", headers: { [USER_HEADER]: CHIEF_UT } });
    expect(ok.statusCode).toBe(202);
  });

  it("misconfigured: 503 before any caller lookup, also for the user", async () => {
    const a = app({ misconfigured: "no console url" });
    for (const [method, url, payload] of [["POST", "/api/repos", { name: "x" }], ["POST", "/api/accounts", { id: "work" }]] as const) {
      const res = await a.inject({ method, url, headers: { [USER_HEADER]: CHIEF_UT }, payload });
      expect(res.statusCode).toBe(503);
    }
    expect(await readdir(ws)).toEqual([]);
  });

  it("reading stays open to any caller (GET /api/repos, GET /api/accounts)", async () => {
    const a = app({ misconfigured: null });
    expect((await a.inject({ method: "GET", url: "/api/repos" })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/api/accounts" })).statusCode).toBe(200);
  });
});

describe("Settings actions on the agents API, chief off", () => {
  it("add a repo and a login as before (no gate)", async () => {
    const a = app(null);
    expect((await a.inject({ method: "POST", url: "/api/repos", payload: { name: "p" } })).statusCode).toBe(201);
    expect((await a.inject({ method: "POST", url: "/api/accounts", payload: { id: "work" } })).statusCode).toBe(201);
  });
});
