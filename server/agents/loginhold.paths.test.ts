// server/agents/loginhold.paths.test.ts — the base of "Sign out" is inert. resumeAgent is the start
// path of every agent of the live console, and it now asks the hold (agents/loginhold.ts). With
// nothing held (no file, an empty file, a broken file, a file that cannot be read) each start path
// starts exactly what it starts with no hold at all, as on main: the boot, the ensures of the fleet
// master (a message, the Master tab) and of the Coordinator (its feed), the relaunch, a move, and
// the Resume of the page. A quiet stop can come only from the exit handler's own set. And the two
// changes that are not inert: a start of the routes asks the second sign-in's wait, and a resume
// that waits sends no "idle".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LoginHold } from "./loginhold.js";
import { reconcileAgents, resumeAgent, switchAccount, type RecoveryCtx } from "./recovery.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { registerAgentApi } from "./api.js";
import { ensureFleetMaster } from "../master/master.js";
import { ensureCoordinator } from "../coordinator/coordinator.js";
import { relaunchForChief, type ChiefRelaunchCtx } from "../chief/relaunch.js";
import { ChiefWait } from "../chief/chiefwait.js";

const W = "11111111-1111-4111-8111-111111111111";
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hold-paths-"));
  // The persistent agents' prompts and homes read these: never the live console's.
  vi.stubEnv("CHIEF_DATA_DIR", join(dir, "chief"));
  vi.stubEnv("MASTER_DATA_DIR", join(dir, "master"));
  vi.stubEnv("COORDINATOR_DATA_DIR", join(dir, "coordinator"));
});
afterEach(async () => { vi.unstubAllEnvs(); await chmod(join(dir, "held.json"), 0o600).catch(() => {}); await rm(dir, { recursive: true, force: true }); });

type Spawned = { id: string; cwd: string; args: string[]; env?: Record<string, string> };

// A fake manager: `live` ids have a session; a kill ends it a tick later.
function fakeTerms(live: string[] = []) {
  const ids = new Set(live);
  const spawned: Spawned[] = [];
  return {
    spawned,
    has: (id: string) => ids.has(id),
    hasSession: async () => false,
    reattach: async () => null,
    spawn: (o: Spawned) => { ids.add(o.id); spawned.push({ id: o.id, cwd: o.cwd, args: o.args, env: o.env }); },
    kill: (id: string) => { setTimeout(() => ids.delete(id), 5); },
    lastInputAt: () => undefined, lastOutputAt: () => undefined,
    write() {}, resize() {}, attach() { return null; },
  };
}

const rec = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "", worktree: join(dir, "ws"), cwd: join(dir, "ws"), branch: "", baseBranch: "", sessionId: null,
  hookToken: "tok", status: "idle", createdAt: 1, ...over,
} as AgentRecord);

// The states of the hold's file in which nothing is held.
const STATES: Array<[string, () => Promise<void>]> = [
  ["no file", async () => {}],
  ["an empty file", async () => { await writeFile(join(dir, "held.json"), ""); }],
  ["an empty object", async () => { await writeFile(join(dir, "held.json"), "{}"); }],
  ["a file that is not JSON", async () => { await writeFile(join(dir, "held.json"), "{not json"); }],
  ["JSON that is not an object of ids", async () => { await writeFile(join(dir, "held.json"), JSON.stringify(["fleet-master"])); }],
  ["a folder in place of the file (a read error)", async () => { await mkdir(join(dir, "held.json")); }],
  ["a file that cannot be read (a read error)", async () => { await writeFile(join(dir, "held.json"), JSON.stringify({ "fleet-master": "default" })); await chmod(join(dir, "held.json"), 0); }],
];

async function holdIn(state: () => Promise<void>): Promise<LoginHold> {
  await state();
  // canStart is never asked when nothing is held; it throws to prove that.
  const h = new LoginHold({ file: join(dir, "held.json"), canStart: async () => { throw new Error("asked"); }, log: () => {} });
  await h.load();
  return h;
}

// Each start path, in fresh fakes, with the hold or with none; what it started.
async function startPaths(hold: LoginHold | undefined): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const seam = { claudeHooksPathFor: () => join(dir, "hooks.json"), writeClaudeHookSettings: async () => {} };
  const ctxOf = (recs: AgentRecord[], t: ReturnType<typeof fakeTerms>): RecoveryCtx => ({
    port: 3100, workspaceDir: join(dir, "ws"), ...seam,
    store: { list: async () => recs, patch: async () => {}, load: async (id: string) => recs.find((r) => r.id === id) ?? null } as never,
    terminals: t as never, ...(hold ? { loginHold: hold } : {}),
  });
  const kinds: AgentRecord[] = [rec(W), rec("fleet-master", { kind: "fleet-master" }), rec("coordinator", { kind: "coordinator" }), rec("lead-web", { kind: "lead", area: "web" })];
  // The boot.
  { const t = fakeTerms(); const r = await reconcileAgents(ctxOf(kinds, t)); out.boot = { r: { ...r, failed: r.failed.length }, spawned: t.spawned }; }
  // resumeAgent of each kind (an ensure, a reconcile, a retry: they all end here).
  for (const r of kinds) { const t = fakeTerms(); out[`resume:${r.id}`] = { outcome: await resumeAgent(r, ctxOf([r], t)), spawned: t.spawned }; }
  // The fleet master's ensure (a message, the Master tab, Telegram) and the Coordinator's (its feed).
  {
    const store = new SessionStore(join(dir, `agents-m-${hold ? 1 : 0}`));
    const t = fakeTerms();
    const ctx: RecoveryCtx = { port: 3100, workspaceDir: join(dir, "ws"), ...seam, store, terminals: t as never, ...(hold ? { loginHold: hold } : {}) };
    await ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir: join(dir, `master-${hold ? 1 : 0}`) });
    out.ensureFleet = t.spawned.map((s) => s.id);
  }
  {
    vi.stubEnv("CHIEF_ENABLED", "1"); vi.stubEnv("CHIEF_USER_AUTH", "log"); vi.stubEnv("CHIEF_CONSOLE_URL", "http://127.0.0.1:4999");
    const store = new SessionStore(join(dir, `agents-c-${hold ? 1 : 0}`));
    const t = fakeTerms();
    const ctx: RecoveryCtx = { port: 3100, workspaceDir: join(dir, "ws"), ...seam, store, terminals: t as never, ...(hold ? { loginHold: hold } : {}) };
    await ensureCoordinator({ store, recoveryCtx: ctx, dataDir: join(dir, `coordinator-${hold ? 1 : 0}`), markStarting: () => {}, isLive: async () => false });
    out.ensureCoordinator = t.spawned.map((s) => s.id);
    vi.unstubAllEnvs();
    vi.stubEnv("CHIEF_DATA_DIR", join(dir, "chief")); vi.stubEnv("MASTER_DATA_DIR", join(dir, "master")); vi.stubEnv("COORDINATOR_DATA_DIR", join(dir, "coordinator"));
  }
  // The relaunch of a live lead (a new prompt, a move of the chief of staff).
  {
    const lead = rec("lead-web", { kind: "lead", area: "web" });
    const t = fakeTerms(["lead-web"]);
    const store = new SessionStore(join(dir, `agents-r-${hold ? 1 : 0}`));
    await store.save(lead);
    const ctx: ChiefRelaunchCtx = {
      port: 3100, workspaceDir: join(dir, "ws"), ...seam, store, terminals: t as never, ...(hold ? { loginHold: hold } : {}),
      hub: new EventHub(), relaunching: new Set(), onRelaunch: () => {}, ensureFleet: async () => "fleet-master",
      masterHasDraft: () => false, afterRelaunch: async () => {}, canResume: async () => true,
      waitGone: async (id) => { await new Promise((r) => setTimeout(r, 15)); return !t.has(id); },
    };
    out.relaunch = { r: await relaunchForChief("lead-web", ctx, { force: true }), spawned: t.spawned.map((s) => s.id) };
  }
  // A move of a live worker to another login.
  {
    const w = rec(W);
    const t = fakeTerms([W]);
    out.move = { r: await switchAccount(w, "work", ctxOf([w], t)), spawned: t.spawned.map((s) => [s.id, s.env?.CLAUDE_CONFIG_DIR ?? null]) };
  }
  // The Resume of the page (the route's own recovery context).
  {
    const store = new SessionStore(join(dir, `agents-p-${hold ? 1 : 0}`));
    await store.save(rec(W));
    const t = fakeTerms();
    const a = Fastify();
    registerAgentApi(a, { terminals: t as never, store, hub: new EventHub(), workspaceDir: join(dir, "ws"), ...(hold ? { loginHold: hold } : {}) });
    const r = await a.inject({ method: "POST", url: `/api/agents/${W}/resume` });
    out.resumeRoute = { status: r.statusCode, outcome: r.json().outcome, spawned: t.spawned.map((s) => s.id) };
    await a.close();
  }
  return out;
}

describe("the hold is inert while nothing is held", () => {
  it("each start path starts the same as with no hold at all (main), for each state of the file; a read error never stops a start", async () => {
    await mkdir(join(dir, "ws"), { recursive: true });
    const main = await startPaths(undefined);
    // The paths started something (else the comparison would prove nothing).
    // The boot's reconcile starts the workers and the fleet master; a lead and the Coordinator
    // start at boot by their own ensures (resumeAgent: the lines below).
    expect((main.boot as { spawned: Spawned[] }).spawned.map((s) => s.id).sort()).toEqual(["fleet-master", W].sort());
    for (const id of [W, "fleet-master", "coordinator", "lead-web"]) expect((main[`resume:${id}`] as { spawned: Spawned[] }).spawned.map((s) => s.id), id).toEqual([id]);
    expect(main.ensureFleet).toEqual(["fleet-master"]);
    expect(main.ensureCoordinator).toEqual(["coordinator"]);
    expect(main.relaunch).toEqual({ r: { outcome: "relaunched" }, spawned: ["lead-web"] });
    expect(main.resumeRoute).toMatchObject({ status: 202, spawned: [W] });
    for (const [name, state] of STATES) {
      await rm(join(dir, "held.json"), { recursive: true, force: true }).catch(() => {});
      const hold = await holdIn(state);
      expect(hold.waitsFor("fleet-master"), name).toBe(false);
      expect(await startPaths(hold), name).toEqual(main);
      await chmod(join(dir, "held.json"), 0o600).catch(() => {});
    }
  });
});

describe("a quiet stop comes only from the exit handler's own set", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  async function sources(d: string, out: string[] = []): Promise<string[]> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await sources(p, out);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it("the scan: only the exit handler and the sign-out route make an event with quiet; only the sign-out route adds an id, after the paired owner's gate; the set is made in index.ts and given only to those two", async () => {
    const files = await sources(root);
    const withQuiet: string[] = [];
    const adds: string[] = [];
    for (const f of files) {
      const text = await readFile(f, "utf8");
      if (/emitEvent\(\{[^}]*quiet:/.test(text)) withQuiet.push(f.slice(root.length));
      if (/quiet(Exits)?\??\.add\(/.test(text)) adds.push(f.slice(root.length));
    }
    expect(withQuiet.sort()).toEqual(["agents/api.ts", "agents/exit.ts"]);
    expect(adds).toEqual(["agents/api.ts"]);
    // In api.ts: the one add is inside POST /api/accounts/:id/logout, after its gateUser.
    const api = await readFile(join(root, "agents/api.ts"), "utf8");
    const route = api.indexOf('app.post("/api/accounts/:id/logout"');
    const next = api.indexOf("app.", route + 10);
    const gate = api.indexOf("gateUser(deps.chief, req, reply)", route);
    const add = api.indexOf("quietExits.add(");
    expect(route).toBeGreaterThan(0);
    expect(api.indexOf("quietExits.add(", add + 1)).toBe(-1);
    expect(gate > route && gate < add && add < next).toBe(true);
    const index = await readFile(join(root, "index.ts"), "utf8");
    expect(index.match(/quietExits/g)).toHaveLength(3); // made, given to agentExitHandler, given to the agents' API
    expect(index).toMatch(/agentExitHandler\(\{[^}]*quiet: quietExits/);
  });

  it("an agent cannot end silently: a hook or a stop with quiet in its body gives a plain status", async () => {
    const store = new SessionStore(join(dir, "agents-q"));
    await store.save(rec(W, { hookToken: "t" }));
    const hub = new EventHub();
    const events: ConsoleEvent[] = [];
    hub.subscribe((e) => { events.push(e); });
    const a = Fastify();
    registerAgentApi(a, { terminals: fakeTerms() as never, store, hub, workspaceDir: join(dir, "ws") });
    await a.inject({ method: "POST", url: `/api/agents/${W}/hook?token=t`, payload: { hook_event_name: "Stop", session_id: "s1", quiet: true } });
    await a.inject({ method: "POST", url: `/api/agents/${W}/stop`, payload: { quiet: true } });
    const status = events.filter((e) => e.type === "agent-status");
    expect(status.length).toBeGreaterThanOrEqual(2);
    for (const e of status) expect(e).not.toHaveProperty("quiet");
    await a.close();
  });
});

describe("what changes (not inert)", () => {
  const STRONG = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242", CHIEF_PERSISTENT_UID: "4343" };

  async function resumeMaster(chiefWait: { waits: () => string[]; mayStart?: ChiefWait["mayStart"] }) {
    for (const [k, v] of Object.entries(STRONG)) vi.stubEnv(k, v);
    const store = new SessionStore(join(dir, `agents-s-${Math.random()}`));
    await store.save(rec("fleet-master", { kind: "fleet-master", status: "done" }));
    const hub = new EventHub();
    const events: ConsoleEvent[] = [];
    hub.subscribe((e) => { events.push(e); });
    const t = fakeTerms();
    const a = Fastify();
    registerAgentApi(a, { terminals: t as never, store, hub, workspaceDir: join(dir, "ws"), chiefWait });
    const r = await a.inject({ method: "POST", url: "/api/agents/fleet-master/resume" });
    await a.close();
    return { outcome: r.json().outcome as string, spawned: t.spawned.map((s) => s.id), idle: events.some((e) => e.type === "agent-status" && e.status === "idle"), status: (await store.load("fleet-master"))?.status };
  }

  it("strong protection: the Resume of the page asks the second sign-in's wait; with no second sign-in nothing starts and no idle is sent (main started a Claude at its login screen)", async () => {
    await mkdir(join(dir, "ws"), { recursive: true });
    // As on main: the route did not ask (a wait with no mayStart).
    expect(await resumeMaster({ waits: () => [] })).toMatchObject({ spawned: ["fleet-master"], idle: true });
    // Now: no second sign-in → it waits, nothing starts, its status stays.
    const out = new ChiefWait({ signedIn: async () => false, log: () => {} });
    expect(await resumeMaster(out)).toEqual({ outcome: "waits", spawned: [], idle: false, status: "done" });
    expect(out.waitsFor("fleet-master")).toBe(true);
    // With the second sign-in: as before.
    const inn = new ChiefWait({ signedIn: async () => true, log: () => {} });
    expect(await resumeMaster(inn)).toMatchObject({ spawned: ["fleet-master"], idle: true });
  });
});
