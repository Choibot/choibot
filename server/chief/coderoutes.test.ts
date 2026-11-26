// server/chief/coderoutes.test.ts — the code-route gate (spec §3 "Code-route
// gate", "Typed input to persistent agents"; overview decision 45). The real
// service, task, composer and files routes run behind the gate with
// fake terminals: no PTY spawns, no request leaves the test app.
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// No test may reach a real code-server: the proxy upstream is a closed port
// (codeserver.ts reads CODE_SERVER_BIND at import), and spawnSync is a stub
// (only the code-server probe uses it here). spawn runs for real (the files
// guard runs git, grep and find with it) and is watched: startCodeServer in a
// hardened deployment must not call it.
const cp = vi.hoisted(() => {
  process.env.CODE_SERVER_BIND = "127.0.0.1:1";
  return { spawn: vi.fn(), spawnSync: vi.fn(() => ({ status: 1 })) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:child_process")>();
  cp.spawn = vi.fn(m.spawn) as unknown as typeof cp.spawn;
  return { ...m, spawn: cp.spawn, spawnSync: cp.spawnSync };
});

import { ComposerGate, registerComposerApi } from "../agents/composer.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import { registerApi } from "../api.js";
import { editorOff, registerEditorProxy, startCodeServer } from "../codeserver.js";
import { EventHub } from "../events.js";
import { registerFilesApi } from "../files/api.js";
import { REFUSED_TEXT } from "../files/refused.js";
import { createServiceManager } from "../services/manager.js";
import { registerServiceApi } from "../services/api.js";
import { ServiceStore } from "../services/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER, type CallerDeps } from "./auth.js";
import { registerPromptApi } from "../agents/prompt-api.js";
import { filesGuard, registerCodeRouteGate } from "./coderoutes.js";
import { makeGate } from "./gate.js";

type Env = Record<string, string | undefined>;
const ACTIVE: Env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const HARD: Env = { ...ACTIVE, CHIEF_AGENT_UID: "1001" };
// Not hardened: flag off, the chief on without CHIEF_AGENT_UID (rollback), an invalid uid.
const NOT_HARD: [string, Env][] = [["flag off", {}], ["no CHIEF_AGENT_UID", ACTIVE], ["invalid uid", { ...ACTIVE, CHIEF_AGENT_UID: "0" }]];

const USER_TOKEN = "u".repeat(43);
const PAIR = { error: "pair-required", userAuth: "log" };

// A string kind: "lead" is a persistent kind (spec §13) the record type does not list yet.
function rec(id: string, kind?: string): AgentRecord {
  return {
    id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
  };
}
const RECORDS: Record<string, AgentRecord> = {
  "fleet-master": rec("fleet-master", "fleet-master"),
  "lead-1": rec("lead-1", "lead"),
  w1: rec("w1"),
  iss1: rec("iss1", "issue"),
};

const user = { [USER_HEADER]: USER_TOKEN };
const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });

// <base>/ws                       the workspace (files API root)
// <ws>/console                    the console checkout (process.cwd())
// <ws>/console/.env               the console's secrets
// <ws>/console/.agent-worktrees/w1  a worker's worktree, with a symlink to the
//                                 console's .env and one to the checkout
// <ws>/repo                       another dir (no git), with .env.local
// <ws>/gitrepo                    a git repo with an unignored .env.example
let base: string;
let ws: string;
let con: string;
let wt: string;
let repo: string;
let gitrepo: string;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "coderoutes-")));
  ws = join(base, "ws");
  con = join(ws, "console");
  wt = join(con, ".agent-worktrees", "w1");
  repo = join(ws, "repo");
  await mkdir(wt, { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(con, ".env"), "CONSOLE_COOKIE_SECRET=s3cret\n");
  await writeFile(join(con, "server.ts"), "export const x = 1;\n");
  await writeFile(join(wt, "a.ts"), "export function hello() {}\n");
  await writeFile(join(wt, ".env"), "W=1\n");
  await symlink(join(con, ".env"), join(wt, "leak"));
  await symlink(con, join(wt, "up"));
  await writeFile(join(repo, ".env.local"), "X=1\nexport function hi() {}\n");
  await writeFile(join(repo, "a.ts"), "export function hi() {}\nX=1\n");
  gitrepo = join(ws, "gitrepo");
  await mkdir(gitrepo);
  execFileSync("git", ["init", "-q", gitrepo]);
  await writeFile(join(gitrepo, ".env.example"), "TOKEN=abc\nexport function tok() {}\n");
  await writeFile(join(gitrepo, "b.ts"), "const TOKEN = 1;\nexport function tok() {}\n");
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

let app: FastifyInstance;
let ran: string[];
let spawned: string[];
let typed: string[];
let store: ServiceStore;
let svcDir: string;

function fakeTerminals() {
  const live = new Set<string>();
  return {
    spawn(o: { id: string }) { spawned.push(o.id); live.add(o.id); },
    kill(id: string) { live.delete(id); },
    has: (id: string) => live.has(id),
    hasSession: async () => false,
    attach: () => null,
    reattach: async () => null,
    resize() {},
  } as never;
}

type Agents = Pick<SessionStore, "load" | "exists">;
const fakeAgents: Agents = { load: async (id) => RECORDS[id] ?? null, exists: async (id) => id in RECORDS };

// The composer's terminals: every known record is live and ready; a paste is
// recorded by agent id.
function composerTerminals() {
  return {
    has: (id: string) => id in RECORDS,
    hasSession: async () => false,
    inputReady: () => true,
    write: (id: string, data: string) => { if (data !== "\r") typed.push(id); },
    reattach: async () => null,
  } as never;
}

async function build(env: Env, o: { agents?: Agents; afterGate?: (a: FastifyInstance) => void } = {}) {
  ran = [];
  spawned = [];
  typed = [];
  const agents = o.agents ?? fakeAgents;
  const deps: CallerDeps = {
    devices: { verify: async (t: string) => (t === USER_TOKEN ? { label: "laptop", createdAt: 1, lastUsedAt: 1 } : null) },
    agents: fakeAgents,
  };
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps });
  svcDir = await mkdtemp(join(tmpdir(), "coderoutes-svc-"));
  store = new ServiceStore(svcDir);
  await store.save({
    id: "x", createdAt: 1, name: "Pusher", description: "", command: "/bin/true", args: [], cwd: "/tmp", env: {},
    requiresConfirm: false, confirmMessage: "", autoRestart: false,
  });
  const terminals = fakeTerminals();
  const hub = new EventHub();
  app = Fastify();
  registerCodeRouteGate(app, { gate, agents, env });
  // A preHandler after the gate's: the race tests swap files here.
  o.afterGate?.(app);
  registerServiceApi(app, { services: createServiceManager(terminals, store, hub), store, terminals });
  registerApi(app, { hub });
  registerFilesApi(app, { workspaceDir: ws, guard: filesGuard({ gate, env }) });
  registerComposerApi(app, new ComposerGate({
    terminals: composerTerminals(), agentExists: async (id) => (await agents.load(id)) !== null, sleep: async () => {},
  }));
  // The prompt card's routes: a key press is recorded like a typed line.
  registerPromptApi(app, {
    terminals: composerTerminals(), agentExists: async (id) => (await agents.load(id)) !== null, sleep: async () => {},
    prompts: { state: async () => null, screen: async () => ({ cols: 2, rows: 1, lines: ["hi"], cursor: { x: 0, y: 0 } }), list: () => [] },
  });
  // A stand-in that records whether the cron list ran.
  app.get("/api/cron/jobs", async () => {
    ran.push("cron");
    return { jobs: [] };
  });
  await app.ready();
}

beforeEach(() => { vi.spyOn(process, "cwd").mockReturnValue(con); });
afterEach(async () => {
  await app?.close();
  await rm(svcDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  cp.spawn.mockClear();
  cp.spawnSync.mockClear();
});

const inject = (method: "GET" | "HEAD" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string> = {}, payload?: object) =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const content = (p: string, headers: Record<string, string> = {}) => inject("GET", `/api/files/content?path=${encodeURIComponent(p)}`, headers);
const MSG = { msgId: "m-00000001", text: "merge it" };
const input = (id: string, headers: Record<string, string> = {}) => inject("POST", `/api/agents/${id}/input`, headers, MSG);

describe("hardened: services and tasks are USER only", () => {
  beforeEach(async () => { await build(HARD); });

  it("matches the route pattern, not the raw URL: a query string is still gated, a look-alike never reaches the services route", async () => {
    const svc = { name: "n", command: "/bin/sh", cwd: "/tmp" };
    expect((await inject("POST", "/api/services?x=1", {}, svc)).statusCode).toBe(403);
    for (const url of ["/api/services/", "/api//services", "/API/services", "/api/%73ervices"]) {
      expect((await inject("POST", url, {}, svc)).statusCode, url).not.toBe(201);
    }
    expect((await store.list()).map((s) => s.id)).toEqual(["x"]);
  });

  it("POST /api/services: headerless 403 and nothing stored", async () => {
    const res = await inject("POST", "/api/services", {}, { name: "n", command: "/bin/sh", cwd: "/tmp" });
    expect(res.statusCode).toBe(403);
    expect((await store.list()).map((s) => s.id)).toEqual(["x"]);
  });

  it("PATCH /api/services/:id: headerless 403 and the stored service unchanged; USER changes it", async () => {
    const res = await inject("PATCH", "/api/services/x", {}, { command: "/bin/evil" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(PAIR);
    expect((await store.load("x"))?.command).toBe("/bin/true");
    expect((await inject("PATCH", "/api/services/x", agent("w1"), { command: "/bin/evil" })).statusCode).toBe(403);
    expect((await store.load("x"))?.command).toBe("/bin/true");
    const ok = await inject("PATCH", "/api/services/x", user, { command: "/bin/echo" });
    expect(ok.statusCode).toBe(200);
    expect((await store.load("x"))?.command).toBe("/bin/echo");
  });

  it("DELETE /api/services/:id: headerless 403 and the service still there", async () => {
    const res = await inject("DELETE", "/api/services/x");
    expect(res.statusCode).toBe(403);
    expect(await store.load("x")).not.toBeNull();
    expect((await inject("DELETE", "/api/services/x", user)).statusCode).toBe(200);
    expect(await store.load("x")).toBeNull();
  });

  it("POST /api/services/:id/start: headerless and a worker 403, nothing spawned; USER starts it", async () => {
    expect((await inject("POST", "/api/services/x/start", {}, {})).statusCode).toBe(403);
    expect((await inject("POST", "/api/services/x/start", agent("w1"), {})).statusCode).toBe(403);
    expect(spawned).toEqual([]);
    expect((await inject("POST", "/api/services/x/start", user, {})).statusCode).toBe(200);
    expect(spawned).toHaveLength(1);
  });

  it("read routes and fixed-argv routes pass headerless", async () => {
    expect((await inject("GET", "/api/services")).statusCode).toBe(200);
    expect((await inject("GET", "/api/cron/jobs")).statusCode).toBe(200);
    expect(ran).toEqual(["cron"]);
    expect((await inject("POST", "/api/services/x/stop", {}, {})).statusCode).toBe(200);
  });
});

describe("hardened: typed input to persistent agents is USER only", () => {
  beforeEach(async () => { await build(HARD); });

  it("headerless input to the fleet master and a lead: 403, nothing typed", async () => {
    for (const id of ["fleet-master", "lead-1"]) {
      const res = await input(id);
      expect(res.statusCode, id).toBe(403);
      expect(res.json()).toEqual(PAIR);
    }
    expect(typed).toEqual([]);
  });

  it("agent headers on a persistent agent's input: 403 (a worker, and the master itself)", async () => {
    expect((await input("fleet-master", agent("w1"))).statusCode).toBe(403);
    expect((await input("fleet-master", agent("fleet-master"))).statusCode).toBe(403);
    expect(typed).toEqual([]);
  });

  it("USER types into the fleet master", async () => {
    const res = await input("fleet-master", user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ delivered: true });
    expect(typed).toEqual(["fleet-master"]);
  });

  it("a worker and an issue agent get the line; an unknown and an invalid id get the route's own answer", async () => {
    for (const id of ["w1", "iss1"]) expect((await input(id)).json(), id).toEqual({ delivered: true });
    expect(typed).toEqual(["w1", "iss1"]);
    for (const id of ["nobody", "..%2Ffleet-master"]) {
      const res = await input(id);
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toEqual({ reason: "agent-gone" });
    }
  });
});

describe("hardened: the prompt card's routes on a persistent agent are USER only", () => {
  beforeEach(async () => { await build(HARD); });
  const keys = (id: string, headers: Record<string, string> = {}) => inject("POST", `/api/agents/${id}/keys`, headers, { keys: ["down"] });

  it("headerless keys to the fleet master and a lead: 403, nothing typed", async () => {
    for (const id of ["fleet-master", "lead-1"]) {
      const res = await keys(id);
      expect(res.statusCode, id).toBe(403);
      expect(res.json()).toEqual(PAIR);
    }
    expect((await keys("fleet-master", agent("w1"))).statusCode).toBe(403);
    expect((await keys("fleet-master", agent("fleet-master"))).statusCode).toBe(403);
    expect(typed).toEqual([]);
  });

  it("USER presses a key in the fleet master; a worker's keys need no token", async () => {
    expect((await keys("fleet-master", user)).json()).toEqual({ sent: true });
    expect((await keys("w1")).json()).toEqual({ sent: true });
    expect(typed).toEqual(["fleet-master", "w1"]);
    expect((await keys("nobody")).statusCode).toBe(404);
  });

  it("the prompt and the screen of a persistent agent: headerless and agent callers 403, also with HEAD; USER reads them", async () => {
    for (const what of ["prompt", "screen"]) {
      const url = `/api/agents/fleet-master/${what}`;
      const res = await inject("GET", url);
      expect(res.statusCode, what).toBe(403);
      expect(res.json()).toEqual(PAIR);
      expect((await inject("HEAD", url)).statusCode, what).toBe(403);
      expect((await inject("GET", url, agent("w1"))).statusCode, what).toBe(403);
      expect((await inject("GET", `/api/agents/lead-1/${what}`)).statusCode, what).toBe(403);
      expect((await inject("GET", url, user)).statusCode, what).toBe(200);
    }
    expect((await inject("GET", "/api/agents/fleet-master/screen", user)).json().lines).toEqual(["hi"]);
  });

  it("the prompt and the screen of a worker, and the list of prompts, pass headerless", async () => {
    expect((await inject("GET", "/api/agents/w1/prompt")).json()).toEqual({ live: true, prompt: null });
    expect((await inject("GET", "/api/agents/w1/screen")).json().lines).toEqual(["hi"]);
    expect((await inject("GET", "/api/agents/prompts")).json()).toEqual({ prompts: [] });
  });
});

describe("hardened: a record that does not load but exists (half-written) fails closed", () => {
  it("load null and exists true: headerless 403; USER passes to the route", async () => {
    await build(HARD, { agents: { load: async () => null, exists: async () => true } });
    const res = await input("fleet-master");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(PAIR);
    expect((await input("fleet-master", user)).statusCode).toBe(404); // the route's own load: agent-gone
    expect(typed).toEqual([]);
  });

  it("a real SessionStore with a truncated fleet-master.json: headerless 403; a missing record passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coderoutes-agents-"));
    try {
      await writeFile(join(dir, "fleet-master.json"), '{"id":"fleet-ma');
      await build(HARD, { agents: new SessionStore(dir) });
      expect((await input("fleet-master")).statusCode).toBe(403);
      expect((await input("nobody")).statusCode).toBe(404);
      expect(typed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hardened: the files API keeps the console checkout and .env files from non-USER callers", () => {
  beforeEach(async () => { await build(HARD); });

  it("the console's .env: headerless 403 pair-required, a worker 403, USER 403 too (refused in every mode)", async () => {
    const res = await content(join(con, ".env"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(PAIR);
    expect((await content(join(con, ".env"), agent("w1"))).statusCode).toBe(403);
    expect((await content(join(con, ".env"), agent("fleet-master"))).statusCode).toBe(403);
    const refused = await content(join(con, ".env"), user);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: REFUSED_TEXT });
  });

  it("any file in the checkout outside the worktree root: 403; relative and dot-dot paths resolve as the route does", async () => {
    expect((await content(join(con, "server.ts"))).statusCode).toBe(403);
    expect((await content(".env")).statusCode).toBe(403);
    expect((await content("server.ts")).statusCode).toBe(403);
    expect((await content(join(wt, "..", "..", ".env"))).statusCode).toBe(403);
    expect((await content(`${wt}/../../server.ts`)).statusCode).toBe(403);
  });

  it("a worker's worktree under the default .agent-worktrees root: 200 headerless (absolute and relative)", async () => {
    const res = await content(join(wt, "a.ts"));
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe("export function hello() {}\n");
    expect((await content(".agent-worktrees/w1/a.ts")).statusCode).toBe(200);
  });

  it("a symlink in a worktree to the console's .env or checkout is judged by its real path", async () => {
    expect((await content(join(wt, "leak"))).statusCode).toBe(403);
    expect((await content(join(wt, "up", "server.ts"))).statusCode).toBe(403);
    expect((await content(join(wt, "leak"), user)).statusCode).toBe(403);
    expect((await content(join(wt, "up", "server.ts"), user)).statusCode).toBe(200);
  });

  it(".env* anywhere: another repo's .env.local and a worktree's .env, 403 headerless", async () => {
    expect((await content(join(repo, ".env.local"))).statusCode).toBe(403);
    expect((await content(join(wt, ".env"))).statusCode).toBe(403);
    expect((await content(join(repo, "a.ts"))).statusCode).toBe(200);
    expect((await content(join(repo, ".env.local"), user)).statusCode).toBe(200);
  });

  it("HEAD and a repeated path param are refused too", async () => {
    expect((await inject("HEAD", `/api/files/content?path=${encodeURIComponent(join(con, ".env"))}`)).statusCode).toBe(403);
    const twice = `/api/files/content?path=${encodeURIComponent(join(repo, "a.ts"))}&path=${encodeURIComponent(join(con, ".env"))}`;
    expect((await inject("GET", twice)).statusCode).toBe(403);
  });

  it("search, all and definition: the checkout, and a root that holds it, 403; a worktree or another repo 200", async () => {
    for (const r of [con, ws]) {
      const q = encodeURIComponent(r);
      expect((await inject("GET", `/api/files/search?root=${q}&q=s3cret`)).statusCode, r).toBe(403);
      expect((await inject("GET", `/api/files/all?root=${q}`)).statusCode, r).toBe(403);
      expect((await inject("GET", `/api/files/definition?root=${q}&symbol=x`)).statusCode, r).toBe(403);
    }
    for (const r of [wt, repo]) {
      const q = encodeURIComponent(r);
      expect((await inject("GET", `/api/files/search?root=${q}&q=export`)).statusCode, r).toBe(200);
      expect((await inject("GET", `/api/files/all?root=${q}`)).statusCode, r).toBe(200);
      expect((await inject("GET", `/api/files/definition?root=${q}&symbol=hello`)).statusCode, r).toBe(200);
    }
    expect((await inject("GET", `/api/files/search?root=${encodeURIComponent(ws)}&q=s3cret`, user)).statusCode).toBe(200);
  });

  it("files routes outside the four, e.g. the directory list, pass", async () => {
    expect((await inject("GET", `/api/files/list?path=${encodeURIComponent(con)}`)).statusCode).toBe(200);
  });
});

describe("hardened: the files routes check what they open (ruling 2c-3-b)", () => {
  // A preHandler after the gate's that runs fn once, as an agent racing the gate would.
  const race = (fn: () => Promise<void>) => (a: FastifyInstance) => {
    let done = false;
    a.addHook("preHandler", async () => { if (!done) { done = true; await fn(); } });
  };

  it("a file swapped for a symlink to the console's .env after the gate: 403, nothing of it in the body", async () => {
    const f = join(wt, "swap1.txt");
    await writeFile(f, "benign\n");
    await build(HARD, { afterGate: race(async () => { await rm(f); await symlink(join(con, ".env"), f); }) });
    const res = await content(f);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: REFUSED_TEXT }); // the route's own refusal (server/files/refused.ts)
    expect(res.body).not.toContain("s3cret");
  });

  it("a missing path the gate passed, created as such a symlink after it: 403", async () => {
    const f = join(wt, "late1.txt");
    await build(HARD, { afterGate: race(async () => { await symlink(join(con, ".env"), f); }) });
    const res = await content(f);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("s3cret");
  });

  it("a hard link in a worktree to the console's .env: 403 headerless; USER reads it", async () => {
    const f = join(wt, "hard1");
    await link(join(con, ".env"), f);
    await build(HARD);
    const res = await content(f);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("s3cret");
    expect((await content(f, user)).json().content).toBe("CONSOLE_COOKIE_SECRET=s3cret\n");
  });

  it("a search root swapped for a symlink to the checkout after the gate: 403", async () => {
    const d = join(wt, "sub1");
    await mkdir(d);
    await writeFile(join(d, "c.ts"), "s3cret-free\n");
    await build(HARD, { afterGate: race(async () => { await rm(d, { recursive: true }); await symlink(con, d); }) });
    const res = await inject("GET", `/api/files/search?root=${encodeURIComponent(d)}&q=s3cret`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("CONSOLE_COOKIE_SECRET");
  });

  it("search, all and definition drop .env* paths for a non-USER caller (grep and find fallbacks, git); USER gets them", async () => {
    await build(HARD);
    const rels = (r: { json(): { results?: { rel: string }[]; candidates?: { rel: string }[] } }) =>
      (r.json().results ?? r.json().candidates ?? []).map((x) => x.rel).sort();
    const q = encodeURIComponent(repo); // no git: the grep and find fallbacks
    const g = encodeURIComponent(gitrepo); // git, with an unignored .env.example
    expect(rels(await inject("GET", `/api/files/search?root=${q}&q=X%3D1`))).toEqual(["a.ts"]);
    expect((await inject("GET", `/api/files/all?root=${q}`)).json().files).toEqual(["a.ts"]);
    expect(rels(await inject("GET", `/api/files/search?root=${g}&q=TOKEN`))).toEqual(["b.ts"]);
    expect((await inject("GET", `/api/files/all?root=${g}`)).json().files).toEqual(["b.ts"]);
    expect(rels(await inject("GET", `/api/files/definition?root=${g}&symbol=tok`))).toEqual(["b.ts"]);

    expect(rels(await inject("GET", `/api/files/search?root=${q}&q=X%3D1`, user))).toEqual([".env.local", "a.ts"]);
    expect((await inject("GET", `/api/files/all?root=${q}`, user)).json().files).toEqual([".env.local", "a.ts"]);
    expect(rels(await inject("GET", `/api/files/search?root=${g}&q=TOKEN`, user))).toEqual([".env.example", "b.ts"]);
    expect((await inject("GET", `/api/files/all?root=${g}`, user)).json().files).toEqual([".env.example", "b.ts"]);
    expect(rels(await inject("GET", `/api/files/definition?root=${g}&symbol=tok`, user))).toEqual([".env.example", "b.ts"]);
  });

  // S2 (2c-3 minor): git grep quotes a path with a non-ASCII byte unless
  // core.quotepath=off, and always one with a quote or control char; a quoted
  // first component (".env\303\251…) must not pass `hidden`.
  it("search and definition drop a .env* file whose name git would quote, for a non-USER caller", async () => {
    await writeFile(join(gitrepo, ".env\u00e9x"), "QUOTED=1\nexport function quo() {}\n");
    await writeFile(join(gitrepo, '.env"q'), "QUOTED=2\nexport function quo() {}\n");
    await writeFile(join(gitrepo, "c.ts"), "QUOTED=3\nexport function quo() {}\n");
    await build(HARD);
    const g = encodeURIComponent(gitrepo);
    const rels = (r: { json(): { results?: { rel: string }[]; candidates?: { rel: string }[] } }) =>
      (r.json().results ?? r.json().candidates ?? []).map((x) => x.rel).sort();
    expect(rels(await inject("GET", `/api/files/search?root=${g}&q=QUOTED`))).toEqual(["c.ts"]);
    expect(rels(await inject("GET", `/api/files/definition?root=${g}&symbol=quo`))).toEqual(["c.ts"]);
    // USER gets them all (the unguarded route, as before).
    expect(rels(await inject("GET", `/api/files/search?root=${g}&q=QUOTED`, user))).toHaveLength(3);
  });

  it("a root that is no directory gives the route's empty answer", async () => {
    await build(HARD);
    const f = encodeURIComponent(join(repo, "a.ts"));
    expect((await inject("GET", `/api/files/search?root=${f}&q=hi`)).json()).toEqual({ results: [] });
    expect((await inject("GET", `/api/files/all?root=${f}`)).json()).toEqual({ files: [] });
    expect((await inject("GET", `/api/files/definition?root=${f}&symbol=hi`)).json()).toEqual({ candidates: [] });
  });

  it("a worktree file and a worktree search still answer headerless", async () => {
    await build(HARD);
    expect((await content(join(wt, "a.ts"))).json().content).toBe("export function hello() {}\n");
    const res = await inject("GET", `/api/files/search?root=${encodeURIComponent(wt)}&q=hello`);
    expect(res.json().results.map((r: { rel: string }) => r.rel)).toEqual(["a.ts"]);
  });
});

describe("hardened: AGENT_WORKTREE_ROOT", () => {
  it("absolute elsewhere: the checkout's .agent-worktrees is no exception", async () => {
    await build({ ...HARD, AGENT_WORKTREE_ROOT: join(base, "elsewhere") });
    expect((await content(join(wt, "a.ts"))).statusCode).toBe(403);
    expect((await content(join(repo, "a.ts"))).statusCode).toBe(200);
  });

  it("a root that is the checkout itself makes no exception", async () => {
    await build({ ...HARD, AGENT_WORKTREE_ROOT: "." });
    expect((await content(join(con, "server.ts"))).statusCode).toBe(403);
  });

  it("a relative root is resolved inside the checkout", async () => {
    await build({ ...HARD, AGENT_WORKTREE_ROOT: ".agent-worktrees/w1" });
    expect((await content(join(wt, "a.ts"))).statusCode).toBe(200);
  });
});

describe("not hardened: every route as today", () => {
  for (const [i, [name, env]] of NOT_HARD.entries()) {
    it(`${name}: services, persistent input and console files pass headerless`, async () => {
      await build(env, { agents: { load: async () => null, exists: async () => true } });
      expect((await inject("PATCH", "/api/services/x", {}, { command: "/bin/echo" })).statusCode).toBe(200);
      expect((await store.load("x"))?.command).toBe("/bin/echo");
      expect((await inject("POST", "/api/services/x/start", {}, {})).statusCode).toBe(200);
      // No gate: even a record that exists but does not load reaches the route.
      expect((await input("fleet-master")).json()).toEqual({ reason: "agent-gone" });
      expect((await inject("POST", "/api/agents/fleet-master/keys", {}, { keys: ["down"] })).json()).toEqual({ reason: "agent-gone" });
      expect((await inject("GET", "/api/agents/fleet-master/prompt")).json()).toEqual({ reason: "agent-gone" });
      expect((await inject("GET", "/api/agents/fleet-master/screen")).json()).toEqual({ reason: "agent-gone" });
      // The console's own .env is refused in every mode (server/files/refused.ts); another repo's is not.
      expect((await content(join(con, ".env"))).statusCode).toBe(403);
      expect((await content(join(repo, ".env.local"))).statusCode).toBe(200);
      const found = await inject("GET", `/api/files/search?root=${encodeURIComponent(ws)}&q=s3cret`);
      expect(found.statusCode).toBe(200);
      expect(found.json().results.map((r: { path: string }) => r.path)).not.toContain(join(con, ".env"));
      expect((await inject("DELETE", "/api/services/x")).statusCode).toBe(409); // still running from start
    });

    it(`${name}: no files guard, the files routes run today's code`, async () => {
      const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async () => null }, agents: fakeAgents } });
      expect(filesGuard({ gate, env })).toBeUndefined();
      const f = join(wt, `hard-nh-${i}`);
      await link(join(con, ".env"), f);
      await build(env);
      expect((await content(f)).json().content).toBe("CONSOLE_COOKIE_SECRET=s3cret\n");
      const q = encodeURIComponent(repo);
      expect((await inject("GET", `/api/files/all?root=${q}`)).json().files).toEqual([".env.local", "a.ts"]);
      expect((await inject("GET", `/api/files/search?root=${q}&q=X%3D1`)).json().results.map((r: { rel: string }) => r.rel).sort()).toEqual([".env.local", "a.ts"]);
      expect(cp.spawn).not.toHaveBeenCalled(); // execFile only, as today
    });
  }
});

describe("the editor (overview decision 45)", () => {
  it("editorOff is hardenedDeployment", () => {
    expect(editorOff(HARD)).toBe(true);
    for (const [name, env] of NOT_HARD) expect(editorOff(env), name).toBe(false);
    expect(editorOff()).toBe(false); // CHIEF_* scrubbed by vitest.setup.ts
  });

  it("hardened: /editor/ is not registered (404) and code-server is not started", async () => {
    const a = Fastify();
    registerEditorProxy(a, HARD);
    await a.ready();
    expect((await a.inject({ method: "GET", url: "/editor/" })).statusCode).toBe(404);
    expect(a.hasRoute({ method: "GET", url: "/editor/*" })).toBe(false);
    await a.close();
    expect(startCodeServer(HARD)).toBeNull();
    expect(cp.spawnSync).not.toHaveBeenCalled();
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("not hardened: the /editor proxy routes are registered as today (no request is sent upstream)", async () => {
    for (const [name, env] of NOT_HARD) {
      const a = Fastify();
      registerEditorProxy(a, env);
      await a.ready();
      expect(a.hasRoute({ method: "GET", url: "/editor/*" }), name).toBe(true);
      await a.close();
    }
  });
});
