// server/chief/queue/api.test.ts — the /api/queue routes (spec §7, §5.2, §4.4,
// §3.1): a tiny Fastify app with the real gate, store, actions and addItem in
// a temp dir; the digest queue, the week metrics, hardened and PrWatch are
// fakes.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../auth.js";
import { DecisionLog, RuleStore } from "../brain/store.js";
import { CHIEF_ERR, makeGate, USER_ALONE_ERR } from "../gate.js";
import { QueueActions } from "./actions.js";
import { addItem, type AddDeps } from "./add.js";
import { registerQueueApi, type QueueApiDeps } from "./api.js";
import { prMergeState } from "./prgate.js";
import { RICH_BODY_MAX } from "./rich.js";
import { QueueStore, type NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app-shop", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  a1: rec("a1"), a2: rec("a2"), bare: rec("bare", { repo: "" }),
  // AgentRecord["kind"] gains "lead" in Phase 3; callerOf already maps it to level lead.
  "lead-app": rec("lead-app", { kind: "lead" as AgentRecord["kind"] }),
};
type H = Record<string, string>;
const agentHdr = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const MASTER = agentHdr(FLEET_MASTER_ID), A1 = agentHdr("a1"), A2 = agentHdr("a2");

const NOW = 9_000_000;
const UNDO_MS = 600_000;
const PR_URL = "https://github.com/o/app-shop/pull/12";
const Q = { kind: "question", title: "How?", body: "b" };
const base = { agentId: "a1", createdBy: { agentId: "a1", kind: "worker" as const }, repo: "app-shop", area: "app-shop", body: "b" };
const choice: NewItem = { ...base, kind: "choice", title: "Pick", blocking: true,
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] } };
const question: NewItem = { ...base, kind: "question", title: "How?", blocking: true };

let dir: string;
let app: FastifyInstance;
let store: QueueStore;
let rules: RuleStore;
let userHdr: H;
let addQueue: ReturnType<typeof vi.fn<(itemId: string, kind: string, repo: string, agentId: string) => Promise<void>>>;
let refreshSoon: ReturnType<typeof vi.fn<() => void>>;
let logs: string[];
// What `gh pr view` answers for the merge gate (null: gh fails) and git's ancestor test.
let prState: string | null;
let ancestor: boolean;

type Opts = {
  strong?: boolean;
  misconfigured?: string | null; userAuth?: "telegram" | "log"; hardened?: boolean;
  autoAnswer?: QueueApiDeps["autoAnswer"]; add?: QueueApiDeps["add"]; weekMetrics?: QueueApiDeps["weekMetrics"];
};

async function build(o: Opts = {}) {
  dir = mkdtempSync(join(tmpdir(), "chief-queue-api-"));
  store = new QueueStore(join(dir, "queue"), { now: () => NOW, log: () => {} });
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  rules = new RuleStore(join(dir, "brain", "rules.jsonl"), { now: () => NOW });
  const decisions = new DecisionLog(join(dir, "brain", "decisions.jsonl"), { now: () => NOW });
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  const gate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: o.userAuth ?? "log", ...(o.strong ? { strong: true } : {}), deps: { devices, agents } });
  prState = "OPEN";
  ancestor = false;
  // The real gate (prgate.ts) over a fake gh and git, as index.ts wires it.
  const gateDeps = {
    agents, workspaceDir: "/ws", listRepos: async () => [{ name: "app-shop", slug: "o/app-shop", path: "/ws/app-shop" }],
    prStatus: async () => {
      if (prState === null) throw new Error("gh: connection refused");
      return { prState, mergeable: "MERGEABLE", reviewDecision: "", url: PR_URL, checks: { total: 0, passed: 0, failed: 0, pending: 0, rollup: "none" as const } };
    },
    isAncestor: async () => ancestor,
  };
  const actions = new QueueActions({
    store, rules, decisions, agents, deliverer: { kick: () => {} }, inbox: { cancel: () => "absent" },
    audit: { append: async () => {} }, undoMs: UNDO_MS, now: () => NOW, log: () => {},
    mergeState: (it) => prMergeState(gateDeps, it),
  });
  const addDeps: AddDeps = {
    store, agents, workspaceDir: "/ws", agentRoots: [tmpdir()], listRepos: async () => [],
    prStatus: async () => { throw new Error("no gh in tests"); }, isAncestor: async () => false,
  };
  addQueue = vi.fn(async () => {});
  refreshSoon = vi.fn();
  logs = [];
  app = Fastify();
  registerQueueApi(app, {
    gate, undoMs: UNDO_MS, store, actions,
    add: o.add ?? ((agentId, input, createdBy) => addItem(addDeps, agentId, input, createdBy)),
    events: { addQueue }, agents,
    weekMetrics: o.weekMetrics ?? (async () => ({ decisions: 14, corrections: 3 })),
    hardened: () => o.hardened ?? false,
    prWatch: { refreshSoon }, previewEnabled: true, ...(o.autoAnswer ? { autoAnswer: o.autoAnswer } : {}),
    now: () => NOW, log: (s) => { logs.push(s); },
  });
}
async function rebuild(o: Opts) {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  await build(o);
}
beforeEach(async () => { await build(); });
afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, headers: H = {}, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const get = (url: string, headers: H = {}) => app.inject({ method: "GET", url, headers });
const item = async (id: string) => (await store.get(id))!;
async function patch(id: string, fn: (it: QueueItem) => QueueItem): Promise<void> {
  await store.withItem(id, async () => { await store.write(fn((await store.get(id))!)); });
}
const pairRequired = { error: CHIEF_ERR.pairRequired, userAuth: "log" };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png-body")]);

describe("preview items and GET /api/queue/:id/media/:name", () => {
  let wt: string;
  const PV = agentHdr("pv");
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "chief-queue-wt-"));
    mkdirSync(join(wt, ".choibot", "previews"), { recursive: true });
    writeFileSync(join(wt, ".choibot", "previews", "ui-1.png"), PNG);
    RECORDS.pv = rec("pv", { cwd: wt });
  });
  afterEach(() => { delete RECORDS.pv; rmSync(wt, { recursive: true, force: true }); });
  const addPreview = async (): Promise<string> => {
    const res = await post("/api/queue", PV, { kind: "preview", title: "UI", body: "b", preview: { images: [".choibot/previews/ui-1.png"] } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  };

  it("stores the copied image names and copies the file under the media dir", async () => {
    const id = await addPreview();
    expect((await item(id)).preview).toEqual({ images: ["1.png"] });
    expect(readFileSync(join(dir, "queue", "media", id, "1.png"))).toEqual(PNG);
  });
  it("kind preview with a missing image → 400 with the reason, nothing stored", async () => {
    const res = await post("/api/queue", PV, { kind: "preview", title: "t", body: "b", preview: { images: ["a.png"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '"a.png": not found' });
    expect(await store.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
  });

  it("serves the image to any session with its content type and safe headers", async () => {
    const id = await addPreview();
    const res = await get(`/api/queue/${id}/media/1.png`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
    expect(res.rawPayload).toEqual(PNG);
  });
  it("404 for a traversal name, a name not in the item, an unknown item and a non-preview item", async () => {
    const id = await addPreview();
    for (const name of ["..%2Fx", "2.png", "01x.png", "1.gif", "1.png.bak", ".."]) {
      expect((await get(`/api/queue/${id}/media/${name}`)).statusCode).toBe(404);
    }
    expect((await get("/api/queue/qzzzzzzzz/media/1.png")).statusCode).toBe(404);
    const q = (await post("/api/queue", A1, Q)).json() as { id: string };
    expect((await get(`/api/queue/${q.id}/media/1.png`)).statusCode).toBe(404);
  });
  it("404 when the file is gone, 503 while misconfigured", async () => {
    const id = await addPreview();
    rmSync(join(dir, "queue", "media", id, "1.png"));
    expect((await get(`/api/queue/${id}/media/1.png`)).statusCode).toBe(404);
    await rebuild({ misconfigured: "why" });
    expect((await get(`/api/queue/${id}/media/1.png`)).statusCode).toBe(503);
  });
});

describe("the rich part: POST /api/queue with html and GET /api/queue/:id/page", () => {
  let wt: string;
  const RP = agentHdr("rp");
  const PAGE = `<style>.x{color:var(--ink-0)}</style><h2 class="x">Plan</h2><p><a href="https://example.com/a">the doc</a></p>`;
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "chief-queue-wt-"));
    mkdirSync(join(wt, ".choibot", "tickets"), { recursive: true });
    writeFileSync(join(wt, ".choibot", "tickets", "plan.html"), PAGE);
    RECORDS.rp = rec("rp", { cwd: wt });
  });
  afterEach(() => { delete RECORDS.rp; rmSync(wt, { recursive: true, force: true }); });
  const addRich = async (): Promise<string> => {
    const res = await post("/api/queue", RP, { ...Q, html: { file: ".choibot/tickets/plan.html", height: 240 } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  };

  it("the item says it has a page; the page goes out checked, as JSON, to any session that reads the item", async () => {
    const id = await addRich();
    expect((await item(id)).html).toEqual({ bytes: Buffer.byteLength(PAGE), height: 240 });
    expect((await item(id)).body).toBe("b");
    // `queue show` reads this route: it also says where the queue's copy is. The list does not.
    expect((await get(`/api/queue/${id}`, RP)).json().html).toEqual({ bytes: Buffer.byteLength(PAGE), height: 240, copy: join(dir, "queue", "media", id, "page.html") });
    for (const headers of [{}, userHdr, A2, MASTER]) {
      const res = await get(`/api/queue/${id}/page`, headers);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.json()).toEqual({
        css: ".x{color:var(--ink-0)}\n", height: 240,
        html: `<h2 class="x">Plan</h2><p><span data-link="">the doc</span> <span class="link-addr">https://example.com/a</span></p>`,
      });
    }
  });
  it("a refused page: 400 with the reason, nothing stored, no digest line", async () => {
    writeFileSync(join(wt, "bad.html"), `<p onclick="x()">hi</p>`);
    const res = await post("/api/queue", RP, { ...Q, html: { file: "bad.html" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'html: the event handler "onclick" on <p> is not allowed: no script runs in a ticket page' });
    expect(await store.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
  });
  // One main form per ticket: with a page, the body is a short summary. A longer body is refused
  // before the page is read, and nothing is stored.
  it("a body over the summary limit with a page: 400 with what to do, nothing stored, no digest line", async () => {
    const res = await post("/api/queue", RP, { ...Q, body: "x".repeat(RICH_BODY_MAX + 1), html: { file: ".choibot/tickets/plan.html" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: `body: with a page, the body is a short summary of at most ${RICH_BODY_MAX} characters (this one has ${RICH_BODY_MAX + 1}). `
      + "Write what it is, the one or two facts that decide and what to answer; keep the rest in the page only. Or remove the page and keep the body (at most 1500)." });
    expect(await store.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
    expect((await post("/api/queue", RP, { ...Q, body: "x".repeat(RICH_BODY_MAX), html: { file: ".choibot/tickets/plan.html" } })).statusCode).toBe(200);
  });
  it("a stored copy that someone changed is checked again: 422, and no part of it goes out", async () => {
    const id = await addRich();
    writeFileSync(store.pagePath(id), `<p>x</p><script>parent.postMessage("x","*")</script>`);
    const res = await get(`/api/queue/${id}/page`);
    expect(res.statusCode).toBe(422);
    expect(res.payload).not.toContain("script>");
  });
  it("404 for an item with no page, an unknown item and a copy that is gone; 503 while misconfigured; the media route never serves the copy", async () => {
    const plain = (await post("/api/queue", A1, Q)).json() as { id: string };
    expect((await get(`/api/queue/${plain.id}/page`)).statusCode).toBe(404);
    expect((await get("/api/queue/qzzzzzzzz/page")).statusCode).toBe(404);
    const id = await addRich();
    expect((await get(`/api/queue/${id}/media/page.html`)).statusCode).toBe(404);
    rmSync(store.pagePath(id));
    expect((await get(`/api/queue/${id}/page`)).statusCode).toBe(404);
    await rebuild({ misconfigured: "why" });
    expect((await get(`/api/queue/${id}/page`)).statusCode).toBe(503);
  });
});

describe("POST /api/queue", () => {
  it("an agent adds an item: 200 {id} and one addQueue call", async () => {
    const res = await post("/api/queue", A1, Q);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string };
    expect(Object.keys(body)).toEqual(["id"]);
    expect(body.id).toMatch(/^q[0-9a-z]{8}$/);
    expect(addQueue).toHaveBeenCalledTimes(1);
    expect(addQueue).toHaveBeenCalledWith(body.id, "question", "app-shop", "a1");
    expect(await item(body.id)).toMatchObject({ agentId: "a1", createdBy: { agentId: "a1", kind: "worker" },
      kind: "question", title: "How?", body: "b", status: "open", blocking: true });
  });

  it("the master's item is created by fleet-master", async () => {
    const res = await post("/api/queue", MASTER, Q);
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { id: string }).id;
    expect((await item(id)).createdBy).toEqual({ agentId: FLEET_MASTER_ID, kind: "fleet-master" });
    expect(addQueue).toHaveBeenCalledWith(id, "question", "workspace", FLEET_MASTER_ID);
  });

  it("a lead adds an item: 200 {id}, created by the lead", async () => {
    const res = await post("/api/queue", agentHdr("lead-app"), Q);
    expect(res.statusCode).toBe(200);
    const id = (res.json() as { id: string }).id;
    expect((await item(id)).createdBy).toEqual({ agentId: "lead-app", kind: "lead" });
    expect(addQueue).toHaveBeenCalledWith(id, "question", "app-shop", "lead-app");
  });

  it("a rejected addQueue (a throwing record load) is logged; the add still answers 200", async () => {
    addQueue.mockImplementationOnce(async () => { throw new Error("record load failed"); });
    const res = await post("/api/queue", A1, Q);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(logs.join("\n")).toContain("record load failed"));
  });

  it("a deduplicated pr add answers the same id and adds no second digest line", async () => {
    const pr = { kind: "pr", title: "PR #12", body: "", pr: { url: PR_URL } };
    const a = await post("/api/queue", A1, pr);
    const b = await post("/api/queue", A1, pr);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(addQueue).toHaveBeenCalledTimes(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("refuses a headerless request, a user token and a wrong agent token: 403 agents only", async () => {
    const bad = { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "nope" };
    for (const h of [{}, userHdr, bad]) {
      const res = await post("/api/queue", h, Q);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "agents only" });
    }
    expect(await store.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
  });

  it("an invalid or missing body → 400, nothing stored", async () => {
    const long = await post("/api/queue", A1, { ...Q, title: "x".repeat(81) });
    expect(long.statusCode).toBe(400);
    expect((long.json() as { error: string }).error).toMatch(/^title: /);
    const none = await post("/api/queue", A1);
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: "body must be an object" });
    expect(await store.list()).toEqual([]);
    expect(addQueue).not.toHaveBeenCalled();
  });

  it("a QueueAddError answers its status and message (local pr without a repo → 400)", async () => {
    const res = await post("/api/queue", agentHdr("bare"), { kind: "pr", title: "t", body: "", pr: { branch: "agent/bare" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "no repo for a local pr" });
    expect(addQueue).not.toHaveBeenCalled();
  });

  it("any other add failure → 500 with a fixed message, logged", async () => {
    await rebuild({ add: async () => { throw new Error("disk full /secret/path"); } });
    const res = await post("/api/queue", A1, Q);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
    expect(logs.join("\n")).toContain("disk full");
    expect(addQueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/queue", () => {
  it("has every response key, undoMs and userAuth, and calls refreshSoon", async () => {
    const { id } = await store.add(question);
    const res = await get("/api/queue");
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["counts", "hardened", "items", "metrics", "serverNow", "undoMs", "userAuth"]);
    expect(body).toEqual({
      items: [await item(id)], counts: { open: 1, auto: 0, undelivered: 0 },
      metrics: { week: { decisions: 14, corrections: 3 } },
      serverNow: NOW, undoMs: UNDO_MS, hardened: false, userAuth: "log",
    });
    expect(refreshSoon).toHaveBeenCalledTimes(1);
  });

  it("strong protection: a worker lists only its own items; the user and the master list all", async () => {
    const mine = (await store.add(question)).id;
    const theirs = (await store.add({ ...question, agentId: "a2", createdBy: { agentId: "a2", kind: "worker" as const }, title: "theirs" })).id;
    const keep = { ...process.env };
    Object.assign(process.env, { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" });
    try {
      const ids = async (h: H) => ((await get("/api/queue?status=all", h)).json() as { items: QueueItem[] }).items.map((i) => i.id).sort();
      expect(await ids(A1)).toEqual([mine]);
      expect(await ids(userHdr)).toEqual([mine, theirs].sort());
      const counts = ((await get("/api/queue", A1)).json() as { counts: { open: number } }).counts;
      expect(counts.open).toBe(1);
    } finally {
      for (const k of ["CHIEF_ENABLED", "CHIEF_USER_AUTH", "CHIEF_CONSOLE_URL", "CHIEF_AGENT_UID"]) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
    }
    // Basic mode: as today, every item.
    expect(((await get("/api/queue?status=all", A1)).json() as { items: QueueItem[] }).items.length).toBe(2);
  });

  it("hardened and userAuth come from the deps and the gate", async () => {
    await rebuild({ userAuth: "telegram", hardened: true });
    const body = (await get("/api/queue", A1)).json() as Record<string, unknown>;
    expect(body).toMatchObject({ hardened: true, userAuth: "telegram" });
  });

  it("status=open (the default) lists open and snoozed items, status=all every item; area filters", async () => {
    const open = (await store.add(question)).id;
    const snoozed = (await store.add({ ...question, title: "later" })).id;
    await patch(snoozed, (i) => ({ ...i, status: "snoozed", snoozedUntil: NOW + 60_000 }));
    const gone = (await store.add({ ...question, title: "gone" })).id;
    await patch(gone, (i) => ({ ...i, status: "withdrawn", closedAt: NOW }));
    const other = (await store.add({ ...question, repo: "api", area: "api" })).id;
    // Every item has the same createdAt here, so compare as sets.
    const ids = async (q: string) => ((await get(`/api/queue${q}`)).json() as { items: QueueItem[] }).items.map((i) => i.id).sort();
    const set = (...xs: string[]) => xs.sort();
    expect(await ids("")).toEqual(set(open, snoozed, other));
    expect(await ids("?status=open")).toEqual(set(open, snoozed, other));
    expect(await ids("?status=all")).toEqual(set(open, snoozed, gone, other));
    expect(await ids("?status=all&area=app-shop")).toEqual(set(open, snoozed, gone));
    expect(await ids("?status=open&area=api")).toEqual([other]);
    expect(await ids("?status=all&area=")).toEqual(set(open, snoozed, gone, other));
  });

  it("an invalid status, an area over 100 chars or a repeated param → 400", async () => {
    const area = "a".repeat(101);
    for (const q of ["status=closed", `area=${area}`, "status=all&status=open", "area=app-shop&area=api"]) {
      const res = await get(`/api/queue?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json()).toEqual({ error: "invalid query" });
    }
    expect((await get(`/api/queue?area=${"a".repeat(100)}`)).statusCode).toBe(200);
    expect(refreshSoon).toHaveBeenCalledTimes(1);
  });

  it("a failed week metrics read still lists the items, with zeros, and is logged", async () => {
    await rebuild({ weekMetrics: async () => { throw new Error("decisions.jsonl EACCES"); } });
    const { id } = await store.add(question);
    const res = await get("/api/queue");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: QueueItem[]; metrics: unknown };
    expect(body.items.map((i) => i.id)).toEqual([id]);
    expect(body.metrics).toEqual({ week: { decisions: 0, corrections: 0 } });
    expect(logs.join("\n")).toContain("EACCES");
  });

  it("counts: open (snoozed only past snoozedUntil), auto in the last 10 min, undelivered slots on items not withdrawn agent-gone", async () => {
    const add = async (title: string, fn?: (i: QueueItem) => QueueItem) => {
      const { id } = await store.add({ ...choice, title });
      if (fn) await patch(id, fn);
      return id;
    };
    const ans = (at: number, by: "user" | "master") => ({ value: "A", by, via: "tab" as const, at });
    const slot = (state: "failed" | "unknown" | "delivered") => ({ msgId: "x-1", state, attempts: 1 });
    await add("open");
    await add("snoozed, due", (i) => ({ ...i, status: "snoozed", snoozedUntil: NOW - 1 }));
    await add("snoozed, later", (i) => ({ ...i, status: "snoozed", snoozedUntil: NOW + 1 }));
    await add("auto, recent", (i) => ({ ...i, status: "auto", answer: ans(NOW - 60_000, "master"), answerSeq: 1, delivery: slot("delivered") }));
    await add("auto, old", (i) => ({ ...i, status: "auto", answer: ans(NOW - 11 * 60_000, "master"), answerSeq: 1, delivery: slot("delivered") }));
    await add("failed answer", (i) => ({ ...i, status: "answered", answer: ans(NOW, "user"), answerSeq: 1, delivery: slot("failed") }));
    await add("unknown withdrawal", (i) => ({ ...i, withdrawal: slot("unknown") }));
    await add("withdrawn, failed", (i) => ({ ...i, status: "withdrawn", closedAt: NOW, withdrawal: slot("failed") }));
    await add("agent gone, failed", (i) => ({ ...i, status: "withdrawn", lastError: "agent-gone", closedAt: NOW, withdrawal: slot("failed") }));
    const body = (await get("/api/queue?status=all")).json() as { counts: unknown; items: unknown[] };
    expect(body.items).toHaveLength(9);
    expect(body.counts).toEqual({ open: 3, auto: 1, undelivered: 3 });
  });
});

describe("GET /api/queue/:id", () => {
  it("returns the item to any session; unknown and malformed ids → 404", async () => {
    const { id } = await store.add(question);
    for (const h of [{}, A2, userHdr]) {
      const res = await get(`/api/queue/${id}`, h);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(await item(id));
    }
    for (const bad of ["qzzzzzzzz", "nope", "..%2Fx"]) {
      const res = await get(`/api/queue/${bad}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not found" });
    }
  });
});

describe("POST /api/queue/:id/answer — agent headers never give by: \"user\"", () => {
  let id: string;
  beforeEach(async () => { id = (await store.add(choice)).id; });
  const unchanged = async () => {
    const cur = await item(id);
    expect(cur.status).toBe("open");
    expect(cur.answer).toBeUndefined();
    expect(cur.answerSeq).toBe(0);
  };

  it("a worker → 403", async () => {
    const res = await post(`/api/queue/${id}/answer`, A1, { value: "A" });
    expect(res.statusCode).toBe(403);
    await unchanged();
  });

  it("a worker with a valid user token added as well → 403", async () => {
    for (const h of [{ ...A1, ...userHdr }, { ...MASTER, ...userHdr }, { [AGENT_TOKEN_HEADER]: "x", ...userHdr },
      { [AGENT_HEADER]: "a1", ...userHdr }, { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "nope", ...userHdr }]) {
      const res = await post(`/api/queue/${id}/answer`, h, { value: "A" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(pairRequired);
    }
    await unchanged();
  });

  it("headerless → 403 pair-required with the mode", async () => {
    const res = await post(`/api/queue/${id}/answer`, {}, { value: "A" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(pairRequired);
    await unchanged();
  });

  it("USER → 200 with answer.by \"user\" and via \"tab\"", async () => {
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "B" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as QueueItem;
    expect(body.answer).toEqual({ value: "B", by: "user", via: "tab", at: NOW });
    expect(body.status).toBe("answered");
    expect(await item(id)).toEqual(body);
  });

  it("USER {value: \"A\", auto: true} → 400, nothing changes", async () => {
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "A", auto: true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '"auto" is a master-only verb' });
    await unchanged();
  });

  it("the master's auto answer → 400 while no AutoAnswer is wired; without auto → 403", async () => {
    const auto = await post(`/api/queue/${id}/answer`, MASTER, { value: "A", auto: true, ruleIds: ["r_ab12c"], confidence: 0.9 });
    expect(auto.statusCode).toBe(400);
    expect(auto.json()).toEqual({ error: "auto answers arrive in Phase 2b" });
    const plain = await post(`/api/queue/${id}/answer`, MASTER, { value: "A" });
    expect(plain.statusCode).toBe(403);
    await unchanged();
  });

  it("the master's auto answer reaches AutoAnswer.apply with the caller; the item is the response", async () => {
    const apply = vi.fn(async (iid: string) => ({ code: 200 as const, item: await item(iid) }));
    await rebuild({ autoAnswer: { apply } });
    const nid = (await store.add(choice)).id;
    const payload = { value: "A", auto: true, ruleIds: ["r_ab12c"], confidence: 0.9 };
    const res = await post(`/api/queue/${nid}/answer`, MASTER, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(await item(nid));
    expect(apply).toHaveBeenCalledWith(nid, payload, expect.objectContaining({ level: "master" }));
  });

  it("strong protection: the master's auto answer is refused with the reason, before AutoAnswer; the user still answers", async () => {
    const apply = vi.fn(async (iid: string) => ({ code: 200 as const, item: await item(iid) }));
    await rebuild({ autoAnswer: { apply }, strong: true });
    const nid = (await store.add(choice)).id;
    const res = await post(`/api/queue/${nid}/answer`, MASTER, { value: "A", auto: true, ruleIds: ["r_ab12c"], confidence: 0.9 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: USER_ALONE_ERR.auto });
    expect(apply).not.toHaveBeenCalled();
    expect((await item(nid)).status).toBe("open");
    const mine = await post(`/api/queue/${nid}/answer`, userHdr, { value: "A" });
    expect(mine.statusCode).toBe(200);
  });

  it("a downgraded reply keeps the item shape plus the reason; a refusal passes its code and body", async () => {
    let next: unknown;
    const apply = vi.fn(async (iid: string) => next as never);
    await rebuild({ autoAnswer: { apply } });
    const nid = (await store.add(choice)).id;
    next = { code: 200, item: await item(nid), downgraded: "rule confidence below 0.9" };
    const res = await post(`/api/queue/${nid}/answer`, MASTER, { value: "A", auto: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...(await item(nid)), downgraded: "rule confidence below 0.9" });
    next = { code: 409, body: { error: "item is not open" } };
    const res2 = await post(`/api/queue/${nid}/answer`, MASTER, { value: "A", auto: true });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toEqual({ error: "item is not open" });
  });

  it("a USER auto body is still 400 and never reaches apply; an agent gets 403 pair-required", async () => {
    const apply = vi.fn();
    await rebuild({ autoAnswer: { apply } });
    const nid = (await store.add(choice)).id;
    expect((await post(`/api/queue/${nid}/answer`, userHdr, { value: "A", auto: true })).statusCode).toBe(400);
    expect((await post(`/api/queue/${nid}/answer`, A1, { value: "A", auto: true })).json()).toEqual(pairRequired);
    expect(apply).not.toHaveBeenCalled();
  });

  it("an invalid value → 400; a second answer → 409 carrying the current item; unknown → 404", async () => {
    expect((await post(`/api/queue/${id}/answer`, userHdr, { value: "G" })).statusCode).toBe(400);
    await unchanged();
    expect((await post(`/api/queue/${id}/answer`, userHdr, { value: "A" })).statusCode).toBe(200);
    const again = await post(`/api/queue/${id}/answer`, userHdr, { value: "B" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already answered", item: await item(id) });
    expect((await post("/api/queue/qzzzzzzzz/answer", userHdr, { value: "A" })).statusCode).toBe(404);
  });
});

// Overview decision 60: the route is the gate for the Queue tab, the thread's ticket cards and
// any other client of the API.
describe("POST /api/queue/:id/answer — a pr item is approved only by its merge", () => {
  const prItem: NewItem = { ...base, kind: "pr", title: "PR #12", blocking: false, pr: { url: PR_URL, number: 12 } };
  const localItem: NewItem = { ...base, kind: "pr", title: "Branch", blocking: false, pr: { local: { repo: "app-shop", branch: "agent/a1", aheadAtAdd: true } } };
  const file = (id: string) => readFileSync(join(dir, "queue", `${id}.json`), "utf8");

  it("approve while the PR is open → 409 with the reason and the unchanged item; the item file is not touched", async () => {
    const { id } = await store.add(prItem);
    const before = file(id);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "PR #12 is not merged (open). Merge it first: this item then closes on its own.", reason: "pr-not-merged", item: await item(id),
    });
    expect(file(id)).toBe(before);
  });

  it("approve while the PR is closed without a merge → 409", async () => {
    prState = "CLOSED";
    const { id } = await store.add(prItem);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "pr-not-merged", error: expect.stringContaining("closed without a merge") });
    expect((await item(id)).status).toBe("open");
  });

  it("approve while gh fails → 409 pr-state-unknown (fail closed)", async () => {
    prState = null;
    const { id } = await store.add(prItem);
    const before = file(id);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "pr-state-unknown", error: "Could not read the state of PR #12 (gh: connection refused). Approve is refused. Try again." });
    expect(file(id)).toBe(before);
  });

  it("a local-branch item: refused while the branch is not in its base; closed as merged once it is", async () => {
    const { id } = await store.add(localItem);
    const no = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toMatchObject({ reason: "pr-not-merged", error: "Branch agent/a1 is not merged (not in main). Merge it first: this item then closes on its own." });
    ancestor = true;
    const yes = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ status: "withdrawn", lastError: "merged", delivery: { msgId: `${id}-m`, state: "pending" } });
  });

  it("approve once the PR is merged → 200: the item is closed as merged, with no answer and the merged line owed", async () => {
    prState = "MERGED";
    const { id } = await store.add(prItem);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "approve" });
    expect(res.statusCode).toBe(200);
    const it = await item(id);
    expect(it).toMatchObject({ status: "withdrawn", lastError: "merged", closedAt: NOW, delivery: { msgId: `${id}-m`, state: "pending", attempts: 0 } });
    expect(it.answer).toBeUndefined();
  });

  it("changes stays allowed while the PR is open", async () => {
    const { id } = await store.add(prItem);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "changes", text: "split it" });
    expect(res.statusCode).toBe(200);
    expect((await item(id)).answer).toMatchObject({ value: "changes", text: "split it", by: "user" });
  });

  it("no agent, lead or master request approves it either (pair-required before any gate), and no recommend is taken", async () => {
    const { id } = await store.add(prItem);
    for (const h of [A1, MASTER, agentHdr("lead-app"), {}]) {
      const res = await post(`/api/queue/${id}/answer`, h, { value: "approve" });
      expect(res.statusCode).toBe(403);
    }
    const rec = await post(`/api/queue/${id}/recommend`, MASTER, { value: "approve", why: "checks pass", ruleIds: ["r_ab12c"] });
    expect(rec.statusCode).toBe(400);
    expect(rec.json()).toEqual({ error: "recommend is only for choice and question items" });
    expect(await item(id)).toMatchObject({ status: "open" });
    expect((await item(id)).recommend).toBeUndefined();
  });
});

describe("POST /api/queue/:id/recommend", () => {
  it("a worker → 403; the master → 200 with the recommendation", async () => {
    const { id } = await store.add(choice);
    const { rule } = await rules.add({ text: "prefer the registry", state: "active", kind: "correction",
      scope: { area: "app-shop", repo: "app-shop", kind: "choice", audience: "all" },
      source: { origin: "user-line", itemId: "qx", agentId: "a1", via: "queue-tab" } });
    const body = { value: "B", why: "fits", ruleIds: [rule.id] };
    for (const h of [A1, A2, {}, userHdr]) {
      const res = await post(`/api/queue/${id}/recommend`, h, body);
      expect(res.statusCode).toBe(403);
    }
    expect((await item(id)).recommend).toBeUndefined();
    const res = await post(`/api/queue/${id}/recommend`, MASTER, body);
    expect(res.statusCode).toBe(200);
    expect((res.json() as QueueItem).recommend).toEqual({ ...body, by: FLEET_MASTER_ID, at: NOW });
  });
});

describe("undo, snooze, withdraw, delivery", () => {
  let id: string;
  beforeEach(async () => { id = (await store.add(choice)).id; });

  it("undo: USER inside the window → 200 open; agents and headerless → 403 pair-required", async () => {
    await post(`/api/queue/${id}/answer`, userHdr, { value: "A" });
    for (const h of [A1, {}, { ...A1, ...userHdr }]) {
      const res = await post(`/api/queue/${id}/undo`, h);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(pairRequired);
    }
    const m = await post(`/api/queue/${id}/undo`, MASTER);
    expect(m.statusCode).toBe(403);
    expect(m.json()).toEqual({ error: "the master undoes only its own auto answer" });
    expect((await item(id)).status).toBe("answered");
    const res = await post(`/api/queue/${id}/undo`, userHdr);
    expect(res.statusCode).toBe(200);
    expect((res.json() as QueueItem).status).toBe("open");
  });

  it("undo: the master undoes its own auto answer → 200 open; leads are refused", async () => {
    await patch(id, (i) => ({
      ...i, status: "auto", answerSeq: 1, answer: { value: "A", by: "master", via: "cli", at: NOW - 1000, ruleIds: ["r_ab12c"], confidence: 0.9 },
      delivery: { msgId: `${i.id}-1`, state: "held", deliverAfter: NOW + 60_000, attempts: 0 },
    }));
    const lead = await post(`/api/queue/${id}/undo`, agentHdr("lead-app"));
    expect(lead.json()).toEqual(pairRequired);
    expect((await item(id)).status).toBe("auto");
    const res = await post(`/api/queue/${id}/undo`, MASTER);
    expect(res.statusCode).toBe(200);
    expect((res.json() as QueueItem).status).toBe("open");
    expect((await item(id)).answer).toBeUndefined();
  });

  it("snooze: USER → 200 snoozed; bad minutes → 400; agents → 403 pair-required", async () => {
    for (const h of [A1, {}]) expect((await post(`/api/queue/${id}/snooze`, h, { minutes: 30 })).json()).toEqual(pairRequired);
    for (const p of [{ minutes: 0 }, { minutes: 1.5 }, {}, undefined]) {
      expect((await post(`/api/queue/${id}/snooze`, userHdr, p)).statusCode).toBe(400);
    }
    const res = await post(`/api/queue/${id}/snooze`, userHdr, { minutes: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "snoozed", snoozedUntil: NOW + 30 * 60_000 });
  });

  it("withdraw: another agent → 403, headerless → 403 pair-required, the item's own agent → 200", async () => {
    expect((await post(`/api/queue/${id}/withdraw`, A2)).statusCode).toBe(403);
    expect((await post(`/api/queue/${id}/withdraw`, {})).json()).toEqual(pairRequired);
    expect((await item(id)).status).toBe("open");
    const res = await post(`/api/queue/${id}/withdraw`, A1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "withdrawn", closedAt: NOW });
  });

  it("withdraw: USER → 200", async () => {
    const res = await post(`/api/queue/${id}/withdraw`, userHdr);
    expect(res.statusCode).toBe(200);
    expect((res.json() as QueueItem).status).toBe("withdrawn");
  });

  it("delivery: USER resends a failed slot; agents → 403 pair-required; a bad action → 400", async () => {
    await patch(id, (i) => ({ ...i, status: "answered", answer: { value: "A", by: "user", via: "tab", at: NOW }, answerSeq: 1,
      delivery: { msgId: `${id}-1`, state: "failed", attempts: 3, lastError: "not-live" } }));
    for (const h of [A1, MASTER, {}]) expect((await post(`/api/queue/${id}/delivery`, h, { action: "resend" })).json()).toEqual(pairRequired);
    expect((await post(`/api/queue/${id}/delivery`, userHdr, { action: "nope" })).statusCode).toBe(400);
    expect((await post(`/api/queue/${id}/delivery`, userHdr)).statusCode).toBe(400);
    expect((await post(`/api/queue/${id}/delivery`, userHdr, { action: "resend", slot: "withdrawal" })).statusCode).toBe(409);
    const res = await post(`/api/queue/${id}/delivery`, userHdr, { action: "resend" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as QueueItem).delivery).toEqual({ msgId: `${id}-1`, state: "pending", attempts: 3 });
  });
});

describe("misconfigured", () => {
  it("answers 503 on every route, for every caller, and does nothing", async () => {
    await rebuild({ misconfigured: "CHIEF_CONSOLE_URL is not set" });
    const { id } = await store.add(choice);
    const routes: [("GET" | "POST"), string, unknown][] = [
      ["GET", "/api/queue", undefined], ["GET", `/api/queue/${id}`, undefined], ["POST", "/api/queue", Q],
      ["POST", `/api/queue/${id}/answer`, { value: "A" }], ["POST", `/api/queue/${id}/recommend`, { value: "A", why: "w", ruleIds: ["r_ab12c"] }],
      ["POST", `/api/queue/${id}/undo`, undefined], ["POST", `/api/queue/${id}/snooze`, { minutes: 5 }],
      ["POST", `/api/queue/${id}/withdraw`, undefined], ["POST", `/api/queue/${id}/delivery`, { action: "resend" }],
    ];
    for (const [method, url, payload] of routes) {
      for (const headers of [{}, userHdr, A1, MASTER]) {
        const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
        expect(res.statusCode, `${method} ${url}`).toBe(503);
        expect(res.json()).toEqual({ error: CHIEF_ERR.misconfigured });
      }
    }
    expect(await store.list()).toEqual([await item(id)]);
    expect((await item(id)).status).toBe("open");
    expect(refreshSoon).not.toHaveBeenCalled();
    expect(addQueue).not.toHaveBeenCalled();
  });
});

describe("images in the user's answer: POST /api/queue/:id/answer-image and the answer's images", () => {
  let wt: string;
  const GIF = Buffer.from("GIF89a gif-body");
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "chief-queue-answer-wt-"));
    RECORDS.im = rec("im", { worktree: wt, repo: wt });
  });
  afterEach(() => { delete RECORDS.im; rmSync(wt, { recursive: true, force: true }); });
  const mine = (o: Partial<NewItem> = {}) => ({ ...question, agentId: "im", createdBy: { agentId: "im", kind: "worker" as const }, ...o });
  const addMine = async (o: Partial<NewItem> = {}) => (await store.add(mine(o) as NewItem)).id;
  const upload = (id: string, body: Buffer, headers: H = userHdr) =>
    app.inject({ method: "POST", url: `/api/queue/${id}/answer-image`, headers: { ...headers, "content-type": "application/octet-stream" }, payload: body });
  const draftOf = async (id: string, body: Buffer = PNG): Promise<string> => {
    const res = await upload(id, body);
    expect(res.statusCode).toBe(200);
    return (res.json() as { name: string }).name;
  };
  const media = (id: string) => join(dir, "queue", "media", id);
  const ls = (d: string): string[] => { try { return readdirSync(d).sort(); } catch { return []; } };

  it("the gate: only the paired user uploads; an agent header (even the ticket's own agent), the master and no credential get pair-required", async () => {
    const id = await addMine();
    for (const h of [agentHdr("im"), A1, MASTER, {}]) {
      const res = await upload(id, PNG, h);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(pairRequired);
    }
    // An agent with a user token is still an agent (callerOf): never the user.
    const res = await upload(id, PNG, { ...agentHdr("im"), ...userHdr });
    expect(res.statusCode).toBe(403);
    expect(ls(media(id))).toEqual([]);
    await rebuild({ strong: true });
    const id2 = await addMine();
    expect((await upload(id2, PNG, agentHdr("im"))).statusCode).toBe(403);
    expect((await upload(id2, PNG)).statusCode).toBe(200);
  });

  it("the limits: the type from the bytes (not the content type), 10 MB, a ticket that takes a reply", async () => {
    const id = await addMine();
    const svg = await upload(id, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"));
    expect(svg.statusCode).toBe(415);
    // Sent as image/png, the bytes are HTML: refused (the route reads only bytes).
    const html = await app.inject({ method: "POST", url: `/api/queue/${id}/answer-image`, headers: { ...userHdr, "content-type": "image/png" }, payload: Buffer.from("<html>") });
    expect(html.statusCode).toBe(415);
    const big = await upload(id, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    expect(big.statusCode).toBe(413);
    expect(ls(media(id))).toEqual([]);
    expect((await upload("q0000none", PNG)).statusCode).toBe(404);
    const done = await addMine();
    await patch(done, (it) => ({ ...it, status: "withdrawn", closedAt: NOW }));
    expect((await upload(done, PNG)).statusCode).toBe(409);
  });

  it("an answer with images and no text: the agent's copy (the composer's path), the ticket's copy, and the media route serves only the kept one", async () => {
    const id = await addMine();
    const a = await draftOf(id), b = await draftOf(id, GIF), unused = await draftOf(id);
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "reply", images: [a, b] });
    expect(res.statusCode).toBe(200);
    const ans = (await item(id)).answer!;
    expect(ans.text).toBeUndefined();
    expect(ans.images!.map((x) => x.name)).toEqual(["a1-1.png", "a1-2.gif"]);
    for (const [n, x] of ans.images!.entries()) {
      expect(x.path).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.(png|gif)$/);
      expect(readFileSync(join(wt, x.path))).toEqual(n === 0 ? PNG : GIF);
    }
    expect(ls(media(id))).toEqual(["a1-1.png", "a1-2.gif"]); // the unused draft went
    const img = await get(`/api/queue/${id}/media/a1-2.gif`, userHdr);
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/gif");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect((await get(`/api/queue/${id}/media/${unused}`, userHdr)).statusCode).toBe(404);
    expect((await get(`/api/queue/${id}/media/a1-3.png`, userHdr)).statusCode).toBe(404);
  });

  it("text and images on a change request of a preview; images with an option key or an approve are refused", async () => {
    const pv = await addMine({ kind: "preview", title: "UI", preview: { images: [] } });
    const d = await draftOf(pv);
    expect((await post(`/api/queue/${pv}/answer`, userHdr, { value: "approve", images: [d] })).statusCode).toBe(400);
    const ok = await post(`/api/queue/${pv}/answer`, userHdr, { value: "changes", text: "the gap", images: [d] });
    expect(ok.statusCode).toBe(200);
    expect((await item(pv)).answer).toMatchObject({ value: "changes", text: "the gap", images: [{ name: "a1-1.png" }] });
    const ch = await addMine({ ...choice, agentId: "im" });
    const c = await draftOf(ch);
    expect((await post(`/api/queue/${ch}/answer`, userHdr, { value: "A", images: [c] })).json()).toEqual({ error: "images go only with a reply or a change request" });
    expect(ls(media(ch))).toEqual([c]);
    expect((await post(`/api/queue/${ch}/answer`, userHdr, { value: "reply", images: [c] })).statusCode).toBe(200);
  });

  it("the names: a draft of another ticket, a path, a repeat or a fifth image is refused, with no file touched", async () => {
    const id = await addMine(), other = await addMine({ title: "Other" });
    const mineD = await draftOf(id), theirs = await draftOf(other);
    const tries: [unknown, number][] = [
      [[mineD, theirs], 409], [[mineD, mineD], 400], [["../../x.png"], 400], [[join(wt, "x.png")], 400],
      [[mineD, "d-1111111111111111.png", "d-2222222222222222.png", "d-3333333333333333.png", "d-4444444444444444.png"], 400],
    ];
    for (const [images, code] of tries) {
      const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "reply", images });
      expect(res.statusCode).toBe(code);
      expect((await item(id)).status).toBe("open");
    }
    expect(ls(media(id))).toEqual([mineD]);
    expect(ls(media(other))).toEqual([theirs]);
    expect(ls(join(wt, ".choibot", "uploads"))).toEqual([]);
    // An agent can never give images: its answer is refused before any image is read.
    const res = await post(`/api/queue/${id}/answer`, agentHdr("im"), { value: "reply", images: [mineD] });
    expect(res.statusCode).toBe(403);
    expect(ls(media(id))).toEqual([mineD]);
  });

  it("an answer whose write fails keeps nothing: the images are drafts again, and the same answer then goes", async () => {
    const id = await addMine();
    const a = await draftOf(id), b = await draftOf(id, GIF);
    const write = store.write.bind(store);
    let fail = true;
    store.write = async (it) => { if (fail) { fail = false; throw new Error("disk full"); } return write(it); };
    const res = await post(`/api/queue/${id}/answer`, userHdr, { value: "reply", text: "see", images: [a, b] });
    expect(res.statusCode).toBe(500);
    expect((await item(id)).status).toBe("open");
    expect(ls(media(id))).toEqual([a, b].sort());
    const ok = await post(`/api/queue/${id}/answer`, userHdr, { value: "reply", text: "see", images: [a, b] });
    expect(ok.statusCode).toBe(200);
    expect(ls(media(id))).toEqual(["a1-1.png", "a1-2.gif"]);
    store.write = write;
  });

  it("a text answer removes the drafts that wait; an undo keeps the answer's images in the history", async () => {
    const id = await addMine();
    await draftOf(id);
    expect((await post(`/api/queue/${id}/answer`, userHdr, { value: "reply", text: "no picture after all" })).statusCode).toBe(200);
    expect(ls(media(id))).toEqual([]);
    const id2 = await addMine({ title: "Two" });
    const d = await draftOf(id2);
    await post(`/api/queue/${id2}/answer`, userHdr, { value: "reply", images: [d] });
    expect((await post(`/api/queue/${id2}/undo`, userHdr)).statusCode).toBe(200);
    const it2 = await item(id2);
    expect(it2.status).toBe("open");
    expect(it2.history.at(-1)!.images).toEqual([expect.objectContaining({ name: "a1-1.png" })]);
    expect((await get(`/api/queue/${id2}/media/a1-1.png`, userHdr)).statusCode).toBe(200);
  });
});
