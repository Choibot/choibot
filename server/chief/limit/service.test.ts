// server/chief/limit/service.test.ts — the console's usage-limit ticket: one ticket for all the
// agents that a usage limit blocks, its life (a notice, the silent edit, the notice again after
// LIMIT_RENOTIFY_MS, the close, a flap, the user's withdraw), the presses (each checked again at
// press time), who can press (the user only) and the Telegram card. The real gate, queue store,
// queue routes and QueueActions in a temp dir; the agents' side is a fake (agents/accounts-api.test.ts
// runs the real Continue, the real read of the stop mark and the real wait of a move).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginUse } from "../../agents/loginuse.js";
import type { StopWhy } from "../../agents/stopwhy.js";
import type { AgentRecord } from "../../agents/store.js";
import type { ConsoleEvent } from "../../events.js";
import type { TgUpdate } from "../../issues/telegram.js";
import { EventQueue, queueDigestLine, requeueDigest } from "../../master/events.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, PairingCodes, USER_HEADER } from "../auth.js";
import { DecisionLog, RuleStore } from "../brain/store.js";
import { CONSOLE_AGENT_ID } from "../deploy/ticket.js";
import { CHIEF_ERR, makeGate } from "../gate.js";
import { QueueActions } from "../queue/actions.js";
import { addItem, type AddDeps } from "../queue/add.js";
import { registerQueueApi } from "../queue/api.js";
import { AuditLog, AutoAnswer } from "../queue/auto.js";
import { answeredCardText, parseItemCallback, queueCardKeyboard, queueCardText } from "../queue/cards.js";
import { formatAnswerLine } from "../queue/lines.js";
import { parseAddInput, parseRecommend, validateUserAnswer } from "../queue/schema.js";
import { QueueStore } from "../queue/store.js";
import type { QueueItem } from "../queue/types.js";
import { ChiefTelegram } from "../telegram.js";
import { registerLimitApi } from "./api.js";
import { LimitTicket, tagOf, type GoOnResult, type LimitAgents, type LimitLogin } from "./service.js";
import { COORDINATOR_ID } from "../../coordinator/paths.js";
import { LIMIT_CLOSED, LIMIT_RENOTIFY_MS, LIMIT_REOPEN_MS, limitTitle, rowCanContinue, rowCanMove, rowStateText, type LimitRow } from "./ticket.js";

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.parse("2026-11-27T12:00:00Z");
const LINE = "You've hit your limit · resets 2pm (UTC)";

const full = (until: number | null): LoginUse => ({ session: 100, week: 40, atLimit: true, until, models: [] });
const roomy = (session: number): LoginUse => ({ session, week: 10, atLimit: false, until: null, models: [] });
const login = (id: string, name: string, use: LoginUse | null, o: Partial<LimitLogin> = {}): LimitLogin =>
  ({ id, name, loggedIn: true, signedOut: false, use, ...o });

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: `s-${id}`, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
type H_ = Record<string, string>;
const agentHdr = (id: string): H_ => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });

let dir: string;
let now: number;
let store: QueueStore;
let recs: Map<string, AgentRecord>;
let logins: LimitLogin[] | null;
// The session tail of an agent, read again (absent: the same as its record; "unread": the file
// could not be read).
let tails: Map<string, StopWhy | null | "unread">;
let moved: [string, string][];
let moveOutcome: Map<string, "resumed" | "waits" | Error>;
// Runs after each move (an agent can change while "all" goes through the rows).
let afterMove: ((id: string) => void) | null;
let waiting: Set<string>;
let removedFns: Set<(id: string) => void>;
let goOns: string[];
let goOnResult: Map<string, GoOnResult>;
let fresh: string[];
let svc: LimitTicket;
let app: FastifyInstance;
let userHdr: H_;
let rules: RuleStore;
let actions: QueueActions;

const put = (r: AgentRecord): void => { recs.set(r.id, r); };
// A block of the limit now (a new stop is a new block).
const block = (id: string, o: Partial<AgentRecord> = {}): void => put(rec(id, { stop: { why: "limit", text: LINE, at: now }, ...o }));
// The agent works again: its stop mark goes (the hook route does this).
const works = (id: string): void => { const r = recs.get(id)!; const { stop: _s, ...rest } = r; put({ ...rest, status: "running" }); };

const agents: LimitAgents = {
  list: async () => [...recs.values()],
  load: async (id) => recs.get(id) ?? null,
  stopRead: async (r) => {
    const t = tails.get(r.id);
    if (t === "unread") return { ok: false };
    if (t !== undefined) return { ok: true, stop: t };
    return { ok: true, stop: r.stop ? { why: r.stop.why, text: r.stop.text } : null };
  },
  logins: async () => logins,
  move: async (r, to) => {
    moved.push([r.id, to]);
    const o = moveOutcome.get(r.id) ?? "resumed";
    if (o instanceof Error) throw o;
    if (o === "waits") { waiting.add(r.id); return o; }
    const { stop: _s, waitsLogin: _w, ...rest } = r;
    put({ ...rest, ...(to === "default" ? {} : { account: to }), status: "running" });
    afterMove?.(r.id);
    return o;
  },
  waitsToMove: (id) => waiting.has(id),
  goOn: async (id) => { goOns.push(id); return goOnResult.get(id) ?? "sent"; },
  onRemoved: (fn) => { removedFns.add(fn); return () => { removedFns.delete(fn); }; },
};

async function build(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "chief-limit-"));
  now = T0;
  fresh = [];
  const seen = new Set<string>();
  // A new item is a notice (a new Telegram card, the Queue's count); a write of a known one is
  // the silent edit.
  store = new QueueStore(join(dir, "queue"), {
    now: () => now, log: () => {},
    onChange: (i) => { if (i.kind === "limit" && !seen.has(i.id)) { seen.add(i.id); fresh.push(i.id); } },
  });
  recs = new Map([
    [FLEET_MASTER_ID, rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" })],
    ["lead-app", rec("lead-app", { kind: "lead" as AgentRecord["kind"], area: "app" })],
  ]);
  logins = [login("default", "Main login", full(T0 + 2 * H)), login("ops", "ops", roomy(70)), login("spare", "spare", roomy(20))];
  tails = new Map(); moved = []; moveOutcome = new Map(); afterMove = null; waiting = new Set(); removedFns = new Set(); goOns = []; goOnResult = new Map();
  svc = new LimitTicket({ store, agents, now: () => now, log: () => {} });
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  rules = new RuleStore(join(dir, "brain", "rules.jsonl"), { now: () => now });
  const decisions = new DecisionLog(join(dir, "brain", "decisions.jsonl"), { now: () => now });
  const gateAgents = { load: async (id: string) => recs.get(id) ?? null };
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents: gateAgents } });
  const audit = new AuditLog(join(dir, "audit", "auto.jsonl"));
  actions = new QueueActions({
    store, rules, decisions, agents: gateAgents, deliverer: { kick: () => {} }, inbox: { cancel: () => "absent" },
    audit, undoMs: 600_000, now: () => now, log: () => {}, mergeState: async () => ({ state: "unknown" as const, why: "no gh in tests" }),
  });
  const autoAnswer = new AutoAnswer({
    store, rules, agents: gateAgents, audit, deliverer: { kick: () => {} }, mode: () => "hardened", threshold: 0.85, undoMs: 600_000, now: () => now, log: () => {},
  });
  const addDeps: AddDeps = {
    store, agents: gateAgents, workspaceDir: "/ws", agentRoots: [tmpdir()], listRepos: async () => [],
    prStatus: async () => { throw new Error("no gh in tests"); }, isAncestor: async () => false,
  };
  app = Fastify();
  registerQueueApi(app, {
    gate, undoMs: 600_000, store, actions, autoAnswer,
    add: (agentId, input, createdBy) => addItem(addDeps, agentId, input, createdBy),
    events: { addQueue: async () => {} }, agents: gateAgents, weekMetrics: async () => ({ decisions: 0, corrections: 0 }),
    hardened: () => false, prWatch: { refreshSoon: () => {} }, previewEnabled: true, now: () => now, log: () => {},
  });
  registerLimitApi(app, { gate, limit: svc, log: () => {} });
}

beforeEach(build);
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const limits = async (): Promise<QueueItem[]> => (await store.list()).filter((i) => i.kind === "limit").sort((a, b) => a.createdAt - b.createdAt);
const open = async (): Promise<QueueItem[]> => (await limits()).filter((i) => i.status === "open");
const ticket = async (): Promise<QueueItem> => (await limits()).at(-1)!;
const rowsOf = async (): Promise<LimitRow[]> => (await ticket()).limit?.rows ?? [];
const row = async (id: string): Promise<LimitRow> => (await rowsOf()).find((r) => r.agentId === id)!;
const press = (itemId: string, body: Record<string, unknown>, headers: H_ = userHdr) =>
  app.inject({ method: "POST", url: `/api/queue/${itemId}/limit`, headers, payload: body });

describe("the ticket: one for all the agents that a limit blocks", () => {
  it("lists each blocked agent once, as the console names it, with its login and when it has room again", async () => {
    block("w1");
    now += MIN;
    block("lead-app", { kind: "lead" as AgentRecord["kind"], area: "app" });
    await svc.sync();
    const t = await ticket();
    expect(t).toMatchObject({
      kind: "limit", status: "open", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
      repo: "logins", area: "logins", blocking: true, body: "", title: "Usage limit: 2 agents blocked",
      limit: { to: { id: "spare", name: "spare" } },
    });
    expect(t.limit!.rows).toEqual([
      { agentId: "w1", key: `w1@${T0}`, tag: tagOf(`w1@${T0}`), name: "w1", login: "default", loginName: "Main login", until: T0 + 2 * H, room: false, state: "blocked" },
      { agentId: "lead-app", key: `lead-app@${T0 + MIN}`, tag: tagOf(`lead-app@${T0 + MIN}`), name: "Lead · app", login: "default", loginName: "Main login", until: T0 + 2 * H, room: false, state: "blocked" },
    ]);
    expect(rowStateText(t.limit!.rows[0], () => "14:00")).toBe("Back at 14:00");
    expect(limitTitle(1)).toBe("Usage limit: 1 agent blocked");
  });

  it("no row for a stop of another kind, a closed agent, an agent of another runtime, or an agent that works", async () => {
    put(rec("w2", { stop: { why: "model", text: "no access to the model", at: now } }));
    put(rec("w3", { stop: { why: "login", text: "OAuth token revoked", at: now } }));
    block("w4", { closedAt: now });
    block("w5", { runtime: "codex" as AgentRecord["runtime"] });
    put(rec("w6", { status: "running" }));
    // It works, though its record still has the mark: no row (and so no Continue).
    block("w7", { status: "running" });
    await svc.sync();
    expect(await limits()).toEqual([]);
  });

  it("the stop mark is read again from the session: Claude's own continue after the reset clears the row; a failed read keeps it", async () => {
    block("w1");
    tails.set("w1", null);
    await svc.sync();
    expect(await limits()).toEqual([]);
    tails.set("w1", { why: "model", text: "x" });
    await svc.sync();
    expect(await limits()).toEqual([]);
    // The file cannot be read now: the row stays, and the next read that works decides.
    tails.set("w1", "unread");
    await svc.sync();
    expect((await rowsOf()).map((r) => r.agentId)).toEqual(["w1"]);
    await svc.sync();
    expect(await open()).toHaveLength(1);
    tails.delete("w1");
    await svc.sync();
    expect(await open()).toHaveLength(1);
    tails.set("w1", null);
    await svc.sync();
    expect(await open()).toHaveLength(0);
  });

  it("the fleet master and the Coordinator are rows like the others: their names, Move, Continue, and a busy one moves when quiet", async () => {
    put(rec(COORDINATOR_ID, { kind: "coordinator" as AgentRecord["kind"], repo: "" }));
    block(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" });
    now += MIN;
    block(COORDINATOR_ID, { kind: "coordinator" as AgentRecord["kind"], repo: "", account: "ops" });
    await svc.sync();
    const t = await ticket();
    const [fm, co] = t.limit!.rows;
    expect(fm).toMatchObject({ agentId: FLEET_MASTER_ID, name: "Fleet master", login: "default", state: "blocked", room: false });
    expect(co).toMatchObject({ agentId: COORDINATOR_ID, name: "Coordinator", login: "ops", loginName: "ops", state: "blocked", room: true });
    expect(rowCanMove(fm, t.limit!.to)).toBe(true);
    expect(rowCanContinue(co)).toBe(true);
    moveOutcome.set(FLEET_MASTER_ID, "waits");
    expect((await press(t.id, { row: fm.tag, act: "move", to: "spare" })).json()).toMatchObject({ text: "It moves to spare when it is quiet." });
    expect((await press(t.id, { row: co.tag, act: "continue" })).json()).toMatchObject({ text: "The agent goes on." });
    expect((await rowsOf()).map((r) => [r.name, r.state])).toEqual([["Fleet master", "moves-when-quiet"], ["Coordinator", "going-on"]]);
    expect(moved).toEqual([[FLEET_MASTER_ID, "spare"]]);
    expect(goOns).toEqual([COORDINATOR_ID]);
  });

  it("a new agent that waits for a login (each login was full) is a row that says so: Move, no Continue", async () => {
    logins = [login("default", "Main login", full(T0 + 2 * H)), login("spare", "spare", full(T0 + 3 * H))];
    put(rec("w1", { createdAt: now, waitsLogin: { until: T0 + 2 * H, prompt: "do the task" } }));
    await svc.sync();
    const r = await row("w1");
    expect(r).toMatchObject({ key: `w1@w${T0}`, state: "waits-login", until: T0 + 2 * H, room: false });
    expect(rowStateText(r, () => "x")).toBe("Waits for a login");
    // No login has room: no Move either, and the ticket has no target.
    expect((await ticket()).limit?.to).toBeUndefined();
    logins[1] = login("spare", "spare", roomy(10));
    await svc.sync();
    const t = await ticket();
    expect(t.limit?.to).toEqual({ id: "spare", name: "spare" });
    expect(rowCanMove(t.limit!.rows[0], t.limit!.to)).toBe(true);
    expect(rowCanContinue(t.limit!.rows[0])).toBe(false);
  });

  it("its own login has room again: the row says so and has Continue", async () => {
    block("w1", { account: "ops" });
    await svc.sync();
    const r = await row("w1");
    expect(r).toMatchObject({ login: "ops", loginName: "ops", room: true, state: "blocked" });
    expect(rowStateText(r, () => "x")).toBe("Login has room");
    expect(rowCanContinue(r)).toBe(true);
    // The target is never the row's own login.
    expect(rowCanMove(r, { id: "ops", name: "ops" })).toBe(false);
  });

  it("closes itself when no agent is blocked, also when an agent is closed or deleted", async () => {
    block("w1"); block("w2");
    await svc.sync();
    put({ ...recs.get("w2")!, closedAt: now });
    await svc.sync();
    expect((await rowsOf()).map((r) => r.agentId)).toEqual(["w1"]);
    expect((await ticket()).title).toBe("Usage limit: 1 agent blocked");
    recs.delete("w1");
    await svc.sync();
    expect(await ticket()).toMatchObject({ status: "withdrawn", lastError: LIMIT_CLOSED.none, closedAt: now });
    await svc.sync();
    expect(await limits()).toHaveLength(1);
  });

  it("a restart (a new service on the same store) keeps the one ticket; a second open limit item closes as a duplicate", async () => {
    block("w1");
    await svc.sync();
    const first = await ticket();
    const again = new LimitTicket({ store, agents, now: () => now, log: () => {} });
    await again.sync();
    expect(await limits()).toHaveLength(1);
    now += 1_000;
    const extra = await store.add({
      kind: "limit", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" }, repo: "logins", area: "logins",
      title: "Usage limit: 9 agents blocked", body: "", blocking: true, limit: { rows: [] },
    });
    await again.sync();
    expect((await open()).map((i) => i.id)).toEqual([extra.id]);
    expect(await store.get(first.id)).toMatchObject({ status: "withdrawn", lastError: LIMIT_CLOSED.duplicate });
    // The kept one is rewritten from the console's own facts.
    expect(await store.get(extra.id)).toMatchObject({ title: "Usage limit: 1 agent blocked", limit: { rows: [{ agentId: "w1" }] } });
  });
});

describe("the notice: once, and again only for a late row", () => {
  it("a row that comes inside LIMIT_RENOTIFY_MS edits the ticket in place, with no notice", async () => {
    block("w1");
    await svc.sync();
    const t = await ticket();
    expect(fresh).toEqual([t.id]);
    now += 10 * MIN;
    block("w2");
    await svc.sync();
    now += LIMIT_RENOTIFY_MS - 10 * MIN - 1;
    block("w3");
    await svc.sync();
    expect(await limits()).toHaveLength(1);
    expect(fresh).toEqual([t.id]);
    expect(await ticket()).toMatchObject({ id: t.id, status: "open", title: "Usage limit: 3 agents blocked" });
    expect((await rowsOf()).map((r) => r.agentId)).toEqual(["w1", "w2", "w3"]);
  });

  it("a row that comes later notifies again: one new ticket with all the rows, in their old order; the old one closes", async () => {
    block("w2");
    now += MIN;
    block("w1");
    await svc.sync();
    const t = await ticket();
    now = t.createdAt + LIMIT_RENOTIFY_MS + 3 * H;
    block("w3");
    await svc.sync();
    const [old, next] = await limits();
    expect(old).toMatchObject({ id: t.id, status: "withdrawn", lastError: LIMIT_CLOSED.renotified });
    expect(next).toMatchObject({ status: "open", title: "Usage limit: 3 agents blocked" });
    expect(next.limit!.rows.map((r) => r.agentId)).toEqual(["w2", "w1", "w3"]);
    // One notice for the late row (never one per row).
    expect(fresh).toEqual([t.id, next.id]);
  });

  it("an old ticket whose rows only change or go makes no notice", async () => {
    block("w1"); block("w2");
    await svc.sync();
    now += 2 * H;
    works("w2");
    await svc.sync();
    logins![2] = login("spare", "spare", roomy(90));
    await svc.sync();
    expect(fresh).toHaveLength(1);
    expect(await open()).toHaveLength(1);
  });

  // A restart is a new service on the same store: both clocks are in the store.
  const restart = (): void => { svc = new LimitTicket({ store, agents, now: () => now, log: () => {} }); };

  it("a flap: a block less than LIMIT_REOPEN_MS after the CLOSE opens the same ticket again with no notice, also when the ticket is old", async () => {
    block("w1");
    await svc.sync();
    const t = await ticket();
    // Open for 40 minutes, then no row: its notice is older than LIMIT_RENOTIFY_MS.
    now += 40 * MIN;
    works("w1");
    await svc.sync();
    expect(await ticket()).toMatchObject({ status: "withdrawn", lastError: LIMIT_CLOSED.none, closedAt: now });
    now += LIMIT_REOPEN_MS - MIN;
    block("w1");
    restart();
    await svc.sync();
    const back = await ticket();
    expect(back).toMatchObject({ id: t.id, status: "open", title: "Usage limit: 1 agent blocked" });
    expect(back.lastError).toBeUndefined();
    expect(back.closedAt).toBeUndefined();
    expect(fresh).toEqual([t.id]);
    // A new agent on it: its notice (the first one) is older than LIMIT_RENOTIFY_MS: a new notice.
    block("w2");
    restart();
    await svc.sync();
    expect(await limits()).toHaveLength(2);
    expect(fresh).toHaveLength(2);
  });

  it("a block LIMIT_REOPEN_MS or more after the close is a new ticket with a notice, also when the ticket is young", async () => {
    block("w1");
    await svc.sync();
    const t = await ticket();
    now += 5 * MIN;
    works("w1");
    await svc.sync();
    now += LIMIT_REOPEN_MS;
    // 15 minutes after its notice, 10 after its close.
    block("w1");
    restart();
    await svc.sync();
    const [old, next] = await limits();
    expect(old).toMatchObject({ id: t.id, status: "withdrawn", lastError: LIMIT_CLOSED.none });
    expect(next).toMatchObject({ status: "open", title: "Usage limit: 1 agent blocked" });
    expect(fresh).toEqual([t.id, next.id]);
  });

  it("the user withdrew it: no new ticket while rows stay, also for a new block and after a restart; once no row is left, a block makes a ticket again", async () => {
    block("w1"); block("w2");
    await svc.sync();
    const t = await ticket();
    expect((await app.inject({ method: "POST", url: `/api/queue/${t.id}/withdraw`, headers: userHdr })).statusCode).toBe(200);
    expect((await store.get(t.id))?.lastError).toBeUndefined();
    // A third agent is cut: still no ticket (w1 and w2 stay blocked).
    now += MIN;
    block("w3");
    await svc.sync();
    expect(await limits()).toHaveLength(1);
    restart();
    now += 2 * H;
    await svc.sync();
    expect(await limits()).toHaveLength(1);
    // One goes; the others stay.
    works("w1");
    await svc.sync();
    expect(await limits()).toHaveLength(1);
    expect((await store.get(t.id))?.limit?.quietAt).toBeUndefined();
    // No row: the hold ends (in the store).
    works("w2"); works("w3");
    await svc.sync();
    expect((await store.get(t.id))?.limit?.quietAt).toBe(now);
    expect(await limits()).toHaveLength(1);
    // The same agent, cut again later: a new ticket with a notice.
    now += MIN;
    block("w1");
    restart();
    await svc.sync();
    expect(await open()).toHaveLength(1);
    expect((await rowsOf()).map((r) => r.agentId)).toEqual(["w1"]);
    expect(fresh).toHaveLength(2);
  });

  it("the user withdraws it while a sync closes it for a late row: the sync adds nothing", async () => {
    block("w1");
    await svc.sync();
    const t = await ticket();
    now += LIMIT_RENOTIFY_MS + MIN;
    block("w2");
    // The withdraw comes between the sync's read and its close.
    let armed = true;
    const racy: typeof store = Object.create(store);
    racy.withItem = async (id, fn) => {
      if (armed) { armed = false; expect((await app.inject({ method: "POST", url: `/api/queue/${t.id}/withdraw`, headers: userHdr })).statusCode).toBe(200); }
      return store.withItem(id, fn);
    };
    svc = new LimitTicket({ store: racy, agents, now: () => now, log: () => {} });
    await svc.sync();
    expect(armed).toBe(false);
    expect(await limits()).toHaveLength(1);
    expect(await store.get(t.id)).toMatchObject({ status: "withdrawn" });
    expect((await store.get(t.id))?.lastError).toBeUndefined();
    expect(fresh).toEqual([t.id]);
  });

  it("start(): a sync at once, on an agent's event, on a delete and each minute, with no other call; its stop ends all", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let fn: ((e: ConsoleEvent) => void) | null = null;
      const hub = { subscribe: (f: (e: ConsoleEvent) => void) => { fn = f; return () => { fn = null; }; } };
      const ids = async () => (await open()).flatMap((i) => i.limit!.rows.map((r) => r.agentId));
      block("w1");
      const stop = svc.start(hub);
      await vi.waitFor(async () => expect(await ids()).toEqual(["w1"]));
      // An event of an agent.
      block("w2");
      fn!({ type: "agent-stop", agentId: "w2", why: "limit" });
      await vi.waitFor(async () => expect(await ids()).toEqual(["w1", "w2"]));
      // No event: the minute finds it.
      block("w3");
      vi.advanceTimersByTime(60_000);
      await vi.waitFor(async () => expect(await ids()).toEqual(["w1", "w2", "w3"]));
      // A delete (no hub event exists for it).
      recs.delete("w2");
      expect(removedFns.size).toBe(1);
      for (const f of removedFns) f("w2");
      await vi.waitFor(async () => expect(await ids()).toEqual(["w1", "w3"]));
      stop();
      expect(fn).toBeNull();
      expect(removedFns.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a press: the server checks it again at press time", () => {
  beforeEach(async () => {
    block("w1");
    now += MIN;
    block("w2");
    await svc.sync();
  });

  it("Move to <login>: the agent moves there, and its row goes", async () => {
    const t = await ticket();
    const r = await press(t.id, { row: (await row("w1")).tag, act: "move", to: "spare" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ text: "Moved to spare. The agent goes on.", item: { id: t.id, title: "Usage limit: 1 agent blocked" } });
    expect(moved).toEqual([["w1", "spare"]]);
    expect((await rowsOf()).map((x) => x.agentId)).toEqual(["w2"]);
  });

  it("a busy agent moves when it is quiet: the row says it, and a second press does nothing new", async () => {
    moveOutcome.set("w1", "waits");
    const t = await ticket();
    const tag = (await row("w1")).tag;
    expect((await press(t.id, { row: tag, act: "move", to: "spare" })).json()).toMatchObject({ text: "It moves to spare when it is quiet." });
    const r = await row("w1");
    expect(r.state).toBe("moves-when-quiet");
    expect(rowStateText(r, () => "x")).toBe("Moves when quiet");
    const again = await press(t.id, { row: tag, act: "move", to: "spare" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "It moves when it is quiet already.", reason: "limit" });
    expect(moved).toHaveLength(1);
    // Its relaunch is done (the relaunch's own list; agents/accounts-api.test.ts runs the real
    // one): the row goes.
    waiting.delete("w1");
    works("w1");
    await svc.sync();
    expect((await rowsOf()).map((x) => x.agentId)).toEqual(["w2"]);
  });

  it("Continue types the line once: the row says 'Going on', a second press does nothing new", async () => {
    logins![0] = login("default", "Main login", roomy(5));
    await svc.sync();
    const t = await ticket();
    const tag = (await row("w1")).tag;
    const r = await press(t.id, { row: tag, act: "continue" });
    expect(r.json()).toMatchObject({ text: "The agent goes on." });
    expect((await row("w1")).state).toBe("going-on");
    const again = await press(t.id, { row: tag, act: "continue" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "It goes on already." });
    expect(goOns).toEqual(["w1"]);
  });

  it("Continue does not double Claude's own continue: the agent works, or its mark went: nothing is typed, and the row goes", async () => {
    logins![0] = login("default", "Main login", roomy(5));
    await svc.sync();
    const t = await ticket();
    // goOn read the mark again in the agent's typing lock: Claude went on by itself.
    goOnResult.set("w1", "no-mark");
    const tag1 = (await row("w1")).tag;
    tails.set("w1", null);
    const r = await press(t.id, { row: tag1, act: "continue" });
    // The sync at the press drops the row before the press: nothing fits.
    expect(r.statusCode).toBe(409);
    expect(goOns).toEqual([]);
    expect((await rowsOf()).map((x) => x.agentId)).toEqual(["w2"]);
    // The mark is still in the record and the tail, but the agent works now (goOn sees it): the
    // row says "Going on", with no live button.
    goOnResult.set("w2", "running");
    const r2 = await press(t.id, { row: (await row("w2")).tag, act: "continue" });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ error: "It goes on already." });
    const w2 = await row("w2");
    expect(w2.state).toBe("going-on");
    expect(rowCanContinue(w2)).toBe(false);
    expect(rowCanMove(w2, (await ticket()).limit?.to)).toBe(false);
    expect(goOns).toEqual(["w2"]);
    works("w2");
    await svc.sync();
    expect(await ticket()).toMatchObject({ status: "withdrawn", lastError: LIMIT_CLOSED.none });
  });

  it("a menu of Claude on its screen: nothing is typed, the row says 'Answer its menu first' with no Continue, until the menu goes or for a while", async () => {
    logins![0] = login("default", "Main login", roomy(5));
    await svc.sync();
    goOnResult.set("w1", "dialog");
    const t = await ticket();
    const tag = (await row("w1")).tag;
    const r = await press(t.id, { row: tag, act: "continue" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "A menu of Claude is on its screen: answer it first." });
    const mark = await row("w1");
    expect(mark.state).toBe("answer-menu");
    expect(rowStateText(mark, () => "x")).toBe("Answer its menu first");
    expect(rowCanContinue(mark)).toBe(false);
    // Move stays (it does not type into the menu); the target here is its own login, so another one.
    expect(rowCanMove(mark, { id: "spare", name: "spare" })).toBe(true);
    expect((await press(t.id, { row: tag, act: "continue" })).json()).toMatchObject({ error: "This button does not fit the agent now." });
    expect(goOns).toEqual(["w1"]);
    // The menu went away (its answer): Continue again.
    let fn: ((e: ConsoleEvent) => void) | null = null;
    const stop = svc.start({ subscribe: (f) => { fn = f; return () => { fn = null; }; } });
    fn!({ type: "agent-prompt", agentId: "w1", kind: null, rev: "1" });
    await vi.waitFor(async () => expect((await row("w1")).state).toBe("blocked"));
    expect(rowCanContinue(await row("w1"))).toBe(true);
    stop();
    // A menu that nobody answers: the mark ends after a while.
    goOnResult.set("w1", "dialog");
    await press(t.id, { row: tag, act: "continue" });
    expect((await row("w1")).state).toBe("answer-menu");
    now += 11 * MIN;
    await svc.sync();
    expect((await row("w1")).state).toBe("blocked");
  });

  it("a stale button: the row left, the login filled up or signed out, a made-up row, login or ticket", async () => {
    const t = await ticket();
    const tag1 = (await row("w1")).tag;
    const tag2 = (await row("w2")).tag;
    // The row left (the agent works again).
    works("w1");
    expect((await press(t.id, { row: tag1, act: "move", to: "spare" })).json()).toEqual({ error: "This agent is not blocked now.", reason: "limit" });
    // The login filled up since the card.
    logins![2] = login("spare", "spare", full(T0 + H));
    const filled = await press(t.id, { row: tag2, act: "move", to: "spare" });
    expect(filled.statusCode).toBe(409);
    expect(filled.json()).toMatchObject({ error: "spare has no room now." });
    logins![2] = login("spare", "spare", roomy(20), { signedOut: true });
    expect((await press(t.id, { row: tag2, act: "move", to: "spare" })).json()).toMatchObject({ error: "spare is not logged in now." });
    // A login that does not exist.
    const made = await press(t.id, { row: tag2, act: "move", to: "nobody" });
    expect(made.statusCode).toBe(400);
    expect(made.json()).toMatchObject({ error: "no such login" });
    // A row that never was (an id of an agent as its tag, or a made-up tag).
    expect((await press(t.id, { row: tagOf("w9@1"), act: "move", to: "ops" })).json()).toMatchObject({ error: "This agent is not blocked now." });
    // Its own full login is no target.
    expect((await press(t.id, { row: tag2, act: "move", to: "default" })).json()).toMatchObject({ error: "Main login has no room now." });
    // Continue on a full login.
    expect((await press(t.id, { row: tag2, act: "continue" })).json()).toMatchObject({ error: "This button does not fit the agent now." });
    // A made-up ticket, a ticket of another kind.
    expect((await press("q00000000", { row: tag2, act: "continue" })).statusCode).toBe(404);
    const other = await store.add({ kind: "question", agentId: "w2", createdBy: { agentId: "w2", kind: "worker" }, repo: "app", area: "app", title: "?", body: "", blocking: true });
    expect((await press(other.id, { row: tag2, act: "continue" })).statusCode).toBe(404);
    expect(moved).toEqual([]);
    expect(goOns).toEqual([]);
    // A move that fails says why.
    logins![2] = login("spare", "spare", roomy(20));
    moveOutcome.set("w2", new Error("the agent is not live"));
    const failed = await press(t.id, { row: tag2, act: "move", to: "spare" });
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toMatchObject({ error: "the agent is not live" });
  });

  it("a press on a closed ticket does nothing and says why it closed (also when the press's own sync closed it)", async () => {
    const t = await ticket();
    const tag = (await row("w1")).tag;
    works("w1"); works("w2");
    const r = await press(t.id, { row: tag, act: "move", to: "spare" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "This ticket is closed: no agent on it is blocked now." });
    // A late row: the press's own sync closes the ticket for a new one.
    now += LIMIT_RENOTIFY_MS;
    block("w1");
    await svc.sync();
    const t2 = await ticket();
    now += LIMIT_RENOTIFY_MS + MIN;
    block("w2");
    const late = await press(t2.id, { row: (await row("w1")).tag, act: "move", to: "spare" });
    expect(late.json()).toMatchObject({ error: "This ticket is closed: a newer ticket lists these agents." });
    // A second open item: the press's own sync closes the older one as a duplicate.
    const t3 = await ticket();
    now += 1_000;
    await store.add({
      kind: "limit", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" }, repo: "logins", area: "logins",
      title: "Usage limit: 9 agents blocked", body: "", blocking: true, limit: { rows: [] },
    });
    expect((await press(t3.id, { row: "all", act: "move", to: "spare" })).json()).toMatchObject({ error: "This ticket is closed: another ticket lists these agents." });
    // The user withdrew it.
    const t4 = await ticket();
    expect((await app.inject({ method: "POST", url: `/api/queue/${t4.id}/withdraw`, headers: userHdr })).statusCode).toBe(200);
    expect((await press(t4.id, { row: "all", act: "move", to: "spare" })).json()).toMatchObject({ error: "This ticket is closed: you withdrew it." });
    expect(moved).toEqual([]);
  });

  it("'all' checks each row again right before its act: a row that works now, or that has a new block, is skipped", async () => {
    block("w3");
    await svc.sync();
    const t = await ticket();
    // The move of w1 takes time: meanwhile w2 works again and w3 is cut again (a new block).
    afterMove = (id) => {
      if (id !== "w1") return;
      works("w2");
      now += MIN;
      block("w3");
    };
    const all = await press(t.id, { row: "all", act: "move", to: "spare" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ text: "Moved 1 agent to spare. 2 skipped: they did not fit." });
    expect(moved).toEqual([["w1", "spare"]]);
    // w3's new block is a row of its own (a new key), for the next press.
    expect((await rowsOf()).map((r) => [r.agentId, r.key])).toEqual([["w3", `w3@${now}`]]);
  });

  it("'all' takes each row by its own state, and says how many it took", async () => {
    // w3 moves when quiet already; w4 is on the target login (its own login has room).
    block("w3"); block("w4", { account: "spare" });
    put(rec("w5", { createdAt: now, waitsLogin: { until: null, prompt: "" } }));
    await svc.sync();
    moveOutcome.set("w3", "waits");
    const t = await ticket();
    await press(t.id, { row: (await row("w3")).tag, act: "move", to: "spare" });
    moved = [];
    const all = await press(t.id, { row: "all", act: "move", to: "spare" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ text: "Moved 3 agents to spare. 2 skipped: they did not fit." });
    expect(moved).toEqual([["w1", "spare"], ["w2", "spare"], ["w5", "spare"]]);
    // A second press: nothing fits now.
    const again = await press(t.id, { row: "all", act: "move", to: "spare" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "No agent on the ticket fits this now." });
    expect(moved).toHaveLength(3);
    const go = await press(t.id, { row: "all", act: "continue" });
    expect(go.json()).toMatchObject({ text: "Told 1 agent to go on. 1 skipped: it did not fit." });
    expect(goOns).toEqual(["w4"]);
  });

  it("the use of the logins is not known (strong protection): no target, no Continue, and a press is refused", async () => {
    logins = null;
    await svc.sync();
    const t = await ticket();
    expect(t.limit?.to).toBeUndefined();
    expect(t.limit?.rows.every((r) => !r.room && r.until === null)).toBe(true);
    const tag = (await row("w1")).tag;
    expect((await press(t.id, { row: tag, act: "move", to: "spare" })).statusCode).toBe(400);
    expect((await press(t.id, { row: tag, act: "continue" })).statusCode).toBe(409);
    expect(moved).toEqual([]);
    expect(goOns).toEqual([]);
  });
});

describe("only the user presses; no agent path touches the ticket", () => {
  let t: QueueItem;
  let tag: string;
  beforeEach(async () => {
    block("w1");
    await svc.sync();
    t = await ticket();
    tag = (await row("w1")).tag;
  });
  const refusedAsPair = (r: { statusCode: number; json(): unknown }): void => {
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: CHIEF_ERR.pairRequired, userAuth: "log" });
  };

  it("the route: no token, a loopback request, an agent's token (a worker, a lead, the fleet master), agent headers next to a user token: refused", async () => {
    const body = { row: tag, act: "move", to: "spare" };
    refusedAsPair(await press(t.id, body, {}));
    refusedAsPair(await app.inject({ method: "POST", url: `/api/queue/${t.id}/limit`, remoteAddress: "127.0.0.1", payload: body }));
    for (const who of ["w1", "lead-app", FLEET_MASTER_ID]) refusedAsPair(await press(t.id, body, agentHdr(who)));
    refusedAsPair(await press(t.id, body, { ...userHdr, ...agentHdr(FLEET_MASTER_ID) }));
    refusedAsPair(await press(t.id, body, { [USER_HEADER]: "not-a-token" }));
    expect(moved).toEqual([]);
    expect((await press(t.id, body)).statusCode).toBe(200);
    expect(moved).toEqual([["w1", "spare"]]);
  });

  it("the route takes only a press: a bad body or a bad id is refused", async () => {
    for (const body of [{ row: tag, act: "jump" }, { row: "W1", act: "continue" }, { row: tag, act: "move", to: "Not A Login" },
      { row: tag, act: "continue", agentId: "w1" }, { row: tag }, {}]) {
      expect((await press(t.id, body)).statusCode).toBe(400);
    }
    expect((await press("../etc", { row: tag, act: "continue" })).statusCode).toBe(404);
    expect((await press(t.id, { row: tag, act: "move" })).statusCode).toBe(400);
    expect(moved).toEqual([]);
  });

  it("an agent cannot add the kind (the CLI's `queue add` and the agents' route are one check), nor fake its field on another kind", async () => {
    expect(parseAddInput({ kind: "limit", title: "Usage limit: 1 agent blocked", body: "" }, { previewEnabled: true }).ok).toBe(false);
    for (const who of ["w1", "lead-app", FLEET_MASTER_ID]) {
      const r = await app.inject({ method: "POST", url: "/api/queue", headers: agentHdr(who), payload: { kind: "limit", title: "Usage limit: 1 agent blocked", body: "", limit: { rows: [] } } });
      expect(r.statusCode).toBe(400);
    }
    const r = await app.inject({ method: "POST", url: "/api/queue", headers: agentHdr("w1"), payload: { kind: "question", title: "Blocked?", body: "x", limit: { rows: [] }, agentId: CONSOLE_AGENT_ID } });
    expect(r.statusCode).toBe(200);
    const made = (await store.get((r.json() as { id: string }).id))!;
    expect(made).toMatchObject({ kind: "question", agentId: "w1" });
    expect(made.limit).toBeUndefined();
    expect(await limits()).toHaveLength(1);
  });

  it("no answer of any kind, no recommendation and no agent's withdraw or snooze touches it", async () => {
    const url = (verb: string): string => `/api/queue/${t.id}/${verb}`;
    for (const payload of [{ value: "approve" }, { value: "reply", text: "move them" }, { value: "A" }, { value: "move" }]) {
      expect((await app.inject({ method: "POST", url: url("answer"), headers: userHdr, payload })).statusCode).toBe(400);
    }
    const { rule } = await rules.add({ text: "Always move.", state: "candidate", kind: "decision", scope: { area: "*" }, source: { origin: "user-line" } } as Parameters<RuleStore["add"]>[0]);
    await rules.confirm(rule.id, { via: "telegram" });
    const auto = await app.inject({ method: "POST", url: url("answer"), headers: agentHdr(FLEET_MASTER_ID), payload: { value: "approve", auto: true, ruleIds: [rule.id], confidence: 1 } });
    expect(auto.statusCode).toBe(409);
    for (const who of [FLEET_MASTER_ID, "lead-app"]) {
      const r = await app.inject({ method: "POST", url: url("recommend"), headers: agentHdr(who), payload: { value: "move", why: "rule", ruleIds: [rule.id] } });
      expect([403, 409]).toContain(r.statusCode);
    }
    expect((await app.inject({ method: "POST", url: url("answer"), headers: agentHdr("w1"), payload: { value: "approve" } })).statusCode).toBe(403);
    for (const who of ["w1", "lead-app", FLEET_MASTER_ID]) {
      expect((await app.inject({ method: "POST", url: url("withdraw"), headers: agentHdr(who) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: url("snooze"), headers: agentHdr(who), payload: { minutes: 60 } })).statusCode).toBe(403);
    }
    const after = (await store.get(t.id))!;
    expect(after).toMatchObject({ status: "open" });
    expect(after.answer).toBeUndefined();
    expect(after.recommend).toBeUndefined();
    expect(moved).toEqual([]);
    expect(validateUserAnswer(after, { value: "approve" }).ok).toBe(false);
    expect(parseRecommend(after, { value: "move", why: "x", ruleIds: [rule.id] }).ok).toBe(false);
    expect(() => formatAnswerLine(after, { value: "approve", by: "user", via: "tab", at: 1 })).toThrow("no answer line");
  });

  it("the master gets no digest line for the kind", async () => {
    expect(queueDigestLine({ itemId: t.id, kind: "limit" as never, repo: "logins" })).toBeNull();
    const added: string[] = [];
    requeueDigest(await store.list(), { addQueue: async (id) => { added.push(id); } });
    expect(added).toEqual([]);
    const q = new EventQueue({ hub: { subscribe: () => () => {} }, agents: { load: async () => null }, issues: { list: async () => [] }, acted: { recent: () => false }, log: () => {} });
    expect(q.addQueueLine(t.id, "limit" as never, "logins")).toBe(false);
  });
});

describe("the Telegram card", () => {
  const CFG = { chatId: -100, threadId: 7, userId: 42 };
  const tap = (data: string, from = CFG.userId, chat = CFG.chatId, thread = CFG.threadId): TgUpdate => ({
    update_id: 1,
    callback_query: { id: "cb", from: { id: from }, data, message: { message_id: 500, date: 0, chat: { id: chat, type: "supergroup" }, message_thread_id: thread } },
  } as TgUpdate);

  function telegram(limit: Pick<LimitTicket, "press"> | undefined) {
    const replies: string[] = [];
    const tg = {
      sendMessage: vi.fn(async (_chat: number, text: string) => { replies.push(text); return { message_id: 900, date: 0, chat: { id: CFG.chatId, type: "supergroup" } }; }),
      deleteMessage: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}), editMessageText: vi.fn(async () => {}),
    };
    const chief = new ChiefTelegram({
      tg: tg as never, cfg: CFG as never, consoleUrl: "https://console.example", misconfigured: null,
      pairing: new PairingCodes({ setTimer: () => ({ clear() {} }) }), devices: { revoke: async () => false },
      cards: { lookup: () => undefined, recordRule: async () => {}, recordProposal: async () => {}, addItem: async () => {} } as never,
      actions, queueStore: store, ...(limit ? { limit } : {}), log: () => {},
    });
    return { chief, replies };
  }

  // w1 on the full main login, the lead waits for a login, w3's own login has room.
  async function three(): Promise<QueueItem> {
    now = T0 - 3 * MIN;
    block("w1");
    put(rec("lead-app", { kind: "lead" as AgentRecord["kind"], area: "app", createdAt: T0 - 2 * MIN, waitsLogin: { until: T0 + 2 * H, prompt: "" } }));
    now = T0 - MIN;
    block("w3", { account: "spare", label: "w3" });
    now = T0;
    await svc.sync();
    return ticket();
  }

  it("one numbered line for each agent: its name, its login's name (no e-mail address), its state", async () => {
    const t = await three();
    expect(queueCardText(t, { now: t.createdAt, tz: "UTC" })).toBe([
      "◷ limit · logins · now",
      "Usage limit: 3 agents blocked",
      "1. w1 · Main login · Back at 14:00 UTC",
      "2. Lead · app · Main login · Waits for a login",
      "3. w3 · spare · Login has room",
    ].join("\n"));
    expect(queueCardText(t, { now: t.createdAt })).not.toMatch(/@|agent-/);
    // The time says its zone: no card has the user's own zone.
    expect(queueCardText(t, { now: t.createdAt, tz: "Europe/Paris" })).toContain("1. w1 · Main login · Back at 15:00 CET");
  });

  it("the buttons carry the row's number; Move all when two rows or more can move; each callback is under 64 bytes", async () => {
    const t = await three();
    const [r1, r2, r3] = t.limit!.rows;
    expect(queueCardKeyboard(t, "https://console.example")).toEqual({
      inline_keyboard: [
        [{ text: "1 · Move to spare", callback_data: `q:l:${t.id}:m:${r1.tag}:spare` }, { text: "2 · Move to spare", callback_data: `q:l:${t.id}:m:${r2.tag}:spare` }],
        [{ text: "3 · Continue", callback_data: `q:l:${t.id}:c:${r3.tag}` }],
        [{ text: "Move all to spare", callback_data: `q:l:${t.id}:M:spare` }],
      ],
    });
    // The longest login id that accounts.ts allows.
    const long = "a".repeat(32);
    const data = `q:l:${t.id}:m:${r1.tag}:${long}`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseItemCallback(data)).toEqual({ action: "l", itemId: t.id, limit: { row: r1.tag, act: "move", to: long } });
    expect(parseItemCallback(`q:l:${t.id}:c:${r3.tag}`)).toEqual({ action: "l", itemId: t.id, limit: { row: r3.tag, act: "continue" } });
    expect(parseItemCallback(`q:l:${t.id}:M:spare`)).toEqual({ action: "l", itemId: t.id, limit: { row: "all", act: "move", to: "spare" } });
    expect(parseItemCallback(`q:l:${t.id}:C`)).toEqual({ action: "l", itemId: t.id, limit: { row: "all", act: "continue" } });
    for (const bad of [`q:l:${t.id}:m:${r1.tag}`, `q:l:${t.id}:m:${r1.tag.toUpperCase()}:spare`, `q:l:${t.id}:m:${r1.tag}:Spare`,
      `q:l:${t.id}:c:${r3.tag}:x`, `q:l:${t.id}:M:${"a".repeat(33)}`, `q:l:${t.id}:c:all`, "q:l:q0000000:C"]) {
      expect(parseItemCallback(bad)).toBeNull();
    }
  });

  it("past LIMIT_CARD_ROWS rows: '+N more', and buttons only for the rows on the card; a closed card shows the close only", async () => {
    for (let i = 1; i <= 10; i++) { now = T0 + i; block(`w${String(i).padStart(2, "0")}`); }
    await svc.sync();
    const t = await ticket();
    const text = queueCardText(t, { now: t.createdAt, tz: "UTC" });
    expect(text.split("\n").slice(-2)).toEqual(["8. w08 · Main login · Back at 14:00 UTC", "+2 more — open the Queue"]);
    const kb = queueCardKeyboard(t, "").inline_keyboard.flat();
    expect(kb.filter((b) => b.text.endsWith("· Move to spare")).map((b) => b.text.split(" ")[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(kb.at(-1)).toEqual({ text: "Move all to spare", callback_data: `q:l:${t.id}:M:spare` });
    for (const id of [...recs.keys()].filter((k) => k.startsWith("w"))) works(id);
    await svc.sync();
    const closed = await ticket();
    expect(answeredCardText(closed, { now: closed.createdAt })).toBe(`◷ limit · logins · now\nUsage limit: 10 agents blocked\n${LIMIT_CLOSED.none}`);
  });

  it("only the user's own Telegram account, in the Master topic, presses; 'all' says how many it took; a refusal says why", async () => {
    const t = await three();
    const [r1] = t.limit!.rows;
    const pressFn = vi.fn((id: string, p: Parameters<LimitTicket["press"]>[1]) => svc.press(id, p));
    const { chief, replies } = telegram({ press: pressFn });
    const data = `q:l:${t.id}:m:${r1.tag}:spare`;
    // Another account, another chat, another topic: not the user (telegram.ts routeCallback).
    expect(chief.route(tap(data, 999))).toBe("pass");
    expect(chief.route(tap(data, CFG.userId, -200))).toBe("pass");
    expect(chief.route(tap(data, CFG.userId, CFG.chatId, 8))).toBe("pass");
    await chief.idle();
    expect(pressFn).not.toHaveBeenCalled();
    expect(moved).toEqual([]);
    expect(chief.route(tap(data))).toBe("handled");
    await chief.idle();
    expect(moved).toEqual([["w1", "spare"]]);
    expect(replies).toEqual([]);
    // The card was made before the press: Continue on a row whose login is full now.
    chief.route(tap(`q:l:${t.id}:c:${(await row("lead-app")).tag}`));
    await chief.idle();
    expect(replies).toEqual(["Not accepted: This button does not fit the agent now."]);
    chief.route(tap(`q:l:${t.id}:M:spare`));
    await chief.idle();
    expect(moved).toEqual([["w1", "spare"], ["lead-app", "spare"]]);
    expect(replies.at(-1)).toBe("Moved 1 agent to spare. 1 skipped: it did not fit.");
  });

  it("without the limit service a tap does nothing", async () => {
    const t = await three();
    const { chief, replies } = telegram(undefined);
    chief.route(tap(`q:l:${t.id}:M:spare`));
    await chief.idle();
    expect(moved).toEqual([]);
    expect(replies).toEqual([]);
  });
});
