// server/setup/actions.test.ts — the action routes of the Set-up page: each one is for the
// paired user only, and none of them does anything until it is called.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { CHIEF_ERR, makeGate } from "../chief/gate.js";
import { NEEDS_PAIRING, registerSetupActions } from "./actions.js";
import { registerSetupApi } from "./api.js";
import type { LoginState } from "./ghlogin.js";
import { RepoPick } from "./repopick.js";

const USER = "user-token";
const HOOK = "hook-token";
type H = Record<string, string>;
const user: H = { [USER_HEADER]: USER };
const agent = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: HOOK });

const ROUTES: [method: "GET" | "POST", url: string, body?: unknown][] = [
  ["GET", "/api/setup/github/login"],
  ["POST", "/api/setup/github/login", {}],
  ["GET", "/api/setup/github/name"],
  ["POST", "/api/setup/github/name", {}],
  ["GET", "/api/setup/repos"],
  ["GET", "/api/setup/repos/clone"],
  ["POST", "/api/setup/repos/clone", { repo: "acme/shop" }],
  ["GET", "/api/setup/first"],
  ["POST", "/api/setup/first", {}],
  ["POST", "/api/setup/first", { again: true }],
];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "setup-actions-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function app(o: { gate?: boolean; misconfigured?: string | null; git?: Record<string, string>; first?: { ok: false; why: string } | null; agentIdentity?: (n: string, e: string) => Promise<boolean> } = {}) {
  const a = Fastify();
  const did: string[] = [];
  const agents = { load: async (id: string) => (["w1", "lead-app", "fleet-master"].includes(id)
    ? { id, hookToken: HOOK, kind: id === "lead-app" ? "lead" : id === "fleet-master" ? "fleet-master" : undefined } as never : null) };
  const gate = makeGate({
    misconfigured: o.misconfigured ?? null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === USER ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) }, agents },
  });
  let state: LoginState = { state: "idle" };
  const login = {
    state: () => state,
    start: async (s: { fresh?: boolean }) => { did.push(`login${s.fresh ? " fresh" : ""}`); state = { state: "waiting", code: "7F2A-9C41", url: "https://github.com/login/device", expiresAt: 5 }; return state; },
    stop: () => {},
  };
  const repos = new RepoPick({
    workspaceDir: dir, bin: join(dir, "no-gh"), onBox: async () => [],
    ghPage: async (page) => { did.push("list"); return page === 1 ? JSON.stringify([{ slug: "acme/shop", push: true }, { slug: "acme/infra", push: false }]) : "[]"; },
    log: () => {},
  });
  const VIEW = { task: "t", repo: "shop", repos: ["shop", "api"], agent: null, ticket: null, now: 2 };
  const first = {
    view: async () => { did.push("first view"); return VIEW; },
    start: async (s: { again?: boolean; repo?: string }) => {
      did.push(`first start${s.again ? " again" : ""}${s.repo !== undefined ? ` in ${s.repo}` : ""}`);
      if (s.repo !== undefined && !VIEW.repos.includes(s.repo)) return { ok: false as const, why: "unknown-repo" };
      return o.first ?? { ok: true as const, view: VIEW };
    },
  };
  const cfg = new Map(Object.entries(o.git ?? {}));
  let forgot = 0;
  registerSetupActions(a, {
    gate: o.gate === false ? undefined : gate,
    login: login as never, repos, ...(o.first === null ? {} : { first: first as never }),
    commitName: {
      gitConfig: async (args) => {
        if (args[0] === "--get") return cfg.get(args[1]) ?? null;
        did.push(`git config ${args.join(" ")}`); cfg.set(args[0], args[1]); return "";
      },
      ghUser: async () => JSON.stringify({ login: "ada-dev", id: 42, name: "Ada" }),
    },
    changed: () => { forgot++; },
    ...(o.agentIdentity ? { agentIdentity: o.agentIdentity } : {}),
    now: () => 2,
    log: () => {},
  });
  const call = (m: "GET" | "POST", url: string, headers: H, body?: unknown) =>
    a.inject({ method: m, url, headers, ...(m === "POST" ? { payload: (body ?? {}) as object } : {}) });
  return { a, did, call, forgot: () => forgot, cfg };
}

describe("the USER gate", () => {
  it.each(ROUTES)("%s %s refuses an agent, a lead, the fleet master and a caller with no device", async (m, url, body) => {
    const { call, did } = app();
    for (const headers of [agent("w1"), agent("lead-app"), agent("fleet-master"), {}, { [USER_HEADER]: "wrong" }, { ...user, ...agent("w1") }]) {
      const res = await call(m, url, headers, body);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toEqual({ error: CHIEF_ERR.pairRequired, userAuth: "log" });
    }
    expect(did).toEqual([]);
  });

  it.each(ROUTES)("%s %s answers nobody on a console with no device pairing", async (m, url, body) => {
    const { call, did } = app({ gate: false });
    const res = await call(m, url, user, body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(NEEDS_PAIRING);
    expect(did).toEqual([]);
  });

  it.each(ROUTES)("%s %s answers 503 while the chief is misconfigured", async (m, url, body) => {
    const { call, did } = app({ misconfigured: "bad" });
    expect((await call(m, url, user, body)).statusCode).toBe(503);
    expect(did).toEqual([]);
  });
});

describe("the actions, as the user", () => {
  it("starts the login only on the POST, and gives its state", async () => {
    const { call, did } = app();
    expect((await call("GET", "/api/setup/github/login", user)).json()).toEqual({ state: "idle" });
    expect(did).toEqual([]);
    expect((await call("POST", "/api/setup/github/login", user)).json()).toEqual({ state: "waiting", code: "7F2A-9C41", url: "https://github.com/login/device", leftMs: 3 });
    await call("POST", "/api/setup/github/login", user, { fresh: true });
    expect(did).toEqual(["login", "login fresh"]);
  });

  it("shows the commit name it will set, and sets it on the POST", async () => {
    const { call, did, forgot } = app();
    expect((await call("GET", "/api/setup/github/name", user)).json()).toEqual({ name: false, email: false, suggest: { name: "Ada", email: "42+ada-dev@users.noreply.github.com" } });
    expect(did).toEqual([]);
    expect((await call("POST", "/api/setup/github/name", user)).json()).toEqual({ ok: true, wrote: ["name", "email"] });
    expect(did).toEqual(["git config user.name Ada", "git config user.email 42+ada-dev@users.noreply.github.com"]);
    expect(forgot()).toBe(1);
  });

  it("strong protection: the same name goes to the agents' account, also when git had it already; a failure says so", async () => {
    const given: string[] = [];
    const ok = app({ agentIdentity: async (n, e) => { given.push(`${n} <${e}>`); return true; } });
    expect((await ok.call("POST", "/api/setup/github/name", user)).json()).toEqual({ ok: true, wrote: ["name", "email"] });
    const had = app({ git: { "user.name": "Owner", "user.email": "owner@example.com" }, agentIdentity: async (n, e) => { given.push(`${n} <${e}>`); return true; } });
    expect((await had.call("POST", "/api/setup/github/name", user)).json()).toEqual({ ok: true, wrote: [] });
    expect(given).toEqual(["Ada <42+ada-dev@users.noreply.github.com>", "Owner <owner@example.com>"]);
    const failed = app({ agentIdentity: async () => false });
    const r = await failed.call("POST", "/api/setup/github/name", user);
    expect([r.statusCode, r.json()]).toEqual([502, { error: "Your server did not give the name to your agents. Try again." }]);
  });

  it("changes no commit name that git has", async () => {
    const { call, did, cfg, forgot } = app({ git: { "user.name": "Owner", "user.email": "owner@example.com" } });
    expect((await call("POST", "/api/setup/github/name", user)).json()).toEqual({ ok: true, wrote: [] });
    expect(did).toEqual([]);
    expect(Object.fromEntries(cfg)).toEqual({ "user.name": "Owner", "user.email": "owner@example.com" });
    expect(forgot()).toBe(0);
  });

  it("lists the repos, and copies only a repo of the list with push access", async () => {
    const { call } = app();
    expect((await call("GET", "/api/setup/repos?q=shop", user)).json().repos.map((r: { slug: string }) => r.slug)).toEqual(["acme/shop"]);
    expect((await call("POST", "/api/setup/repos/clone", user, { repo: "acme/other" })).statusCode).toBe(400);
    expect((await call("POST", "/api/setup/repos/clone", user, { repo: "../x" })).statusCode).toBe(400);
    expect((await call("POST", "/api/setup/repos/clone", user, { repo: 7 })).statusCode).toBe(400);
    expect((await call("POST", "/api/setup/repos/clone", user, { path: "/tmp/x", url: "https://github.com/acme/shop" })).statusCode).toBe(400);
    const off = await call("POST", "/api/setup/repos/clone", user, { repo: "acme/infra" });
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toBe("GitHub gives no push access to this repo.");
    expect((await call("GET", "/api/setup/repos/clone", user)).json()).toEqual({ state: "idle" });
  });
});

describe("the first agent, as the user", () => {
  it("reads the state with no start, and starts only on the POST", async () => {
    const { call, did } = app();
    expect((await call("GET", "/api/setup/first", user)).json()).toEqual({ task: "t", repo: "shop", repos: ["shop", "api"], agent: null, ticket: null, now: 2 });
    expect(did).toEqual(["first view"]);
    expect((await call("POST", "/api/setup/first", user)).statusCode).toBe(200);
    await call("POST", "/api/setup/first", user, { again: true });
    await call("POST", "/api/setup/first", user, { again: "yes" });
    expect(did).toEqual(["first view", "first start", "first start again", "first start"]);
  });

  it.each([
    ["no-repo", 409, /Pick a repo/], ["working", 409, /works now/], ["busy", 409, /starts now/], ["failed", 502, /did not start/],
  ] as const)("says in plain words why it did not start: %s", async (why, code, text) => {
    const { call } = app({ first: { ok: false, why } });
    const res = await call("POST", "/api/setup/first", user);
    expect(res.statusCode).toBe(code);
    expect(res.json().error).toMatch(text);
  });

  it("takes the name of a repo only, and refuses a path or a name that is not in the list", async () => {
    const { call, did } = app();
    expect((await call("POST", "/api/setup/first", user, { repo: "api" })).statusCode).toBe(200);
    for (const repo of ["/ws/api", "../api", "other"]) {
      const res = await call("POST", "/api/setup/first", user, { repo });
      expect(res.statusCode, repo).toBe(400);
      expect(res.json()).toEqual({ error: "Pick a repo of the list." });
    }
    // Not a text: refused before the start is asked.
    for (const repo of [7, { path: "/ws/api" }, ["api"], null]) expect((await call("POST", "/api/setup/first", user, { repo })).statusCode).toBe(400);
    // A path under another key is not read at all.
    expect((await call("POST", "/api/setup/first", user, { path: "/ws/api", cwd: "/tmp" })).statusCode).toBe(200);
    expect(did).toEqual(["first start in api", "first start in /ws/api", "first start in ../api", "first start in other", "first start"]);
  });

  it("answers 404 on a console that cannot start it", async () => {
    const { call } = app({ first: null });
    expect((await call("GET", "/api/setup/first", user)).statusCode).toBe(404);
    expect((await call("POST", "/api/setup/first", user)).statusCode).toBe(404);
  });
});

describe("a console that is set up", () => {
  it("runs no action when its pages only read the step list", async () => {
    const a = Fastify();
    const did: string[] = [];
    const steps = registerSetupApi(a, { probes: () => ({}), log: () => {} });
    const login = { state: () => ({ state: "idle" as const }), start: async () => { did.push("login"); return { state: "idle" as const }; }, stop: () => {} };
    const repos = new RepoPick({ workspaceDir: dir, bin: join(dir, "no-gh"), ghPage: async () => { did.push("list"); return "[]"; }, onBox: async () => { did.push("box"); return []; } });
    const first = { view: async () => { did.push("first view"); return {}; }, start: async () => { did.push("first start"); return { ok: false, why: "busy" }; } };
    registerSetupActions(a, {
      login: login as never, repos, first: first as never, changed: () => steps.forget(),
      commitName: { gitConfig: async (args) => { did.push(`git ${args.join(" ")}`); return null; }, ghUser: async () => { did.push("gh user"); return "{}"; } },
    });
    expect((await a.inject({ method: "GET", url: "/api/setup/steps" })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/api/setup/home" })).json()).toEqual({ home: false });
    expect(did).toEqual([]);
  });
});
