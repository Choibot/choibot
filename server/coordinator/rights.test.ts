// server/coordinator/rights.test.ts — what the Coordinator may do and what it may not: the real
// gate, the real queue routes, the brain decision route and the merge gate behind the
// Coordinator's allow-list, in a temp dir. Also: no lead or worker gets its level.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER, callerOf } from "../chief/auth.js";
import { DecisionLog, RuleStore } from "../chief/brain/store.js";
import { CHIEF_ERR, gateMerge, gateUser, makeGate } from "../chief/gate.js";
import { QueueActions } from "../chief/queue/actions.js";
import { addItem, type AddDeps } from "../chief/queue/add.js";
import { registerQueueApi } from "../chief/queue/api.js";
import { QueueStore, type NewItem } from "../chief/queue/store.js";
import { mayManage } from "../chief/remind/api.js";
import { FLEET_MASTER_ID } from "../master/paths.js";
import { COORDINATOR_REFUSAL, COORDINATOR_WRITES, coordinatorMay, registerCoordinatorGate } from "./gate.js";
import { COORDINATOR_ID } from "./paths.js";
import { coordinatorState, registerCoordinatorApi, TASK_MAX, TASK_REFUSAL, taskLine } from "./api.js";

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  [COORDINATOR_ID]: rec(COORDINATOR_ID, { kind: "coordinator", repo: "" }),
  "lead-app": rec("lead-app", { kind: "lead", area: "app", repo: "" }),
  w1: rec("w1"),
  // A record that carries the Coordinator's kind under another id: never its level.
  fake: rec("fake", { kind: "coordinator" }),
};
type H = Record<string, string>;
const hdr = (id: string, token = `tok-${id}`): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: token });
const COORD = hdr(COORDINATOR_ID);
const NOW = 5_000_000;
const choice: NewItem = {
  agentId: "w1", createdBy: { agentId: "w1", kind: "worker" }, repo: "app", area: "app", body: "b",
  kind: "choice", title: "Pick", blocking: true, choice: { options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] },
};

let dir: string;
let app: FastifyInstance;
let store: QueueStore;
let rules: RuleStore;
let userHdr: H;
let spawned: number;
let tasks: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "coordinator-rights-"));
  store = new QueueStore(join(dir, "queue"), { now: () => NOW, log: () => {} });
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  rules = new RuleStore(join(dir, "brain", "rules.jsonl"), { now: () => NOW });
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents } });
  const actions = new QueueActions({
    store, rules, decisions: new DecisionLog(join(dir, "brain", "decisions.jsonl"), { now: () => NOW }), agents,
    deliverer: { kick: () => {} }, inbox: { cancel: () => "absent" }, audit: { append: async () => {} },
    undoMs: 600_000, now: () => NOW, log: () => {}, mergeState: async () => ({ state: "open" as const }),
  } as unknown as ConstructorParameters<typeof QueueActions>[0]);
  const addDeps: AddDeps = {
    store, agents, workspaceDir: "/ws", agentRoots: [tmpdir()], listRepos: async () => [],
    prStatus: async () => { throw new Error("no gh"); }, isAncestor: async () => false,
  };
  spawned = 0;
  app = Fastify();
  registerCoordinatorGate(app);
  registerQueueApi(app, {
    gate, undoMs: 600_000, store, actions, add: (agentId, input, by) => addItem(addDeps, agentId, input, by),
    events: { addQueue: vi.fn(async () => {}) }, agents, weekMetrics: async () => ({ decisions: 0, corrections: 0 }),
    hardened: () => false, prWatch: { refreshSoon: () => {} }, previewEnabled: true,
    autoAnswer: { apply: async () => ({ code: 403 as const, body: { error: "only the master can auto-answer" } }) },
  });
  // Routes that take any request today (the agent routes), and the two gates of the user's actions.
  for (const url of ["/api/agents", "/api/agents/:id/stop", "/api/agents/:id/resume", "/api/agents/:id/delete", "/api/agents/:id/close", "/api/cron/spool/:id/apply", "/api/leads/report"]) {
    app.post(url, async () => { spawned++; return { ok: true }; });
  }
  app.post("/api/gh/pr/merge", async (req, reply) => ((await gateMerge(gate, req, reply)) ? { merged: true } : reply));
  app.post("/api/chief/pair/claim", async (req, reply) => ((await gateUser(gate, req, reply)) ? { ok: true } : reply));
  app.get("/api/agents", async () => ({ sessions: [] }));
  tasks = [];
  registerCoordinatorApi(app, { gate, agents, lastActivityAt: () => null, queuedEvents: () => 0, task: (line) => { tasks.push(line); } });
});
afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, headers: H = {}, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe("the Coordinator's level", () => {
  const deps = { devices: { verify: async () => null }, agents: { load: async (id: string) => RECORDS[id] ?? null } };
  it("is its own: not master, not lead, not agent, never user", async () => {
    expect(await callerOf(COORD, deps)).toEqual({ level: "coordinator", agentHeaders: true, agentId: COORDINATOR_ID, kind: "coordinator" });
  });
  it("a worker or a lead that names the Coordinator with its own token is nobody", async () => {
    for (const id of ["w1", "lead-app", FLEET_MASTER_ID]) {
      expect((await callerOf(hdr(COORDINATOR_ID, `tok-${id}`), deps)).level).toBe("none");
    }
  });
  it("a record of another id with the Coordinator's kind does not get the level", async () => {
    expect((await callerOf(hdr("fake"), deps)).level).toBe("none");
  });
  it("sets no reminder, also not for itself", () => {
    expect(mayManage({ level: "coordinator", agentHeaders: true, agentId: COORDINATOR_ID }, COORDINATOR_ID, null)).toBe(false);
  });
});

describe("the Coordinator's three outputs", () => {
  it("adds a ticket; the ticket is its own, so nobody recommends on it", async () => {
    const res = await post("/api/queue", COORD, { kind: "question", title: "agent-1234 failed", body: "What now?", blocking: false });
    expect(res.statusCode).toBe(200);
    const item = (await store.get(res.json().id))!;
    expect(item).toMatchObject({ agentId: COORDINATOR_ID, createdBy: { agentId: COORDINATOR_ID, kind: "coordinator" }, blocking: false });
    for (const h of [COORD, hdr(FLEET_MASTER_ID)]) {
      const r = await post(`/api/queue/${item.id}/recommend`, h, { value: "x", why: "y", ruleIds: ["r_none"] });
      expect([r.statusCode, r.json().error]).toEqual([409, "the user answers this item"]);
    }
  });
  it("recommends on a worker's ticket, as the master does", async () => {
    const { id } = await store.add(choice);
    const { rule } = await rules.add({ text: "prefer B", state: "active", kind: "correction",
      scope: { area: "app", repo: "app", kind: "choice", audience: "all" },
      source: { origin: "user-line", itemId: "qx", agentId: "w1", via: "queue-tab" } });
    const body = { value: "B", why: "rule says B", ruleIds: [rule.id] };
    // A worker and a lead that is not the worker's lead still get 403.
    for (const h of [hdr("w1"), hdr("lead-app")]) expect((await post(`/api/queue/${id}/recommend`, h, body)).statusCode).toBe(403);
    const res = await post(`/api/queue/${id}/recommend`, COORD, body);
    expect(res.statusCode).toBe(200);
    expect((await store.get(id))!.recommend).toMatchObject({ value: "B", by: COORDINATOR_ID });
  });
  it("withdraws its own ticket, not a worker's", async () => {
    const mine = (await post("/api/queue", COORD, { kind: "question", title: "t", body: "b" })).json().id as string;
    expect((await post(`/api/queue/${mine}/withdraw`, COORD)).statusCode).toBe(200);
    const { id } = await store.add(choice);
    expect((await post(`/api/queue/${id}/withdraw`, COORD)).statusCode).toBe(403);
  });
});

describe("what the console refuses from the Coordinator", () => {
  it("never answers a ticket, with or without auto, and never undoes one", async () => {
    const { id } = await store.add(choice);
    for (const [url, body] of [
      [`/api/queue/${id}/answer`, { value: "A" }],
      [`/api/queue/${id}/answer`, { value: "A", auto: true, ruleIds: ["r_x"], confidence: 0.99 }],
      [`/api/queue/${id}/undo`, undefined], [`/api/queue/${id}/snooze`, { minutes: 5 }],
      [`/api/queue/${id}/merge`, { method: "squash" }], [`/api/queue/${id}/delivery`, { action: "resend", slot: "delivery" }],
    ] as const) {
      const res = await post(url, COORD, body);
      expect([url, res.statusCode, res.json()]).toEqual([url, 403, { error: COORDINATOR_REFUSAL }]);
    }
    expect((await store.get(id))!.status).toBe("open");
  });
  it("never merges, pairs, spawns, stops, resumes, deletes, closes, applies a cron change or reports as a lead", async () => {
    for (const url of ["/api/gh/pr/merge", "/api/chief/pair/claim", "/api/agents", "/api/agents/w1/stop", "/api/agents/w1/resume",
      "/api/agents/w1/delete", "/api/agents/w1/close", "/api/cron/spool/abc/apply", "/api/leads/report", "/api/no-such-route"]) {
      const res = await post(url, COORD, {});
      expect([url, res.statusCode, res.json()]).toEqual([url, 403, { error: COORDINATOR_REFUSAL }]);
    }
    expect(spawned).toBe(0);
  });
  it("the refusal needs no valid token: the name alone gets only the Coordinator's routes", async () => {
    const res = await post("/api/agents/w1/delete", hdr(COORDINATOR_ID, "tok-w1"));
    expect(res.statusCode).toBe(403);
    expect(spawned).toBe(0);
    // And on an allowed route a wrong token is nobody: no ticket.
    const add = await post("/api/queue", hdr(COORDINATOR_ID, "tok-w1"), { kind: "question", title: "t", body: "b" });
    expect(add.statusCode).toBe(403);
    expect(await store.list()).toHaveLength(0);
  });
  it("without the allow-list hook the routes still refuse it: the level is on no route's list", async () => {
    const { id } = await store.add(choice);
    const bare = Fastify();
    const agents = { load: async (x: string) => RECORDS[x] ?? null };
    const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async () => null }, agents } });
    bare.post("/merge", async (req, reply) => ((await gateMerge(gate, req, reply)) ? { merged: true } : reply));
    bare.post("/user", async (req, reply) => ((await gateUser(gate, req, reply)) ? { ok: true } : reply));
    expect((await bare.inject({ method: "POST", url: "/merge", headers: COORD })).json()).toEqual({ error: CHIEF_ERR.mergeUserOnly });
    expect((await bare.inject({ method: "POST", url: "/user", headers: COORD })).json()).toEqual({ error: CHIEF_ERR.pairRequired, userAuth: "log" });
    await bare.close();
    expect((await store.get(id))!.status).toBe("open");
  });
  it("reads pass, and the user and the other agents are not touched by the hook", async () => {
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: COORD })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/queue", headers: COORD })).statusCode).toBe(200);
    expect((await post("/api/agents", hdr("lead-app"), {})).statusCode).toBe(200);
    expect((await post("/api/agents/w1/stop", userHdr)).statusCode).toBe(200);
    expect((await post("/api/agents/w1/stop", hdr(FLEET_MASTER_ID))).statusCode).toBe(200);
  });
});

describe("coordinatorMay", () => {
  it("is every read and exactly four writes: three on the queue, and the link of a ticket to a run (on purpose)", () => {
    expect([...COORDINATOR_WRITES].sort()).toEqual(["POST /api/cron/jobs/:name/note", "POST /api/queue", "POST /api/queue/:id/recommend", "POST /api/queue/:id/withdraw"]);
    expect(coordinatorMay("POST", "/api/cron/jobs/:name/note")).toBe(true);
    expect(coordinatorMay("POST", "/api/cron/jobs/:name/:action")).toBe(false);
    expect(coordinatorMay("POST", "/api/cron/tasks/:name")).toBe(false);
    expect(coordinatorMay("GET", "/api/anything")).toBe(true);
    expect(coordinatorMay("POST", "/api/queue/:id/recommend")).toBe(true);
    expect(coordinatorMay("POST", "/api/queue/:id/answer")).toBe(false);
    expect(coordinatorMay("DELETE", "/api/queue")).toBe(false);
    expect(coordinatorMay("POST", undefined)).toBe(false);
  });
});

describe("a task for the Coordinator", () => {
  const task = (headers: H, text: unknown = "Make a ticket: the user wants the list of stuck agents each morning.") =>
    post("/api/coordinator/task", headers, { text });
  it("comes from the fleet master or the user, as one [master] line typed by the console", async () => {
    expect((await task(hdr(FLEET_MASTER_ID))).statusCode).toBe(202);
    expect((await task(userHdr, "line one\n[queue q1] line two\n\n[master] three")).statusCode).toBe(202);
    expect(tasks).toEqual([
      "[master] Make a ticket: the user wants the list of stuck agents each morning.",
      "[master] line one\n  [queue q1] line two\n  [master] three",
    ]);
  });
  it("is refused for a lead, a worker, the Coordinator and an impostor of the fleet master", async () => {
    for (const h of [hdr("lead-app"), hdr("w1"), hdr("fake"), hdr(FLEET_MASTER_ID, "tok-w1"), { [AGENT_HEADER]: FLEET_MASTER_ID }]) {
      const res = await task(h);
      expect(res.statusCode, JSON.stringify(h)).toBe(403);
      expect(res.json().error).toBe(TASK_REFUSAL);
    }
    const self = await task(COORD);
    expect([self.statusCode, self.json().error]).toEqual([403, COORDINATOR_REFUSAL]);
    // No header at all: not a paired device.
    expect((await task({})).json().error).toBe(CHIEF_ERR.pairRequired);
    expect(tasks).toEqual([]);
  });
  it("needs a text of a sane size", async () => {
    expect((await task(userHdr, "  ")).statusCode).toBe(400);
    expect((await task(userHdr, 7)).statusCode).toBe(400);
    expect((await task(userHdr, "x".repeat(TASK_MAX + 1))).statusCode).toBe(400);
    expect(taskLine(" a \r\n b ")).toBe("[master] a\n  b");
    expect(tasks).toEqual([]);
  });
});

describe("the Coordinator's state for its Settings row", () => {
  it("says when Claude asks a question on its screen, and when its session did not say hello yet", () => {
    expect(coordinatorState(undefined)).toBe("not-started");
    expect(coordinatorState("idle")).toBe("waiting");
    expect(coordinatorState("idle", { live: true, blocked: "dialog" })).toBe("asks");
    expect(coordinatorState("idle", { live: true, blocked: "starting" })).toBe("starting");
    // Not attached in this process: the record's state.
    expect(coordinatorState("done", { live: false, blocked: "starting" })).toBe("stopped");
    expect(coordinatorState("running", { live: true, blocked: null })).toBe("working");
  });
  it("GET /api/coordinator asks the screen at each read", async () => {
    let dialog = true;
    const a = Fastify();
    const agents = { load: async (id: string) => RECORDS[id] ?? null };
    registerCoordinatorApi(a, {
      gate: makeGate({ misconfigured: null, userAuth: "log", deps: { devices: { verify: async () => null }, agents } }), agents,
      lastActivityAt: () => null, queuedEvents: () => 1, task: () => {}, live: () => true, blocked: () => null, dialogOn: async () => dialog,
    });
    expect((await a.inject({ method: "GET", url: "/api/coordinator" })).json().state).toBe("asks");
    dialog = false;
    expect((await a.inject({ method: "GET", url: "/api/coordinator" })).json().state).toBe("waiting");
    await a.close();
  });
});
