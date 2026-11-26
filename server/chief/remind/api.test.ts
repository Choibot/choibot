// server/chief/remind/api.test.ts — the /api/reminders routes: a tiny Fastify
// app with the real gate and store in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../auth.js";
import { CHIEF_ERR, makeGate } from "../gate.js";
import { registerRemindApi } from "./api.js";
import { ReminderStore, type NewReminder } from "./store.js";

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: `label-${id}`, repo: "/ws/app-shop", worktree: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  [FLEET_MASTER_ID]: rec(FLEET_MASTER_ID, { kind: "fleet-master", repo: "" }),
  a1: rec("a1"), a2: rec("a2"),
  "lead-app": rec("lead-app", { kind: "lead", area: "app", repo: "" }),
  w1: rec("w1", { spawnedBy: "lead-app" }),
  shut: rec("shut", { closedAt: 5 }),
};
type H = Record<string, string>;
const agentHdr = (id: string): H => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const MASTER = agentHdr(FLEET_MASTER_ID), A1 = agentHdr("a1"), A2 = agentHdr("a2"), LEAD = agentHdr("lead-app");

const NOW = Date.parse("2026-11-10T15:40:00Z");
const H1 = 3_600_000;

let dir: string;
let app: FastifyInstance;
let store: ReminderStore;
let userHdr: H;

async function build(o: { misconfigured?: string | null } = {}) {
  dir = mkdtempSync(join(tmpdir(), "chief-remind-api-"));
  store = new ReminderStore(join(dir, "reminders.json"), { now: () => NOW, log: () => {} });
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  userHdr = { [USER_HEADER]: await devices.add("laptop") };
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  const gate = makeGate({ misconfigured: o.misconfigured ?? null, userAuth: "log", deps: { devices, agents } });
  app = Fastify();
  registerRemindApi(app, { gate, store, agents, now: () => NOW, log: () => {} });
}
beforeEach(async () => { await build(); });
afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, headers: H, payload?: unknown) => app.inject({ method: "POST", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (url: string, headers: H = {}) => app.inject({ method: "GET", url, headers });
const seed = (o: Partial<NewReminder> = {}) =>
  store.add({ agentId: "a1", agentLabel: "label-a1", setBy: "a1", dueAt: NOW + H1, text: "t", ...o })
    .then((r) => { if (!r.ok) throw new Error(r.error); return r.reminder; });

describe("POST /api/reminders", () => {
  it("an agent sets one for itself: {id, dueAt}", async () => {
    const res = await post("/api/reminders", A1, { in: "3d", text: " check the canary " });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: expect.stringMatching(/^r_[0-9a-z]{8}$/), dueAt: NOW + 3 * 86_400_000 });
    expect(await store.list()).toEqual([expect.objectContaining({
      id: body.id, agentId: "a1", agentLabel: "label-a1", setBy: "a1", text: "check the canary", state: "open",
    })]);
  });

  it("a worker cannot set one for another agent (403)", async () => {
    const res = await post("/api/reminders", A1, { agentId: "a2", in: "1h", text: "t" });
    expect(res.statusCode).toBe(403);
    expect(await store.list()).toEqual([]);
  });

  it("a lead sets them for itself and for the agents it spawned, not for others", async () => {
    expect((await post("/api/reminders", LEAD, { in: "1h", text: "t" })).statusCode).toBe(200);
    expect((await post("/api/reminders", LEAD, { agentId: "w1", in: "1h", text: "t" })).statusCode).toBe(200);
    expect((await post("/api/reminders", LEAD, { agentId: "a1", in: "1h", text: "t" })).statusCode).toBe(403);
    expect((await store.list()).map((r) => [r.agentId, r.setBy])).toEqual([["lead-app", "lead-app"], ["w1", "lead-app"]]);
  });

  it("the fleet master sets them for any agent", async () => {
    expect((await post("/api/reminders", MASTER, { agentId: "a2", in: "1h", text: "t" })).statusCode).toBe(200);
    expect((await store.list())[0]).toMatchObject({ agentId: "a2", setBy: FLEET_MASTER_ID });
  });

  it("the user and a caller with no identity cannot set one", async () => {
    expect((await post("/api/reminders", userHdr, { agentId: "a1", in: "1h", text: "t" })).statusCode).toBe(403);
    expect((await post("/api/reminders", {}, { in: "1h", text: "t" })).statusCode).toBe(403);
    expect((await post("/api/reminders", { [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "wrong" }, { in: "1h", text: "t" })).statusCode).toBe(403);
  });

  it("refuses a missing or closed target", async () => {
    expect((await post("/api/reminders", MASTER, { agentId: "ghost", in: "1h", text: "t" })).statusCode).toBe(404);
    expect((await post("/api/reminders", MASTER, { agentId: "shut", in: "1h", text: "t" })).statusCode).toBe(409);
    expect((await post("/api/reminders", MASTER, { agentId: "../x", in: "1h", text: "t" })).statusCode).toBe(400);
  });

  it("checks the window and the text (400 with the reason)", async () => {
    const r = await post("/api/reminders", A1, { in: "4m", text: "t" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/5 minutes/);
    expect((await post("/api/reminders", A1, { in: "31d", text: "t" })).statusCode).toBe(400);
    expect((await post("/api/reminders", A1, { in: "1h", text: "" })).statusCode).toBe(400);
    expect((await post("/api/reminders", A1, { at: "2026-11-11T09:00:00Z", text: "x".repeat(1001) })).statusCode).toBe(400);
  });

  it("refuses the 11th open reminder of one agent (409)", async () => {
    for (let i = 0; i < 10; i++) expect((await post("/api/reminders", A1, { in: "1h", text: `t${i}` })).statusCode).toBe(200);
    const r = await post("/api/reminders", A1, { in: "1h", text: "t" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/10 open/);
  });

  it("answers 503 while misconfigured", async () => {
    await app.close();
    await build({ misconfigured: "x" });
    const r = await post("/api/reminders", A1, { in: "1h", text: "t" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe(CHIEF_ERR.misconfigured);
  });
});

describe("GET /api/reminders", () => {
  it("any session (the UI) sees every open reminder and the server clock", async () => {
    await seed();
    await seed({ agentId: "a2" });
    const done = await seed({ agentId: "a2" });
    await store.update(done.id, (r) => ({ ...r, state: "delivered" }));
    const r = await get("/api/reminders");
    expect(r.statusCode).toBe(200);
    expect(r.json().serverNow).toBe(NOW);
    expect(r.json().reminders.map((x: { agentId: string }) => x.agentId)).toEqual(["a1", "a2"]);
    expect((await get("/api/reminders?status=all")).json().reminders).toHaveLength(3);
    expect((await get("/api/reminders?status=bogus")).statusCode).toBe(400);
  });

  it("a worker sees its own, a lead its own and its workers', the master and the user all", async () => {
    await seed({ agentId: "a1" });
    await seed({ agentId: "a2" });
    await seed({ agentId: "lead-app", setBy: "lead-app" });
    await seed({ agentId: "w1", setBy: "lead-app" });
    const ids = async (h: H) => (await get("/api/reminders", h)).json().reminders.map((x: { agentId: string }) => x.agentId).sort();
    expect(await ids(A1)).toEqual(["a1"]);
    expect(await ids(LEAD)).toEqual(["lead-app", "w1"]);
    expect(await ids(MASTER)).toEqual(["a1", "a2", "lead-app", "w1"]);
    expect(await ids(userHdr)).toEqual(["a1", "a2", "lead-app", "w1"]);
  });
});

describe("POST /api/reminders/:id/cancel", () => {
  it("an agent cancels its own reminder", async () => {
    const r = await seed();
    const res = await post(`/api/reminders/${r.id}/cancel`, A1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: r.id, state: "cancelled", cancelledBy: "a1", cancelledAt: NOW });
    expect((await store.get(r.id))?.state).toBe("cancelled");
  });

  it("another worker cannot (403); the user, the master and the lead of its worker can", async () => {
    const r = await seed();
    expect((await post(`/api/reminders/${r.id}/cancel`, A2)).statusCode).toBe(403);
    expect((await post(`/api/reminders/${r.id}/cancel`, LEAD)).statusCode).toBe(403);
    const res = await post(`/api/reminders/${r.id}/cancel`, userHdr);
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelledBy).toBe("user");
    const m = await seed({ agentId: "a2" });
    expect((await post(`/api/reminders/${m.id}/cancel`, MASTER)).json().cancelledBy).toBe(FLEET_MASTER_ID);
    const w = await seed({ agentId: "w1" });
    expect((await post(`/api/reminders/${w.id}/cancel`, LEAD)).statusCode).toBe(200);
  });

  it("a caller with no identity must pair", async () => {
    const r = await seed();
    const res = await post(`/api/reminders/${r.id}/cancel`, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(CHIEF_ERR.pairRequired);
  });

  it("404 for an unknown or malformed id; 409 once it is no longer open", async () => {
    expect((await post("/api/reminders/r_zzzzzzzz/cancel", userHdr)).statusCode).toBe(404);
    expect((await post("/api/reminders/..%2Fx/cancel", userHdr)).statusCode).toBe(404);
    const r = await seed();
    await store.update(r.id, (x) => ({ ...x, state: "delivering" }));
    expect((await post(`/api/reminders/${r.id}/cancel`, userHdr)).statusCode).toBe(409);
    await store.update(r.id, (x) => ({ ...x, state: "delivered" }));
    const res = await post(`/api/reminders/${r.id}/cancel`, userHdr);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already delivered");
  });
});
