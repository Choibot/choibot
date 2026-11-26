// server/chief/deploy/service.test.ts — the console's own deploy ticket and the Deploy action
// (spec §5.7): who can start it, what can make the ticket, and the ticket's life. The real gate,
// queue store, queue routes, QueueActions and AutoAnswer in a temp dir; git and the runner launch
// are fakes (runner.test.ts runs the real runner).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import type { TgUpdate } from "../../issues/telegram.js";
import { EventQueue, queueDigestLine, requeueDigest } from "../../master/events.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, PairingCodes, USER_HEADER } from "../auth.js";
import { DecisionLog, RuleStore } from "../brain/store.js";
import { CHIEF_ERR, makeGate } from "../gate.js";
import { QueueActions } from "../queue/actions.js";
import { addItem, type AddDeps } from "../queue/add.js";
import { registerQueueApi } from "../queue/api.js";
import { AuditLog, AutoAnswer } from "../queue/auto.js";
import { answeredCardText, parseItemCallback, queueCardKeyboard, queueCardText } from "../queue/cards.js";
import { Deliverer } from "../queue/deliver.js";
import { formatAnswerLine } from "../queue/lines.js";
import { parseAddInput, parseRecommend, validateUserAnswer } from "../queue/schema.js";
import { QueueStore } from "../queue/store.js";
import type { QueueItem } from "../queue/types.js";
import { ChiefTelegram } from "../telegram.js";
import { registerDeployApi } from "./api.js";
import type { DeployGit } from "./git.js";
import { mergedPrs } from "./git.js";
import { DeployService, type DeployDeps, type RunnerConfig } from "./service.js";
import { CONSOLE_AGENT_ID, DEPLOY_CLOSED, deployBody, deployTitle, runLine, type DeployRun } from "./ticket.js";

const sha = (c: string): string => c.repeat(40);
// One line of history, oldest first: A is live, B..D merge later.
const A = sha("a"), B = sha("b"), C = sha("c"), D = sha("d"), X = sha("e");
const LINE = [A, B, C, D];
const COMMITS: Record<string, { subject: string; body: string }> = {
  [B]: { subject: "Merge pull request #5 from Octo-owner/agent/92109cd8", body: "feat(master): queue tickets in the Master pane's thread\n" },
  [C]: { subject: "fix(queue): one more thing (#6)", body: "" },
  [D]: { subject: "Merge pull request #7 from Octo-owner/agent/x", body: "feat: third\n" },
};

type GitState = { remote: string; tracked: string | null; head: string; branch: string; dirty: string[]; changed: string[]; down: boolean; fetches: number };

function fakeGit(g: GitState): DeployGit {
  const at = (s: string): number => {
    const n = LINE.indexOf(s);
    if (n < 0) throw new Error(`unknown commit ${s.slice(0, 7)}`);
    return n;
  };
  return {
    remoteHead: async () => { if (g.down) throw new Error("could not resolve host github.com"); return g.remote; },
    trackedHead: async () => g.tracked,
    fetch: async () => { g.fetches++; g.tracked = g.remote; },
    head: async () => g.head,
    branch: async () => g.branch,
    isAncestor: async (a, b) => (a === X || b === X ? false : at(a) <= at(b)),
    count: async (from, to) => Math.max(0, at(to) - at(from)),
    commits: async (from, to) => LINE.slice(at(from) + 1, at(to) + 1).reverse().map((s) => COMMITS[s]!),
    blockedFiles: async () => g.dirty.filter((f) => g.changed.includes(f)),
  };
}

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app-shop", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  a1: rec("a1"),
  "lead-app": rec("lead-app", { kind: "lead" as AgentRecord["kind"] }),
};
type H = Record<string, string>;
const agentHdr = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });

let dir: string;
let now: number;
let store: QueueStore;
let git: GitState;
let launched: RunnerConfig[];
let alive: boolean;
let launchError: string | null;
let logs: string[];
let svc: DeployService;
let app: FastifyInstance;
let userHdr: H;
let rules: RuleStore;
let actions: QueueActions;
let stateFile: string;

function service(o: Partial<DeployDeps> = {}): DeployService {
  return new DeployService({
    store, dir: "/srv/choibot", unit: "choibot.service", armed: { ok: true },
    boot: { head: A, build: A, at: 1_000 }, git: fakeGit(git), stateFile, logDir: join(dir, "deploy"), pnpm: ["/opt/pnpm"],
    launch: async (cfg) => { if (launchError) throw new Error(launchError); launched.push(cfg); alive = true; },
    runnerAlive: async () => alive, now: () => now, log: (s) => { logs.push(s); }, newId: () => `d${launched.length + 1}`,
    ...o,
  });
}

async function build(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "chief-deploy-"));
  now = 5_000_000;
  stateFile = join(dir, "deploy", "state.json");
  store = new QueueStore(join(dir, "queue"), { now: () => now, log: () => {} });
  git = { remote: B, tracked: A, head: A, branch: "main", dirty: [], changed: [], down: false, fetches: 0 };
  launched = []; alive = false; launchError = null; logs = [];
  svc = service();
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  rules = new RuleStore(join(dir, "brain", "rules.jsonl"), { now: () => now });
  const decisions = new DecisionLog(join(dir, "brain", "decisions.jsonl"), { now: () => now });
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents } });
  const audit = new AuditLog(join(dir, "audit", "auto.jsonl"));
  actions = new QueueActions({
    store, rules, decisions, agents, deliverer: { kick: () => {} }, inbox: { cancel: () => "absent" },
    audit, undoMs: 600_000, now: () => now, log: () => {}, mergeState: async () => ({ state: "unknown" as const, why: "no gh in tests" }),
  });
  const autoAnswer = new AutoAnswer({
    store, rules, agents, audit, deliverer: { kick: () => {} }, mode: () => "hardened", threshold: 0.85, undoMs: 600_000, now: () => now, log: () => {},
  });
  const addDeps: AddDeps = {
    store, agents, workspaceDir: "/ws", agentRoots: [tmpdir()], listRepos: async () => [],
    prStatus: async () => { throw new Error("no gh in tests"); }, isAncestor: async () => false,
  };
  app = Fastify();
  registerQueueApi(app, {
    gate, undoMs: 600_000, store, actions, autoAnswer,
    add: (agentId, input, createdBy) => addItem(addDeps, agentId, input, createdBy),
    events: { addQueue: async () => {} }, agents, weekMetrics: async () => ({ decisions: 0, corrections: 0 }),
    hardened: () => false, prWatch: { refreshSoon: () => {} }, previewEnabled: true, now: () => now, log: () => {},
  });
  registerDeployApi(app, { gate, deploy: svc, log: (s) => { logs.push(s); } });
}

beforeEach(build);
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const tickets = async (): Promise<QueueItem[]> => (await store.list()).filter((i) => i.kind === "deploy");
const ticket = async (): Promise<QueueItem> => (await tickets()).at(-1)!;
const state = (): Record<string, unknown> => JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
// What the runner would write.
const runnerWrites = (patch: Record<string, unknown>): void => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch, updatedAt: now }));
const post = (headers: H = {}, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/deploy", headers, ...(payload !== undefined ? { payload } : {}) });

describe("the ticket: only the console's own check makes it", () => {
  it("appears when origin/main is ahead of the running build, with the merged PRs", async () => {
    await svc.check();
    const t = await ticket();
    expect(t).toMatchObject({
      kind: "deploy", status: "open", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
      repo: "choibot", blocking: false, title: "Console: 1 commit merged, not live",
      deploy: { live: A, target: B, count: 1, prs: [{ number: 5, title: "feat(master): queue tickets in the Master pane's thread" }], more: 0 },
    });
    expect(t.body).toBe("#5 feat(master): queue tickets in the Master pane's thread\nLive: aaaaaaa · main: bbbbbbb");
    expect(git.fetches).toBe(1);
  });

  it("updates the one ticket when more commits merge, and never makes a second one", async () => {
    await svc.check();
    const first = await ticket();
    git.remote = D;
    await svc.check();
    await svc.check();
    const all = await tickets();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    expect(all[0].title).toBe("Console: 3 commits merged, not live");
    expect(all[0].deploy?.prs.map((p) => p.number)).toEqual([7, 6, 5]);
  });

  it("closes itself when the running build has all of main", async () => {
    await svc.check();
    // A deploy by hand: a new server boots at B.
    const next = service({ boot: { head: B, build: B, at: 2_000 } });
    await next.check();
    expect(await ticket()).toMatchObject({ status: "withdrawn", lastError: DEPLOY_CLOSED.live });
    await next.check();
    expect(await tickets()).toHaveLength(1);
  });

  it("makes no ticket when nothing is ahead, when origin cannot be read, or when the build recorded no commit", async () => {
    git.remote = A;
    await svc.check();
    expect(await tickets()).toEqual([]);
    git.remote = B; git.down = true;
    await svc.check();
    expect(await tickets()).toEqual([]);
    git.down = false;
    await service({ boot: { head: A, build: null, at: 1_000 } }).check();
    expect(await tickets()).toEqual([]);
    expect(logs.some((l) => l.includes("recorded no commit"))).toBe(true);
  });

  it("the live commit is the older of the build and the booted code", async () => {
    expect(await service({ boot: { head: B, build: A, at: 1 } }).liveCommit()).toBe(A);
    expect(await service({ boot: { head: A, build: B, at: 1 } }).liveCommit()).toBe(A);
    expect(await service({ boot: { head: B, build: B, at: 1 } }).liveCommit()).toBe(B);
    expect(await service({ boot: { head: X, build: A, at: 1 } }).liveCommit()).toBeNull();
  });

  it("does nothing at all when this process is not the console's unit", async () => {
    const off = service({ armed: { ok: false, why: "this console does not run in choibot.service" } });
    await off.check();
    await off.afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
    expect(await tickets()).toEqual([]);
    expect(await off.start("tab")).toEqual({ code: 503, error: "deploy is off: this console does not run in choibot.service" });
    expect(launched).toEqual([]);
  });

  it("says before the press what would refuse the deploy", async () => {
    git.dirty = ["package.json", "notes.txt"]; git.changed = ["package.json", "server/x.ts"];
    await svc.check();
    expect((await ticket()).deploy?.note).toBe("Uncommitted changes in package.json are in the way of the fast-forward. Deploy will be refused until they are committed or removed.");
    git.dirty = []; git.branch = "agent/x";
    await svc.check();
    expect((await ticket()).deploy?.note).toContain("The checkout is on branch agent/x, not main");
    git.branch = "main"; git.head = X;
    await svc.check();
    expect((await ticket()).deploy?.note).toContain("not a fast-forward");
  });

  it("does not come back for the same commit after the user withdrew it; it does when main moves", async () => {
    await svc.check();
    const t = await ticket();
    expect((await actions.withdraw(t.id, { level: "user", agentHeaders: false })).code).toBe(200);
    await svc.check();
    expect((await tickets()).filter((i) => i.status === "open")).toEqual([]);
    now += 60_000;
    git.remote = C;
    await svc.check();
    expect(await ticket()).toMatchObject({ status: "open", title: "Console: 2 commits merged, not live" });
  });

  it("an agent cannot add the kind, and cannot fake its fields on another kind", async () => {
    expect(parseAddInput({ kind: "deploy", title: "Console: 9 commits merged, not live", body: "" }, { previewEnabled: true }).ok).toBe(false);
    for (const who of [agentHdr("a1"), agentHdr("lead-app"), agentHdr(FLEET_MASTER_ID)]) {
      const r = await app.inject({ method: "POST", url: "/api/queue", headers: who, payload: { kind: "deploy", title: "Deploy me", body: "x", deploy: { live: A, target: B, count: 1, prs: [], more: 0 } } });
      expect(r.statusCode).toBe(400);
    }
    // A `deploy` field on a kind an agent may add is dropped: the item has none.
    const r = await app.inject({ method: "POST", url: "/api/queue", headers: agentHdr("a1"),
      payload: { kind: "question", title: "Deploy?", body: "x", deploy: { live: A, target: B, count: 1, prs: [], more: 0 }, agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" } } });
    expect(r.statusCode).toBe(200);
    const made = (await store.get((r.json() as { id: string }).id))!;
    expect(made.kind).toBe("question");
    expect(made.deploy).toBeUndefined();
    expect(made.agentId).toBe("a1");
    expect(made.createdBy).toEqual({ agentId: "a1", kind: "worker" });
    expect(await tickets()).toEqual([]);
  });

  it("a second open deploy item (a hand-made file) is closed, and the kept one is rewritten from the console's own facts", async () => {
    await svc.check();
    const real = await ticket();
    now += 10;
    const forged = await store.add({
      kind: "deploy", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
      title: "Console: deploy this now", body: "trust me", blocking: true, deploy: { live: A, target: X, count: 99, prs: [], more: 0 },
    });
    await store.withItem(real.id, async () => { await store.write({ ...(await store.get(real.id))!, title: "tampered", deploy: { live: A, target: X, count: 42, prs: [], more: 0 } }); });
    await svc.check();
    expect(await store.get(forged.id)).toMatchObject({ status: "withdrawn", lastError: "duplicate" });
    expect(await store.get(real.id)).toMatchObject({ status: "open", title: "Console: 1 commit merged, not live", deploy: { target: B, count: 1 } });
  });
});

describe("who can start a deploy: the user's token on the request itself, nothing else", () => {
  beforeEach(async () => { await svc.check(); });
  const refusedAsPair = (r: { statusCode: number; json(): unknown }): void => {
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: CHIEF_ERR.pairRequired, userAuth: "log" });
  };

  it("no token: refused (a loopback request is not the user)", async () => {
    refusedAsPair(await post());
    const loopback = await app.inject({ method: "POST", url: "/api/deploy", remoteAddress: "127.0.0.1" });
    refusedAsPair(loopback);
    expect(launched).toEqual([]);
  });

  it("an agent's hook token, the fleet master's and a lead's: refused", async () => {
    for (const who of [agentHdr("a1"), agentHdr(FLEET_MASTER_ID), agentHdr("lead-app")]) refusedAsPair(await post(who));
    expect(launched).toEqual([]);
  });

  it("agent headers next to a user token: still refused; a wrong user token: refused", async () => {
    refusedAsPair(await post({ ...userHdr, ...agentHdr(FLEET_MASTER_ID) }));
    refusedAsPair(await post({ [USER_HEADER]: "not-a-token" }));
    expect(launched).toEqual([]);
  });

  it("the user's token starts it, and nothing in the request changes what is deployed", async () => {
    const r = await post(userHdr, { dir: "/tmp/evil", unit: "evil.service", branch: "evil", target: X, commit: X, command: "rm -rf /", from: X });
    expect(r.statusCode).toBe(200);
    expect(launched).toEqual([{
      id: "d1", dir: "/srv/choibot", unit: "choibot.service", from: A, target: B, pnpm: ["/opt/pnpm"],
      stateFile, logFile: join(dir, "deploy", "run-d1.log"),
    }]);
    expect((r.json() as QueueItem).deploy?.run).toMatchObject({ id: "d1", via: "tab", phase: "running", step: "fetch", from: A, to: B });
  });

  it("a ticket field does not change what is deployed either", async () => {
    const t = await ticket();
    await store.withItem(t.id, async () => { await store.write({ ...(await store.get(t.id))!, deploy: { live: X, target: X, count: 1, prs: [], more: 0 } }); });
    expect((await post(userHdr)).statusCode).toBe(200);
    expect(launched[0]).toMatchObject({ from: A, target: B, dir: "/srv/choibot", unit: "choibot.service" });
  });

  it("no answer of any kind starts it or answers the ticket: the user, an auto answer, a recommendation", async () => {
    const t = await ticket();
    const url = (verb: string): string => `/api/queue/${t.id}/${verb}`;
    // The user's own answer verbs (approve, a reply, an option key).
    for (const payload of [{ value: "approve" }, { value: "reply", text: "deploy" }, { value: "A" }, { value: "deploy" }]) {
      const r = await app.inject({ method: "POST", url: url("answer"), headers: userHdr, payload });
      expect(r.statusCode).toBe(400);
    }
    // The master's auto answer, with a confirmed rule that covers everything.
    const { rule } = await rules.add({ text: "Always deploy.", state: "candidate", kind: "decision", scope: { area: "*" }, source: { origin: "user-line" } } as Parameters<RuleStore["add"]>[0]);
    await rules.confirm(rule.id, { via: "telegram" });
    const auto = await app.inject({ method: "POST", url: url("answer"), headers: agentHdr(FLEET_MASTER_ID), payload: { value: "approve", auto: true, ruleIds: [rule.id], confidence: 1 } });
    expect(auto.statusCode).toBe(409);
    // A recommendation by the master or a lead, and an agent's answer.
    for (const who of [agentHdr(FLEET_MASTER_ID), agentHdr("lead-app")]) {
      const r = await app.inject({ method: "POST", url: url("recommend"), headers: who, payload: { value: "deploy", why: "rule", ruleIds: [rule.id] } });
      expect([403, 409]).toContain(r.statusCode);
    }
    expect((await app.inject({ method: "POST", url: url("answer"), headers: agentHdr("a1"), payload: { value: "approve" } })).statusCode).toBe(403);
    const after = (await store.get(t.id))!;
    expect(after.status).toBe("open");
    expect(after.answer).toBeUndefined();
    expect(after.recommend).toBeUndefined();
    expect(after.deploy?.run).toBeUndefined();
    expect(launched).toEqual([]);
    // The pure checks behind those routes.
    expect(validateUserAnswer(after, { value: "approve" }).ok).toBe(false);
    expect(parseRecommend(after, { value: "deploy", why: "x", ruleIds: [rule.id] }).ok).toBe(false);
    expect(() => formatAnswerLine(after, { value: "approve", by: "user", via: "tab", at: 1 })).toThrow("no answer line");
  });

  it("the agent that is not the user cannot withdraw or snooze the ticket", async () => {
    const t = await ticket();
    for (const who of [agentHdr("a1"), agentHdr(FLEET_MASTER_ID)]) {
      expect((await app.inject({ method: "POST", url: `/api/queue/${t.id}/withdraw`, headers: who })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/queue/${t.id}/snooze`, headers: who, payload: { minutes: 60 } })).statusCode).toBe(403);
    }
    expect((await store.get(t.id))!.status).toBe("open");
  });

  it("GET /api/deploy says where deploy stands, to any session", async () => {
    const r = await app.inject({ method: "GET", url: "/api/deploy" });
    expect(r.json()).toMatchObject({ armed: true, unit: "choibot.service", branch: "main", remote: "origin", live: A, target: B, count: 1, run: null });
  });
});

describe("the master gets no event for the ticket, and no agent path touches it", () => {
  it("no digest line can carry the kind", async () => {
    expect(queueDigestLine({ itemId: "q12345678", kind: "deploy" as never, repo: "choibot" })).toBeNull();
    await svc.check();
    const added: string[] = [];
    requeueDigest(await store.list(), { addQueue: async (id) => { added.push(id); } });
    expect(added).toEqual([]);
    const q = new EventQueue({ hub: { subscribe: () => () => {} }, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false }, log: () => {} });
    expect(q.addQueueLine("q12345678", "deploy" as never, "choibot")).toBe(false);
    expect(q.digest()).toBeNull();
  });

  it("the queue scanner does not close it as agent-gone (the ticket has no agent)", async () => {
    await svc.check();
    const d = new Deliverer({
      store, agents: { load: async () => null, exists: async () => false }, composer: { inputInternal: async () => ({ code: 404, body: { error: "x" } }) as never },
      inbox: { pushConsole: async () => {} } as never, rules: { hit: async () => {} } as never, hub: { subscribe: () => () => {} }, undoMs: 600_000, now: () => now, log: () => {},
    });
    await d.tick();
    expect((await ticket()).status).toBe("open");
  });
});

describe("the run", () => {
  beforeEach(async () => { await svc.check(); });

  it("a second press while a deploy runs does nothing", async () => {
    expect((await svc.start("tab")).code).toBe(200);
    const again = await svc.start("tab");
    expect(again).toMatchObject({ code: 409, error: "a deploy already runs" });
    expect((await post(userHdr)).statusCode).toBe(409);
    expect(launched).toHaveLength(1);
  });

  it("two presses at once start one run", async () => {
    const [a, b] = await Promise.all([svc.start("tab"), svc.start("telegram")]);
    expect([a.code, b.code].sort()).toEqual([200, 409]);
    expect(launched).toHaveLength(1);
  });

  it("deploys what is merged at the press, not what the ticket showed a minute ago", async () => {
    git.remote = C;
    expect((await svc.start("tab")).code).toBe(200);
    expect(launched[0]).toMatchObject({ from: A, target: C });
    expect((await ticket()).title).toBe("Console: 2 commits merged, not live");
  });

  it("refuses when origin cannot be read, and when nothing is ahead", async () => {
    git.down = true;
    expect(await svc.start("tab")).toMatchObject({ code: 502 });
    git.down = false; git.remote = A; git.tracked = A;
    expect(await svc.start("tab")).toMatchObject({ code: 409, error: "nothing to deploy: the running build has all of main" });
    expect(launched).toEqual([]);
  });

  it("shows the runner's progress on the ticket, then its failure with the error tail; nothing restarted", async () => {
    await svc.start("tab");
    runnerWrites({ step: "typecheck" });
    await svc.mirror();
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "running", step: "typecheck" });
    runnerWrites({ phase: "failed", step: "typecheck", error: "the typecheck failed", tail: "server/x.ts(3,1): error TS2322", endedAt: now });
    alive = false;
    await svc.mirror();
    const t = await ticket();
    expect(t.status).toBe("open");
    expect(t.deploy?.run).toMatchObject({ phase: "failed", step: "typecheck", error: "the typecheck failed", tail: "server/x.ts(3,1): error TS2322" });
    expect(runLine(t.deploy?.run)).toBe("Deploy failed at typecheck: the typecheck failed. Nothing restarted.");
    // The button works again.
    expect((await svc.start("tab")).code).toBe(200);
    expect(launched).toHaveLength(2);
  });

  it("a runner that did not start is a failed run, not a running one", async () => {
    launchError = "Unit choibot-deploy.service already exists";
    const r = await svc.start("tab");
    expect(r.code).toBe(502);
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "failed", error: "the deploy runner did not start: Unit choibot-deploy.service already exists" });
    expect(state().phase).toBe("failed");
  });

  it("a run whose runner is gone is set to failed while the console runs", async () => {
    await svc.start("tab");
    runnerWrites({ step: "build" });
    alive = false;
    await svc.mirror();
    expect((await ticket()).deploy?.run?.phase).toBe("running"); // inside the start grace
    now += 30_000;
    await svc.mirror();
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "failed", step: "build", error: "the deploy stopped at build: its runner is gone" });
  });

  it("a restart that never came is set to failed", async () => {
    await svc.start("tab");
    runnerWrites({ step: "restart" });
    alive = false;
    now += 60_000;
    await svc.mirror();
    expect((await ticket()).deploy?.run?.phase).toBe("running");
    now += 200_000;
    await svc.mirror();
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "failed", step: "restart", error: "the restart did not happen" });
  });

  it("the new server writes the result at its boot: live commit, agents alive, rollback commit; the ticket closes", async () => {
    await svc.start("tab");
    const t = await ticket();
    runnerWrites({ step: "restart" });
    alive = false;
    now += 20_000;
    // The console restarted: a new process, booted at B after the run started.
    const next = service({ boot: { head: B, build: B, at: now } });
    await next.afterBoot({ alive: ["x", "y", "z"], resumed: ["r"], cold: [], failed: [] });
    const done = (await store.get(t.id))!;
    expect(done).toMatchObject({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed, closedAt: now });
    expect(done.deploy?.run).toMatchObject({ phase: "done", from: A, to: B, alive: 3, resumed: 1, failed: 0, endedAt: now });
    expect(runLine(done.deploy?.run)).toBe("Deployed · live bbbbbbb · 3 agents alive · 1 started again · rollback aaaaaaa");
    expect(state()).toMatchObject({ phase: "done", alive: 3 });
    // Main moved while the deploy ran: a new ticket for the rest.
    git.remote = C;
    await next.check();
    expect(await ticket()).toMatchObject({ status: "open", title: "Console: 1 commit merged, not live", deploy: { live: B, target: C } });
    expect((await ticket()).id).not.toBe(t.id);
  });

  it("a restart into another build is a failed run", async () => {
    await svc.start("tab");
    runnerWrites({ step: "restart" });
    alive = false;
    now += 20_000;
    await service({ boot: { head: A, build: A, at: now } }).afterBoot(undefined);
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "failed", error: "the console restarted, but the running build is aaaaaaa, not bbbbbbb" });
  });

  it("a deploy that died halfway is failed at the next boot, never running for ever", async () => {
    await svc.start("tab");
    runnerWrites({ step: "build" });
    alive = false;
    now += 3_600_000;
    await service({ boot: { head: B, build: A, at: now } }).afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
    const t = await ticket();
    expect(t.status).toBe("open");
    expect(t.deploy?.run).toMatchObject({ phase: "failed", step: "build", error: "the deploy stopped at build: its runner is gone" });
  });

  it("a boot while the runner still works leaves the run running", async () => {
    await svc.start("tab");
    runnerWrites({ step: "build" });
    now += 60_000;
    const next = service({ boot: { head: A, build: A, at: now } });
    await next.afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
    expect((await ticket()).deploy?.run).toMatchObject({ phase: "running", step: "build" });
    next.startWatch()();
  });

  describe("a runner that checks the new server itself (checks: true)", () => {
    it("the console passes its loopback URL to the runner, and only that", async () => {
      const own = service({ checkUrl: "http://127.0.0.1:3100" });
      await own.check();
      expect((await own.start("tab")).code).toBe(200);
      expect(launched[0]).toMatchObject({ url: "http://127.0.0.1:3100", target: B });
      const none = service({ checkUrl: null });
      runnerWrites({ phase: "failed", error: "x", endedAt: now });
      alive = false;
      expect((await none.start("tab")).code).toBe(200);
      expect(launched[1]).not.toHaveProperty("url");
    });

    it("the new server leaves the result to the runner; the ticket closes as deployed when the runner writes done", async () => {
      await svc.start("tab");
      const t = await ticket();
      runnerWrites({ step: "restart", checks: true });
      now += 20_000;
      const next = service({ boot: { head: B, build: B, at: now } });
      await next.afterBoot({ alive: ["x", "y"], resumed: [], cold: ["c"], failed: [] });
      // Booted, but the check has not passed yet: the run goes on.
      expect((await store.get(t.id))!.status).toBe("open");
      expect(state()).toMatchObject({ phase: "running", step: "restart" });
      runnerWrites({ step: "check" });
      await next.mirror();
      expect((await ticket()).deploy?.run).toMatchObject({ phase: "running", step: "check" });
      runnerWrites({ phase: "done", checked: 13, endedAt: now });
      alive = false;
      await next.mirror();
      const done = (await store.get(t.id))!;
      expect(done).toMatchObject({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed });
      expect(done.deploy?.run).toMatchObject({ phase: "done", step: "check", checked: 13, alive: 2, resumed: 1, failed: 0 });
      expect(runLine(done.deploy?.run)).toBe("Deployed · live bbbbbbb · page and 13 files load · 2 agents alive · 1 started again · rollback aaaaaaa");
      expect(state()).toMatchObject({ phase: "done", alive: 2 });
      next.startWatch()();
    });

    it("a runner that wrote done before the new server read the state: closed as deployed at boot", async () => {
      await svc.start("tab");
      const t = await ticket();
      runnerWrites({ phase: "done", step: "check", checks: true, checked: 9, endedAt: now });
      alive = false;
      now += 20_000;
      await service({ boot: { head: B, build: B, at: now } }).afterBoot({ alive: ["x"], resumed: [], cold: [], failed: [] });
      expect((await store.get(t.id))!).toMatchObject({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed });
    });

    it("a failed check and its roll back: the ticket stays open with the error, and says the unit restarted", async () => {
      await svc.start("tab");
      runnerWrites({ step: "check", checks: true });
      now += 20_000;
      const next = service({ boot: { head: B, build: B, at: now } });
      await next.afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
      const error = "the new build failed the check: 2 of the 13 files the page links do not load. Rolled back to build aaaaaaa: it passes the check";
      runnerWrites({ phase: "failed", error, tail: "404 /_next/static/css/x.css", endedAt: now });
      alive = false;
      await next.mirror();
      const t = await ticket();
      expect(t.status).toBe("open");
      expect(t.deploy?.run).toMatchObject({ phase: "failed", step: "check", error });
      expect(runLine(t.deploy?.run)).toBe(`Deploy failed at check: ${error}.`);
      next.startWatch()();
    });

    it("a checking runner that died after the restart is a failed run, not running for ever", async () => {
      await svc.start("tab");
      runnerWrites({ step: "check", checks: true });
      now += 30_000;
      const next = service({ boot: { head: B, build: B, at: now } });
      alive = true;
      await next.afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
      expect((await ticket()).deploy?.run?.phase).toBe("running");
      alive = false;
      await next.mirror();
      expect((await ticket()).deploy?.run).toMatchObject({ phase: "failed", step: "check", error: "the deploy stopped at check: its runner is gone" });
      next.startWatch()();
    });

    it("an older runner (no checks) still gets its result from the new server at boot", async () => {
      await svc.start("tab");
      const t = await ticket();
      runnerWrites({ step: "restart" });
      alive = false;
      now += 20_000;
      await service({ boot: { head: B, build: B, at: now } }).afterBoot({ alive: [], resumed: [], cold: [], failed: [] });
      expect((await store.get(t.id))!).toMatchObject({ status: "withdrawn", lastError: DEPLOY_CLOSED.deployed });
    });
  });

  it("a torn or foreign state file reads as no run", async () => {
    mkdirSync(join(dir, "deploy"), { recursive: true });
    writeFileSync(stateFile, "{ torn");
    expect(await svc.readState()).toBeNull();
    writeFileSync(stateFile, JSON.stringify({ id: "d9", phase: "running", step: "format-disk" }));
    expect(await svc.readState()).toBeNull();
    expect((await svc.start("tab")).code).toBe(200);
  });
});

describe("the Telegram card", () => {
  const CFG = { chatId: -100, threadId: 7, userId: 42 };
  const tap = (data: string, from = CFG.userId, chat = CFG.chatId, thread = CFG.threadId): TgUpdate => ({
    update_id: 1,
    callback_query: { id: "cb", from: { id: from }, data, message: { message_id: 500, date: 0, chat: { id: chat, type: "supergroup" }, message_thread_id: thread } },
  } as TgUpdate);

  function telegram(deploy: Pick<DeployService, "startFromCard">) {
    const replies: string[] = [];
    const tg = {
      sendMessage: vi.fn(async (_chat: number, text: string) => { replies.push(text); return { message_id: 900, date: 0, chat: { id: CFG.chatId, type: "supergroup" } }; }),
      deleteMessage: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}), editMessageText: vi.fn(async () => {}),
    };
    const chief = new ChiefTelegram({
      tg: tg as never, cfg: CFG as never, consoleUrl: "https://console.example", misconfigured: null,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: async () => false },
      cards: { lookup: () => undefined, recordRule: async () => {}, recordProposal: async () => {}, addItem: async () => {} } as never,
      actions, queueStore: store, deploy, log: () => {},
    });
    return { chief, replies };
  }

  it("shows the PRs and a Deploy button; the callback is the ticket's own", async () => {
    await svc.check();
    const t = await ticket();
    const text = queueCardText(t, { now: t.createdAt });
    expect(text).toBe(`⟳ deploy · choibot · now\nConsole: 1 commit merged, not live\n${deployBody(t.deploy!)}`);
    expect(text).not.toContain("agent-");
    expect(queueCardKeyboard(t, "https://console.example")).toEqual({
      inline_keyboard: [[{ text: "Deploy", callback_data: `q:y:${t.id}` }], [{ text: "Snooze 1h", callback_data: `q:s:${t.id}` }]],
    });
    expect(parseItemCallback(`q:y:${t.id}`)).toEqual({ action: "y", itemId: t.id });
  });

  it("a run that goes has no button; a failed one shows the error tail and Deploy again", async () => {
    await svc.check();
    await svc.start("telegram");
    runnerWrites({ step: "build" });
    await svc.mirror();
    let t = await ticket();
    expect(queueCardKeyboard(t, "")).toEqual({ inline_keyboard: [] });
    expect(queueCardText(t, { now: t.createdAt })).toContain("Deploy runs: build (5 of 7)");
    runnerWrites({ phase: "failed", step: "build", error: "the build failed", tail: "Type error: x" });
    alive = false;
    await svc.mirror();
    t = await ticket();
    expect(queueCardText(t, { now: t.createdAt })).toContain("Deploy failed at build: the build failed. Nothing restarted.\n…Type error: x");
    expect(queueCardKeyboard(t, "").inline_keyboard[0]).toEqual([{ text: "Deploy", callback_data: `q:y:${t.id}` }]);
  });

  it("the closed card shows the result", () => {
    const run: DeployRun = { id: "d1", via: "telegram", startedAt: 1, endedAt: 2, phase: "done", step: "restart", from: A, to: B, alive: 12, failed: 0 };
    const item = { id: "q12345678", kind: "deploy", status: "withdrawn", lastError: DEPLOY_CLOSED.deployed, agentId: CONSOLE_AGENT_ID, repo: "choibot",
      title: deployTitle(1), body: "#5 x", createdAt: 0, deploy: { live: A, target: B, count: 1, prs: [], more: 0, run } } as unknown as QueueItem;
    expect(answeredCardText(item, { now: 0 })).toBe("⟳ deploy · choibot · now\nConsole: 1 commit merged, not live\n#5 x\nDeployed · live bbbbbbb · 12 agents alive · rollback aaaaaaa\n✓ deployed");
  });

  it("only the user's own Telegram account, in the Master topic, starts it", async () => {
    await svc.check();
    const t = await ticket();
    const startFromCard = vi.fn((id: string) => svc.startFromCard(id));
    const { chief } = telegram({ startFromCard });
    // Another account, another chat, another topic: not the user.
    expect(chief.route(tap(`q:y:${t.id}`, 999))).toBe("pass");
    expect(chief.route(tap(`q:y:${t.id}`, CFG.userId, -200))).toBe("pass");
    expect(chief.route(tap(`q:y:${t.id}`, CFG.userId, CFG.chatId, 8))).toBe("pass");
    await chief.idle();
    expect(startFromCard).not.toHaveBeenCalled();
    expect(launched).toEqual([]);
    expect(chief.route(tap(`q:y:${t.id}`))).toBe("handled");
    await chief.idle();
    expect(launched).toHaveLength(1);
    expect((await ticket()).deploy?.run).toMatchObject({ via: "telegram", phase: "running" });
  });

  it("a tap on a card that is not the open deploy ticket starts nothing and says why", async () => {
    await svc.check();
    const other = await store.add({ kind: "question", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop", title: "Deploy?", body: "", blocking: true });
    const { chief, replies } = telegram(svc);
    chief.route(tap(`q:y:${other.id}`));
    chief.route(tap("q:y:q00000000"));
    await chief.idle();
    expect(launched).toEqual([]);
    expect(replies).toEqual(["Not accepted: this is not the open deploy ticket", "Not accepted: this is not the open deploy ticket"]);
  });

  it("without the deploy service a tap does nothing", async () => {
    await svc.check();
    const t = await ticket();
    const chief = new ChiefTelegram({
      tg: { sendMessage: vi.fn(), deleteMessage: vi.fn(), answerCallbackQuery: vi.fn(async () => {}), editMessageText: vi.fn() } as never, cfg: CFG as never,
      consoleUrl: "", misconfigured: null, pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: async () => false },
      cards: { lookup: () => undefined } as never, actions, queueStore: store, log: () => {},
    });
    chief.route(tap(`q:y:${t.id}`));
    await chief.idle();
    expect(launched).toEqual([]);
  });
});

describe("mergedPrs", () => {
  it("reads merge commits and squash commits, once per PR, and skips plain commits", () => {
    expect(mergedPrs([
      { subject: "Merge pull request #7 from o/b", body: "\nfeat: third   thing\n\nmore" },
      { subject: "fix(queue): one more thing (#6)", body: "" },
      { subject: "chore: by hand", body: "" },
      { subject: "Merge pull request #7 from o/b", body: "again" },
      { subject: "Merge pull request #8 from o/c", body: "" },
    ])).toEqual([{ number: 7, title: "feat: third thing" }, { number: 6, title: "fix(queue): one more thing" }, { number: 8, title: "PR #8" }]);
  });
});
