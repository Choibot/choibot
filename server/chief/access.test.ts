// Strong protection: the route walk of every route the server registers, for each caller level,
// and the hook on a real Fastify app from 127.0.0.1 (server/chief/access.ts).
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { agentPrompt } from "../agents/argv.js";
import type { AgentRecord } from "../agents/store.js";
import { coordinatorSystemPrompt } from "../coordinator/prompt.js";
import { fleetMasterSystemPrompt } from "../master/prompt.js";
import { leadSystemPrompt } from "./leads/prompt.js";
import { chiefCli } from "./paths.js";
import { COORDINATOR_WRITES } from "../coordinator/gate.js";
import {
  ACCESS_ERR, CONSOLE_RULES, FORWARDED_HEADERS, LEAD_RULES, LEVEL_RULES, LOOPBACK_ROUTES, MASTER_RULES, NONE_ROUTES, WORKER_RULES,
  mayAccess, registerStrongAccess, USER_ALONE_ROUTES, type AccessDeps, type AccessRequest, type Rule,
} from "./access.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, CONSOLE_HEADER, USER_HEADER, type Caller, type CallerLevel } from "./auth.js";
import { CHIEF_ERR, makeGate, USER_ALONE_ERR } from "./gate.js";
import { PAIRING_ROUTES } from "../frontproxy.js";

const ROOT = join(__dirname, "..", "..");
const PAGE_ROUTE = "/*";
const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };

// ---------------------------------------------------------------- every registered route

// A static read of every app.<method>(path) in server/ (tests left out), with the route constants
// resolved and the two routes that actions.ts makes in a loop. The same read as the probe of the
// first real run (175 + 4 + the editor proxy).
function serverRoutes(): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) files.push(p);
    }
  };
  walk(join(ROOT, "server"));
  const src = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const consts = new Map<string, string>();
  for (const s of src.values()) for (const m of s.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(["'])([^"']*)\2/g)) if (!consts.has(m[1])) consts.set(m[1], m[3]);
  const out = new Set<string>();
  for (const s of src.values()) {
    for (const m of s.matchAll(/\bapp\.(get|post|put|patch|delete|all)(?:<[^>]*>)?\(\s*(?:(["'`])([^"'`]*)\2|([A-Z][A-Z0-9_]*))/g)) {
      const path = m[3] ?? consts.get(m[4] ?? "");
      if (path === undefined || path.includes("${")) continue;
      out.add(`${m[1].toUpperCase()} ${path}`);
    }
  }
  for (const p of ["/api/gh/pr/close", "/api/gh/pr/reopen", "/api/gh/issue/close", "/api/gh/issue/reopen"]) out.add(`POST ${p}`);
  return [...out].sort();
}

const ROUTES = serverRoutes();
const API = ROUTES.filter((r) => r.split(" ")[1].startsWith("/api/"));

// The made-up value of each path parameter, and deps under which every target holds (the walk
// asks only whether the LEVEL lists the route; the targets have their own tests below).
const params = (route: string) => Object.fromEntries([...route.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1], m[1] === "id" ? "me" : "x"]));
const GOOD: AccessDeps = {
  agents: { load: async (id: string) => ({ id, spawnedBy: "me" } as AgentRecord) },
  queue: { get: async () => ({ agentId: "me" }) },
};
const callerOf = (level: CallerLevel): Caller => ({ level, agentHeaders: level !== "user" && level !== "none" && level !== "console", ...(level === "user" || level === "none" || level === "console" ? {} : { agentId: level === "coordinator" ? "coordinator" : "me" }) });
const req = (key: string, url?: string): AccessRequest => {
  const [method, route] = key.split(" ");
  return { method, route, url: url ?? route.replace(/:[a-zA-Z]+/g, "x"), params: params(route), socket: false, loopback: false };
};
async function allowedFor(level: CallerLevel, deps: AccessDeps = GOOD): Promise<string[]> {
  const out: string[] = [];
  for (const key of API) if (await mayAccess(level, callerOf(level), req(key), PAGE_ROUTE, deps)) out.push(key);
  return out.sort();
}
const keys = (rules: readonly Rule[]) => rules.map((r) => r.route);

describe("the route walk: every registered route, for each caller level (strong protection)", () => {
  it("finds every route of the server", () => {
    expect(API.length).toBeGreaterThanOrEqual(175);
    expect(ROUTES).toContain("POST /api/agents/:id/hook");
    expect(ROUTES).toContain("GET /api/agents/:id/terminal");
  });

  it("each list names only routes that exist (no stale or mistyped entry)", () => {
    for (const k of [...NONE_ROUTES, ...LOOPBACK_ROUTES, ...keys(WORKER_RULES), ...keys(LEAD_RULES), ...keys(MASTER_RULES), ...keys(CONSOLE_RULES), ...COORDINATOR_WRITES]) {
      expect(ROUTES, k).toContain(k);
    }
  });

  it("none (no credential): ONLY the front proxy's pairing routes and the two routes with their own token", async () => {
    expect([...NONE_ROUTES].sort()).toEqual([...PAIRING_ROUTES, "POST /api/agents/:id/hook", "POST /api/cron/notify"].sort());
    expect(await allowedFor("none")).toEqual([...NONE_ROUTES].sort());
    // Not the pairing start of log mode: its link would make any process the user.
    expect(await allowedFor("none")).not.toContain("POST /api/chief/pair/start");
  });

  it("none from a TRUE loopback peer: the same, plus the version that runs (GET /api/version) and nothing more", async () => {
    expect([...LOOPBACK_ROUTES]).toEqual(["GET /api/version"]);
    const got: string[] = [];
    for (const key of API) if (await mayAccess("none", callerOf("none"), { ...req(key), loopback: true }, PAGE_ROUTE, GOOD)) got.push(key);
    expect(got.sort()).toEqual([...NONE_ROUTES, "GET /api/version"].sort());
    // A WebSocket upgrade of it is never open.
    expect(await mayAccess("none", callerOf("none"), { ...req("GET /api/version"), loopback: true, socket: true }, PAGE_ROUTE, GOOD)).toBe(false);
  });

  it("a worker: exactly its list (and the public routes); no list of agents, no events, no other agent", async () => {
    const got = await allowedFor("agent");
    expect(got).toEqual([...new Set([...NONE_ROUTES, ...keys(WORKER_RULES)])].sort());
    for (const k of ["GET /api/agents", "GET /api/events", "POST /api/agents", "GET /api/agents/:id/thread", "GET /api/agents/:id/screen", "POST /api/agents/:id/input", "GET /api/agents/:id/terminal", "POST /api/agents/:id/stop", "POST /api/master", "GET /api/accounts", "GET /api/settings/github"]) {
      expect(got, k).not.toContain(k);
    }
  });

  it("a lead: exactly its list", async () => {
    expect(await allowedFor("lead")).toEqual([...new Set([...NONE_ROUTES, ...keys(LEAD_RULES)])].sort());
  });

  it("the fleet master: exactly its list; not the queue's Merge, not POST /api/master", async () => {
    const got = await allowedFor("master");
    expect(got).toEqual([...new Set([...NONE_ROUTES, ...keys(MASTER_RULES)])].sort());
    expect(got).not.toContain("POST /api/queue/:id/merge");
    expect(got).not.toContain("POST /api/master");
  });

  it("the Coordinator: its gate as it is (every read, its 4 writes)", async () => {
    const want = API.filter((k) => k.startsWith("GET ") || COORDINATOR_WRITES.has(k) || NONE_ROUTES.has(k));
    expect(await allowedFor("coordinator")).toEqual(want.sort());
  });

  it("the console's own account: the steps for doctor, the pairing start for `brain pair`, nothing else", async () => {
    expect(await allowedFor("console")).toEqual([...new Set([...NONE_ROUTES, ...keys(CONSOLE_RULES)])].sort());
    expect(keys(CONSOLE_RULES)).toEqual(["GET /api/setup/steps", "POST /api/chief/pair/start"]);
  });

  it("the user: every route", async () => {
    expect(await allowedFor("user")).toEqual(API);
  });

  it("fails closed: a route that no list names is refused for every level but the user", async () => {
    const key = "POST /api/a-route-added-later";
    for (const level of ["none", "agent", "lead", "master", "console"] as CallerLevel[]) {
      expect(await mayAccess(level, callerOf(level), req(key), PAGE_ROUTE, GOOD), level).toBe(false);
    }
    expect(await mayAccess("user", callerOf("user"), req(key), PAGE_ROUTE, GOOD)).toBe(true);
    expect(Object.keys(LEVEL_RULES).sort()).toEqual(["agent", "console", "lead", "master"]);
  });
});

describe("the shell of the app (the catch-all), for a caller with no credential (the front proxy's one allow-list)", () => {
  const page = (url: string, method = "GET", socket = false): AccessRequest => ({ method, route: PAGE_ROUTE, url, params: {}, socket, loopback: false });
  it.each(["/", "/?_rsc=1", "/first-run", "/pair", "/_next/static/chunks/app.js", "/_next/static/media/font.woff2", "/icon.svg", "/apple-icon.png", "/favicon.ico"])("%s: yes", async (url) => {
    expect(await mayAccess("none", callerOf("none"), page(url), PAGE_ROUTE, GOOD)).toBe(true);
    expect(await mayAccess("none", callerOf("none"), page(url, "HEAD"), PAGE_ROUTE, GOOD)).toBe(true);
  });
  it.each(["/api/agents", "/api/unknown", "/_next/image?url=x", "/_next/data/x.json", "/editor/", "/x/../api/agents", "/%2e%2e/api"])("%s: no", async (url) => {
    expect(await mayAccess("none", callerOf("none"), page(url), PAGE_ROUTE, GOOD)).toBe(false);
  });
  it("no write and no WebSocket on the catch-all", async () => {
    expect(await mayAccess("none", callerOf("none"), page("/", "POST"), PAGE_ROUTE, GOOD)).toBe(false);
    expect(await mayAccess("agent", callerOf("agent"), page("/", "GET", true), PAGE_ROUTE, GOOD)).toBe(false);
  });
  it("a request that matched no route at all is refused", async () => {
    expect(await mayAccess("agent", callerOf("agent"), { method: "GET", route: undefined, url: "/zzz", params: {}, socket: false, loopback: false }, PAGE_ROUTE, GOOD)).toBe(false);
  });
});

describe("the targets: an agent reaches itself, its own items, and (lead) the workers it spawned", () => {
  const recs: Record<string, Partial<AgentRecord>> = {
    me: { id: "me" }, w1: { id: "w1", spawnedBy: "me" }, w2: { id: "w2", spawnedBy: "other" },
    "fleet-master": { id: "fleet-master", kind: "fleet-master" }, "lead-a": { id: "lead-a", kind: "lead", spawnedBy: "me" },
    coordinator: { id: "coordinator", kind: "coordinator" },
  };
  const items: Record<string, string> = { q1: "me", q2: "w2" };
  const deps: AccessDeps = {
    agents: { load: async (id: string) => (recs[id] ? ({ ...recs[id] } as AgentRecord) : null) },
    queue: { get: async (id: string) => (items[id] ? { agentId: items[id] } : null) },
  };
  const ask = (level: CallerLevel, key: string, id: string) => {
    const [method, route] = key.split(" ");
    return mayAccess(level, callerOf(level), { method, route, url: route.replace(":id", id), params: { id }, socket: false, loopback: false }, PAGE_ROUTE, deps);
  };

  it("a worker: its own record and PR; never another agent's", async () => {
    expect(await ask("agent", "GET /api/agents/:id", "me")).toBe(true);
    expect(await ask("agent", "GET /api/agents/:id", "w1")).toBe(false);
    expect(await ask("agent", "POST /api/agents/:id/pr", "me")).toBe(true);
    expect(await ask("agent", "POST /api/agents/:id/pr", "w2")).toBe(false);
    expect(await ask("agent", "POST /api/agents/:id/fetch-base", "fleet-master")).toBe(false);
  });

  it("the review of a worker's change: a lead on the workers it spawned, the master on any worker, a worker on none", async () => {
    for (const k of ["GET /api/agents/:id/pr-diff", "GET /api/agents/:id/pr-file", "GET /api/agents/:id/diff"]) {
      expect(await ask("lead", k, "w1"), k).toBe(true);
      expect(await ask("lead", k, "w2"), k).toBe(false);
      expect(await ask("master", k, "w2"), k).toBe(true);
      // Not on a persistent agent (no worker), and never for a worker, also on itself.
      expect(await ask("master", k, "lead-a"), k).toBe(false);
      expect(await ask("agent", k, "me"), k).toBe(false);
      expect(await ask("agent", k, "w1"), k).toBe(false);
      expect(await ask("coordinator", k, "w1"), k).toBe(true);
    }
  });

  it("a worker: its own queue items only", async () => {
    expect(await ask("agent", "GET /api/queue/:id", "q1")).toBe(true);
    expect(await ask("agent", "GET /api/queue/:id", "q2")).toBe(false);
    expect(await ask("agent", "GET /api/queue/:id", "q-none")).toBe(false);
    expect(await ask("agent", "POST /api/queue/:id/withdraw", "q2")).toBe(false);
    expect(await ask("agent", "GET /api/queue/:id/page", "q1")).toBe(true);
    // The parts of an item that no rule names are refused to a worker, of any item: the pictures,
    // the shared file, the merge state.
    for (const k of ["GET /api/queue/:id/media/:name", "GET /api/queue/:id/share/file", "GET /api/queue/:id/share", "GET /api/queue/:id/merge"]) {
      expect(await ask("agent", k, "q1"), k).toBe(false);
      expect(await ask("lead", k, "q1"), k).toBe(false);
    }
  });

  it("a lead: its own items and its own workers' items (show, page, recommend); not another's", async () => {
    // q2 belongs to w2, which "other" spawned; q3 to w1, which the lead ("me") spawned.
    items.q3 = "w1";
    expect(await ask("lead", "GET /api/queue/:id", "q1")).toBe(true);
    expect(await ask("lead", "GET /api/queue/:id", "q3")).toBe(true);
    expect(await ask("lead", "GET /api/queue/:id/page", "q3")).toBe(true);
    expect(await ask("lead", "POST /api/queue/:id/recommend", "q3")).toBe(true);
    expect(await ask("lead", "GET /api/queue/:id", "q2")).toBe(false);
    expect(await ask("lead", "POST /api/queue/:id/recommend", "q2")).toBe(false);
    // A worker never gets the items of the workers it spawned (a worker spawns none).
    expect(await ask("agent", "GET /api/queue/:id", "q3")).toBe(false);
  });

  it("a lead: the thread and screen of a worker that IT spawned; not another's, not a persistent agent", async () => {
    expect(await ask("lead", "GET /api/agents/:id/thread", "w1")).toBe(true);
    expect(await ask("lead", "GET /api/agents/:id/screen", "w1")).toBe(true);
    expect(await ask("lead", "GET /api/agents/:id/thread", "w2")).toBe(false);
    expect(await ask("lead", "GET /api/agents/:id/thread", "lead-a")).toBe(false);
    expect(await ask("lead", "POST /api/agents/:id/stop", "w1")).toBe(true);
    expect(await ask("lead", "POST /api/agents/:id/stop", "w2")).toBe(false);
    expect(await ask("lead", "GET /api/agents/:id", "me")).toBe(true);
    expect(await ask("lead", "GET /api/agents/:id", "w2")).toBe(false);
  });

  it("the master: every worker's thread; not a persistent agent's, not the Coordinator's", async () => {
    expect(await ask("master", "GET /api/agents/:id/thread", "w2")).toBe(true);
    expect(await ask("master", "GET /api/agents/:id/thread", "lead-a")).toBe(false);
    expect(await ask("master", "GET /api/agents/:id/thread", "coordinator")).toBe(false);
    expect(await ask("master", "POST /api/agents/:id/stop", "fleet-master")).toBe(false);
    expect(await ask("master", "GET /api/agents/:id", "me")).toBe(true);
    expect(await ask("master", "GET /api/agents/:id", "gone")).toBe(false);
  });
});

// ------------------------------------------------------------- the hook on a real app

describe("the hook on a Fastify app, from 127.0.0.1", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

  const DEVICE = "d".repeat(43);
  const CONSOLE = "c".repeat(43);
  const records: Record<string, Partial<AgentRecord>> = { w1: { id: "w1", hookToken: "tok-w1" }, w2: { id: "w2", hookToken: "tok-w2" }, "fleet-master": { id: "fleet-master", kind: "fleet-master", hookToken: "tok-fleet-master" } };
  async function build(env: Record<string, string | undefined>) {
    const app = Fastify();
    apps.push(app);
    const agents = { load: async (id: string) => (records[id] ? ({ ...records[id] } as AgentRecord) : null) };
    const gate = makeGate({
      misconfigured: null, userAuth: "log",
      deps: {
        devices: { verify: async (t: string) => (t === DEVICE ? { label: "phone", createdAt: 0, lastUsedAt: 0 } : null) },
        agents,
        consoleToken: { verify: (t: string) => t === CONSOLE },
      },
    });
    const on = registerStrongAccess(app, { gate, agents, queue: { get: async () => null }, pageRoute: PAGE_ROUTE, env });
    for (const [m, p] of [["get", "/api/agents"], ["get", "/api/agents/:id/thread"], ["get", "/api/agents/:id"], ["post", "/api/chief/pair/first"], ["post", "/api/chief/pair/start"], ["get", "/api/setup/steps"], ["post", "/api/gh/pr/merge"], ["post", "/api/agents/:id/hook"], ["post", "/api/agents/:id/merge"], ["post", "/api/queue/:id/answer"], ["post", "/api/queue/:id/merge"], ["post", "/api/queue/:id/recommend"]] as const) {
      app[m](p, async () => ({ ok: true }));
    }
    app.get("/api/version", async () => ({ kind: "release", version: 846 }));
    app.all(PAGE_ROUTE, async () => "page");
    await app.ready();
    return { app, on };
  }
  const worker = (id = "w1", tok = `tok-${id}`) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: tok });

  it("strong protection: no credential gets the shell and the pairing paths; everything else is pair-required", async () => {
    const { app, on } = await build(HARD);
    expect(on).toBe(true);
    // The front proxy's answer: 401 "pair-required" for the API (the page opens its pairing screen).
    const r = await app.inject({ method: "GET", url: "/api/agents" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: CHIEF_ERR.pairRequired });
    expect((await app.inject({ method: "GET", url: "/api/agents/w1/thread" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/chief/pair/start", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/chief/pair/first", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/agents/w1/hook?token=x", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/nothing" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/_next/data/x.json" })).statusCode).toBe(404);
  });

  it("the version that runs: GET and HEAD from a true loopback peer with no credential (the updater's check); never from another peer or with a forwarding header", async () => {
    const { app } = await build(HARD);
    const get = await app.inject({ method: "GET", url: "/api/version" });
    expect([get.statusCode, get.json()]).toEqual([200, { kind: "release", version: 846 }]);
    expect((await app.inject({ method: "HEAD", url: "/api/version" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/version", remoteAddress: "::1" })).statusCode).toBe(200);
    // Another peer of the main listener (a console bound to more than loopback): a paired device's.
    for (const remoteAddress of ["203.0.113.7", "10.0.0.2", "127.0.0.2"]) {
      const r = await app.inject({ method: "GET", url: "/api/version", remoteAddress });
      expect([remoteAddress, r.statusCode, r.json()]).toEqual([remoteAddress, 401, { error: CHIEF_ERR.pairRequired }]);
    }
    // A header never makes a peer loopback, and a forwarding header makes a loopback peer a relay
    // for another one (tailscale serve, a tunnel on this server).
    expect((await app.inject({ method: "GET", url: "/api/version", remoteAddress: "203.0.113.7", headers: { "x-forwarded-for": "127.0.0.1" } })).statusCode).toBe(401);
    for (const h of FORWARDED_HEADERS) {
      const r = await app.inject({ method: "GET", url: "/api/version", headers: { [h]: h === "forwarded" ? "for=203.0.113.7" : "203.0.113.7" } });
      expect([h, r.statusCode]).toEqual([h, 401]);
    }
    // Only this route: every other route stays closed to that caller.
    for (const url of ["/api/agents", "/api/agents/w1/thread", "/api/setup/steps", "/api/nothing"]) {
      expect([url, (await app.inject({ method: "GET", url })).statusCode]).toEqual([url, 401]);
    }
    expect((await app.inject({ method: "POST", url: "/api/version", payload: {} })).statusCode).toBe(401);
    // A paired device and an agent with its token get it too.
    expect((await app.inject({ method: "GET", url: "/api/version", headers: { [USER_HEADER]: DEVICE } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/version", headers: worker() })).statusCode).toBe(200);
  });

  it("a paired device: every route", async () => {
    const { app } = await build(HARD);
    for (const url of ["/api/agents", "/api/agents/w1/thread", "/api/setup/steps"]) {
      expect((await app.inject({ method: "GET", url, headers: { [USER_HEADER]: DEVICE } })).statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: { [USER_HEADER]: "wrong".repeat(9) } })).statusCode).toBe(401);
  });

  it("a worker with its token: itself only; another agent's thread and the list are refused", async () => {
    const { app } = await build(HARD);
    expect((await app.inject({ method: "GET", url: "/api/agents/w1", headers: worker() })).statusCode).toBe(200);
    const other = await app.inject({ method: "GET", url: "/api/agents/w2/thread", headers: worker() });
    expect(other.statusCode).toBe(403);
    expect(other.json()).toEqual({ error: ACCESS_ERR.agent });
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: worker() })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/gh/pr/merge", headers: worker(), payload: {} })).statusCode).toBe(403);
    // A token that does not verify is no credential.
    expect((await app.inject({ method: "GET", url: "/api/agents/w1", headers: worker("w1", "stolen?") })).json()).toEqual({ error: CHIEF_ERR.pairRequired });
  });

  it("the fleet master's token: no merge and no answer (the user alone, with the reason); a recommendation passes; the user merges", async () => {
    const { app } = await build(HARD);
    const master = worker("fleet-master");
    for (const [url, error] of [["/api/gh/pr/merge", USER_ALONE_ERR.merge], ["/api/agents/w1/merge", USER_ALONE_ERR.merge], ["/api/queue/q1/merge", USER_ALONE_ERR.merge], ["/api/queue/q1/answer", USER_ALONE_ERR.auto]] as const) {
      const r = await app.inject({ method: "POST", url, headers: master, payload: { auto: true } });
      expect(r.statusCode, url).toBe(403);
      expect(r.json(), url).toEqual({ error });
      // A worker gets the same reason there; the user passes.
      expect((await app.inject({ method: "POST", url, headers: worker(), payload: {} })).json(), url).toEqual({ error });
      expect((await app.inject({ method: "POST", url, headers: { [USER_HEADER]: DEVICE }, payload: {} })).statusCode, url).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: "/api/queue/q1/recommend", headers: master, payload: {} })).statusCode).toBe(200);
    expect(USER_ALONE_ERR.merge).toMatch(/use the Merge button of the Queue/);
  });

  it("no level's list holds a user-alone route", () => {
    for (const rules of [WORKER_RULES, LEAD_RULES, MASTER_RULES, CONSOLE_RULES]) {
      for (const r of rules) expect(USER_ALONE_ROUTES.has(r.route), r.route).toBe(false);
    }
  });

  it("the console's account: the steps and the pairing start; any other route says how to get the user's rights", async () => {
    const { app } = await build(HARD);
    expect((await app.inject({ method: "GET", url: "/api/setup/steps", headers: { [CONSOLE_HEADER]: CONSOLE } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/chief/pair/start", headers: { [CONSOLE_HEADER]: CONSOLE }, payload: {} })).statusCode).toBe(200);
    const r = await app.inject({ method: "GET", url: "/api/agents", headers: { [CONSOLE_HEADER]: CONSOLE } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/brain pair <label>.*brain claim <url>/);
    // A wrong console token, or one sent with a user header, is no credential.
    expect((await app.inject({ method: "GET", url: "/api/setup/steps", headers: { [CONSOLE_HEADER]: "x".repeat(43) } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/setup/steps", headers: { [CONSOLE_HEADER]: CONSOLE, [USER_HEADER]: "bad" } })).statusCode).toBe(401);
    // Never the user: no merge.
    expect((await app.inject({ method: "POST", url: "/api/gh/pr/merge", headers: { [CONSOLE_HEADER]: CONSOLE }, payload: {} })).statusCode).toBe(403);
  });

  it.each([["no strong protection", { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" }], ["chief off", {}]])("basic mode (%s): nothing is registered, every route answers as today", async (_n, env) => {
    const { app, on } = await build(env);
    expect(on).toBe(false);
    for (const url of ["/api/agents", "/api/agents/w2/thread", "/api/setup/steps"]) expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/chief/pair/start", payload: {} })).statusCode).toBe(200);
  });
});

// ------------------------------------------------- the command line and the instruction texts

// EVERY command of the command line that asks the console (bin/lib), its routes, and who uses
// it. "user": the user's own command, refused to every other level ON PURPOSE (USER_ONLY).
// The scan below holds this table equal to the code: a new call that is not here fails.
type Use = "agent" | "lead" | "master" | "coordinator" | "console" | "none" | "user";
const CLI: Record<string, { routes: string[]; levels: Use[] }> = {
  "agents list": { routes: ["GET /api/agents"], levels: ["lead", "master", "coordinator"] },
  "agents spawn": { routes: ["GET /api/repos", "POST /api/agents"], levels: ["lead", "master"] },
  "agents stop": { routes: ["POST /api/agents/:id/stop"], levels: ["lead", "master"] },
  "agents resume": { routes: ["POST /api/agents/:id/resume"], levels: ["lead", "master"] },
  "agents delete": { routes: ["POST /api/agents/:id/delete"], levels: ["master"] },
  "agents close": { routes: ["POST /api/agents/:id/close"], levels: ["lead"] },
  // With strong protection the user alone merges and answers (gate.ts USER_ALONE_ERR).
  "agents merge-pr": { routes: ["GET /api/agents/:id", "POST /api/gh/pr/merge"], levels: ["user"] },
  // The review of a worker's change: a lead on the workers it spawned, the master on any worker.
  "agents pr-diff": { routes: ["GET /api/agents/:id/pr-diff"], levels: ["lead", "master"] },
  "agents pr-file": { routes: ["GET /api/agents/:id/pr-file"], levels: ["lead", "master"] },
  "agents changes": { routes: ["GET /api/agents/:id/diff"], levels: ["lead", "master"] },
  "agents pr": { routes: ["POST /api/agents/:id/pr"], levels: ["agent", "lead", "master"] },
  "agents fetch-base": { routes: ["POST /api/agents/:id/fetch-base"], levels: ["agent", "lead", "master"] },
  "leads start": { routes: ["POST /api/leads"], levels: ["user"] },
  "leads report": { routes: ["POST /api/leads/report"], levels: ["lead"] },
  "leads show": { routes: ["GET /api/leads/:area"], levels: ["lead", "master", "coordinator"] },
  "leads list": { routes: ["GET /api/leads"], levels: ["lead", "master", "coordinator"] },
  "queue add": { routes: ["POST /api/queue"], levels: ["agent", "lead", "master", "coordinator"] },
  "queue show": { routes: ["GET /api/queue/:id"], levels: ["agent", "lead", "master", "coordinator"] },
  "queue list": { routes: ["GET /api/queue"], levels: ["agent", "lead", "master", "coordinator"] },
  "queue withdraw": { routes: ["POST /api/queue/:id/withdraw"], levels: ["agent", "lead", "master", "coordinator"] },
  "queue recommend": { routes: ["POST /api/queue/:id/recommend"], levels: ["lead", "master", "coordinator"] },
  "queue answer": { routes: ["POST /api/queue/:id/answer"], levels: ["user"] },
  "queue undo": { routes: ["POST /api/queue/:id/undo"], levels: ["master"] },
  "brain claim": { routes: ["POST /api/chief/pair/claim"], levels: ["none"] },
  "brain pair": { routes: ["POST /api/chief/pair/start"], levels: ["console"] },
  "brain devices": { routes: ["GET /api/brain/devices"], levels: ["user"] },
  "brain revoke": { routes: ["POST /api/brain/devices/:label/revoke"], levels: ["user"] },
  "brain decision": { routes: ["POST /api/brain/decisions"], levels: ["master"] },
  "brain add": { routes: ["POST /api/brain/rules"], levels: ["master"] },
  "brain list": { routes: ["GET /api/brain/rules"], levels: ["master", "coordinator"] },
  "brain show": { routes: ["GET /api/brain"], levels: ["master", "coordinator"] },
  "brain confirm": { routes: ["POST /api/brain/rules/:id"], levels: ["user"] },
  "brain retire": { routes: ["POST /api/brain/rules/:id"], levels: ["user"] },
  "brain distill": { routes: ["POST /api/brain/distill"], levels: ["user"] },
  "brain apply": { routes: ["POST /api/brain/apply"], levels: ["user"] },
  "brain rollback": { routes: ["POST /api/brain/rollback"], levels: ["user"] },
  "brain import-memory": { routes: ["POST /api/brain/rules"], levels: ["user"] },
  "brain triage": { routes: ["GET /api/brain/rules", "GET /api/brain", "POST /api/brain/rules/:id"], levels: ["user"] },
  "cron list": { routes: ["GET /api/cron/jobs"], levels: ["agent", "lead", "master", "coordinator"] },
  "cron show": { routes: ["GET /api/cron/jobs/:name/runs"], levels: ["agent", "lead", "master", "coordinator"] },
  "cron note": { routes: ["POST /api/cron/jobs/:name/note"], levels: ["master", "coordinator"] },
  "fleet": { routes: ["GET /api/queue", "GET /api/agents", "GET /api/leads", "GET /api/cron/jobs", "GET /api/coordinator"], levels: ["master"] },
  "coordinator": { routes: ["GET /api/coordinator"], levels: ["master"] },
  "coordinator tell": { routes: ["POST /api/coordinator/task"], levels: ["master"] },
  "remind add": { routes: ["POST /api/reminders"], levels: ["agent", "lead", "master"] },
  "remind list": { routes: ["GET /api/reminders"], levels: ["agent", "lead", "master"] },
  "remind cancel": { routes: ["POST /api/reminders/:id/cancel"], levels: ["agent", "lead", "master"] },
};
// Commands that the texts name and that ask the console nothing (they write files): the Recurring
// tasks of the fleet master go through its spool (bin/lib/cron.ts spoolAddEdit).
const NO_API = new Set(["cron add", "cron edit", "cron rm", "cron enable", "cron disable", "cron run"]);
// A text names a command in a short form.
const ALIASES: Record<string, string> = { "agents --json": "agents list", "agents": "agents list", "agents merge": "agents merge-pr", "cron": "cron list", "fleet agents": "fleet", "fleet cron": "fleet", "fleet leads": "fleet", "fleet queue": "fleet" };

// The calls in the code of bin/lib: "<METHOD> <route pattern>", with the `${sub}` of agents.ts
// expanded by the `case` labels of its block.
function cliCalls(): string[] {
  const dir = join(ROOT, "bin", "lib");
  const out = new Set<string>();
  const toRoute = (method: string, path: string): string => {
    const segs = path.split("?")[0].split("/");
    const hit = ROUTES.find((k) => {
      const [m, p] = k.split(" ");
      const rs = p.split("/");
      return m === method && rs.length === segs.length && rs.every((r, i) => r === segs[i] || (r.startsWith(":") && segs[i].includes("${")));
    });
    return hit ?? `${method} ${path} (no such route)`;
  };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.includes(".test.") && n !== "client.ts")) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/\b(?:call|callAsUser|callAsUserLong|callBare)\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*([`"])([^`"]*)\2/g)) {
      const path = m[3];
      if (path.includes("${sub}")) {
        const before = src.slice(0, m.index).split("\n");
        const labels: string[] = [];
        for (let i = before.length - 1; i >= 0 && labels.length < 10; i--) {
          const c = /^\s*case "([a-z-]+)":/.exec(before[i]);
          if (c) labels.push(c[1]);
          else if (labels.length) break;
        }
        for (const l of labels) out.add(toRoute(m[1], path.replace("${sub}", l)));
      } else out.add(toRoute(m[1], path));
    }
  }
  return [...out].sort();
}

const ME = "me";
const deepGood: AccessDeps = {
  agents: { load: async (id: string) => ({ id, spawnedBy: ME } as AgentRecord) },
  queue: { get: async () => ({ agentId: ME }) },
};
const passes = (level: CallerLevel, key: string) => {
  const [method, route] = key.split(" ");
  const p = Object.fromEntries([...route.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1], m[1] === "id" ? ME : "x"]));
  return mayAccess(level, callerOf(level), { method, route, url: route.replace(/:[a-zA-Z]+/g, "x"), params: p, socket: false, loopback: false }, PAGE_ROUTE, deepGood);
};

describe("the command line: every call is in a level's list, or the user's on purpose", () => {
  it("the table holds every call of bin/lib (a new call that is in no list fails here)", () => {
    const table = new Set(Object.values(CLI).flatMap((c) => c.routes));
    const missing = cliCalls().filter((k) => !table.has(k));
    expect(missing).toEqual([]);
    for (const k of table) expect(ROUTES, k).toContain(k);
  });

  it.each(Object.entries(CLI))("%s: it passes for each level that uses it", async (_cmd, c) => {
    for (const level of c.levels.filter((l) => l !== "user")) {
      for (const r of c.routes) expect(await passes(level as CallerLevel, r), `${level} ${r}`).toBe(true);
    }
  });

  it("USER_ONLY: the user's own commands are refused to every agent level and the console's account", async () => {
    const userOnly = Object.entries(CLI).filter(([, c]) => c.levels.length === 1 && c.levels[0] === "user");
    expect(userOnly.map(([k]) => k).sort()).toEqual(["agents merge-pr", "brain apply", "brain confirm", "brain devices", "brain distill", "brain import-memory", "brain retire", "brain revoke", "brain rollback", "brain triage", "leads start", "queue answer"]);
    for (const [cmd, c] of userOnly) {
      for (const level of ["agent", "lead", "console"] as CallerLevel[]) {
        for (const r of c.routes.filter((x) => !x.startsWith("GET "))) expect(await passes(level, r), `${cmd}: ${level} ${r}`).toBe(false);
      }
    }
  });
});

describe("the instruction texts: each command they name passes for that level", () => {
  const tmp = mkdtempSync(join(tmpdir(), "access-texts-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const C = "CLI";
  const choibot = chiefCli("/R");
  const texts: Record<"agent" | "lead" | "master" | "coordinator", string> = {
    agent: agentPrompt({ id: "w1", repo: "app-shop", clone: true, baseBranch: "main" }, join(tmp, "widgets"), { cli: C, brain: "" }),
    lead: leadSystemPrompt({ area: "app-shop", charter: "", repos: ["app-shop"], cli: C, brain: "", chiefDir: tmp }),
    // The lists are the ones of strong protection: the master's text of strong protection.
    master: fleetMasterSystemPrompt({ repoDir: "/R", masterDataDir: tmp, claudeBin: "claude", cronDataDir: tmp, timeZone: "UTC", chief: { cli: C, brain: "" }, env: HARD }),
    coordinator: coordinatorSystemPrompt({ dataDir: tmp, claudeBin: "claude", chief: { cli: C, brain: "" } }),
  };
  const TOPS = "agents|queue|remind|leads|brain|cron|fleet|coordinator";
  function named(text: string): string[] {
    const out = new Set<string>();
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const re = new RegExp(`(?:${esc(C)}|${esc(choibot)}) (${TOPS})(?: ((?:--)?[a-z][a-z-]*(?:\\|[a-z-]+)*))?`, "g");
    for (const m of text.matchAll(re)) {
      for (const sub of (m[2] ?? "").split("|")) {
        const cmd = sub ? `${m[1]} ${sub}` : m[1];
        out.add(ALIASES[cmd] ?? cmd);
      }
    }
    return [...out].sort();
  }

  it("each text names commands (the read works)", () => {
    expect(named(texts.agent)).toEqual(expect.arrayContaining(["agents pr", "agents fetch-base", "queue add", "remind add"]));
    expect(named(texts.lead)).toEqual(expect.arrayContaining(["agents spawn", "agents close", "queue show", "queue recommend", "leads report"]));
    // (`brain decision` was named only to log a merge: the strong text has no merge.)
    expect(named(texts.master)).toEqual(expect.arrayContaining(["coordinator tell", "queue recommend", "queue show"]));
    expect(named(texts.coordinator)).toEqual(expect.arrayContaining(["cron note", "queue recommend"]));
  });

  it("strong protection: the master's text names no merge and no auto answer, and says that the user alone does them; basic mode keeps both", () => {
    expect(named(texts.master)).not.toContain("agents merge-pr");
    expect(named(texts.master)).not.toContain("queue answer");
    expect(texts.master).not.toMatch(/merge-pr|auto:true|"auto":true/);
    expect(texts.master).toMatch(/only the user merges a pull request \(the Merge button of the Queue\)/);
    expect(texts.master).toMatch(/only the user answers a ticket/);
    const basic = fleetMasterSystemPrompt({ repoDir: "/R", masterDataDir: tmp, claudeBin: "claude", cronDataDir: tmp, timeZone: "UTC", chief: { cli: C, brain: "" }, env: { ...HARD, CHIEF_AGENT_UID: undefined } });
    expect(named(basic)).toEqual(expect.arrayContaining(["agents merge-pr", "queue answer"]));
    // The lead's text never named either (it says that merge-pr is refused for leads).
    expect(named(texts.lead)).not.toContain("agents merge-pr");
    expect(named(texts.lead)).not.toContain("queue answer");
  });

  it.each(["agent", "lead", "master", "coordinator"] as const)("%s: every command of its text is in the table, and passes for it", async (level) => {
    for (const cmd of named(texts[level])) {
      if (NO_API.has(cmd)) continue;
      const c = CLI[cmd];
      expect(c, `${level}: "${cmd}" is not a known command`).toBeDefined();
      for (const r of c.routes) expect(await passes(level, r), `${level}: ${cmd} → ${r}`).toBe(true);
    }
  });
});
