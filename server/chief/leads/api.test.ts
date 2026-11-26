// server/chief/leads/api.test.ts — the /api/leads routes (spec §13): real gate,
// AreaStore and report files in a temp dir; ensureLead, runtimes and the digest
// queue are fakes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DeviceStore, USER_HEADER } from "../auth.js";
import { makeGate } from "../gate.js";
import { AreaStore } from "./areas.js";
import { registerLeadsApi } from "./api.js";

const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
  id, label: id, repo: "/ws/app-shop", worktree: `/ws/wt-${id}`, cwd: `/ws/wt-${id}`, branch: `agent/${id}`, baseBranch: "main",
  sessionId: null, hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...o,
});
const RECORDS: Record<string, AgentRecord> = {
  "lead-app-shop": rec("lead-app-shop", { kind: "lead", area: "app-shop", sessionId: "sess-1", cwd: "/home/lead", status: "running" }),
  w1: rec("w1"),
};
const hdr = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });

let dir: string;
let app: FastifyInstance;
let areas: AreaStore;
let user: Record<string, string>;
let addLead: ReturnType<typeof vi.fn>;
let ensureRt: ReturnType<typeof vi.fn>;
let ensureLead: ReturnType<typeof vi.fn>;
const report = () => join(dir, "leads", "app-shop", "report.md");

let waiting = new Set<string>();
async function build(misconfigured: string | null = null) {
  dir = mkdtempSync(join(tmpdir(), "chief-leads-api-"));
  const devices = new DeviceStore(join(dir, "user-devices.json"));
  user = { [USER_HEADER]: await devices.add("laptop") };
  areas = new AreaStore(join(dir, "areas.json"), { exists: async () => true });
  const agents = { load: async (id: string) => RECORDS[id] ?? null };
  addLead = vi.fn();
  ensureRt = vi.fn();
  ensureLead = vi.fn(async (a: string) => `lead-${a}`);
  app = Fastify();
  registerLeadsApi(app, {
    gate: makeGate({ misconfigured, userAuth: "log", deps: { devices, agents } }),
    areas, agents, leadsDir: join(dir, "leads"), events: { addLead },
    runtimes: { ensure: ensureRt }, ensureLead,
    waits: (id) => waiting.has(id),
  });
}
beforeEach(async () => { await build(); });
afterEach(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });

describe("POST /api/leads/report", () => {
  it("from the lead writes report.md and adds one lead-report digest line", async () => {
    const r = await post("/api/leads/report", hdr("lead-app-shop"), { text: "done: X" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(readFileSync(report(), "utf8")).toBe("done: X");
    expect(addLead).toHaveBeenCalledTimes(1);
    expect(addLead).toHaveBeenCalledWith("lead-report", "app-shop", "lead-app-shop");
  });
  // The master's quiet policy (master/quiet.ts): a pure status report is written but is no event.
  it("needs none: report.md written, no digest line", async () => {
    const r = await post("/api/leads/report", hdr("lead-app-shop"), { text: "status: all green", needs: "none" });
    expect(r.statusCode).toBe(200);
    expect(readFileSync(report(), "utf8")).toBe("status: all green");
    expect(addLead).not.toHaveBeenCalled();
  });
  it("needs decision or problem: one digest line each", async () => {
    expect((await post("/api/leads/report", hdr("lead-app-shop"), { text: "pick A or B", needs: "decision" })).statusCode).toBe(200);
    expect((await post("/api/leads/report", hdr("lead-app-shop"), { text: "CI is red", needs: "problem" })).statusCode).toBe(200);
    expect(addLead).toHaveBeenCalledTimes(2);
    expect(addLead).toHaveBeenLastCalledWith("lead-report", "app-shop", "lead-app-shop");
  });
  it("an unknown needs value is 400: nothing written, no digest line", async () => {
    const r = await post("/api/leads/report", hdr("lead-app-shop"), { text: "x", needs: "maybe" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "needs must be one of none, decision, problem" });
    expect(existsSync(report())).toBe(false);
    expect(addLead).not.toHaveBeenCalled();
  });
  it("from a worker is 403 and writes nothing", async () => {
    const r = await post("/api/leads/report", hdr("w1"), { text: "x" });
    expect(r.statusCode).toBe(403);
    expect(addLead).not.toHaveBeenCalled();
  });
  it("from the user is 403", async () => {
    expect((await post("/api/leads/report", user, { text: "x" })).statusCode).toBe(403);
  });
  it("answers 400 for empty and 1501-char text and leaves report.md unchanged", async () => {
    await post("/api/leads/report", hdr("lead-app-shop"), { text: "first" });
    for (const text of ["", "x".repeat(1501)]) {
      expect((await post("/api/leads/report", hdr("lead-app-shop"), { text })).statusCode).toBe(400);
    }
    expect((await post("/api/leads/report", hdr("lead-app-shop"), {})).statusCode).toBe(400);
    expect(readFileSync(report(), "utf8")).toBe("first");
    expect(addLead).toHaveBeenCalledTimes(1);
    expect((await post("/api/leads/report", hdr("lead-app-shop"), { text: "x".repeat(1500) })).statusCode).toBe(200);
  });
});

describe("POST /api/leads", () => {
  it("is a user action: sets the area, ensures the runtime then the lead, returns the id", async () => {
    const r = await post("/api/leads", user, { area: "app-shop", repos: ["app-shop"] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: "lead-app-shop" });
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["app-shop"] } });
    expect(ensureRt).toHaveBeenCalledWith("lead-app-shop", { starting: true, recordExists: true });
    expect(ensureLead).toHaveBeenCalledWith("app-shop");
    expect(ensureRt.mock.invocationCallOrder[0]).toBeLessThan(ensureLead.mock.invocationCallOrder[0]);
  });
  it("keeps an existing leadId when it sets the repos", async () => {
    await areas.set("app-shop", { repos: ["old"], leadId: "lead-app-shop" });
    await post("/api/leads", user, { area: "app-shop", repos: ["a", "b"] });
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["a", "b"], leadId: "lead-app-shop" } });
  });
  it("refuses a lead, a worker and a bad body", async () => {
    expect((await post("/api/leads", hdr("lead-app-shop"), { area: "x", repos: [] })).statusCode).toBe(403);
    expect((await post("/api/leads", hdr("w1"), { area: "x", repos: [] })).statusCode).toBe(403);
    expect((await post("/api/leads", user, { area: "../x", repos: [] })).statusCode).toBe(400);
    expect((await post("/api/leads", user, { area: "x", repos: "a" })).statusCode).toBe(400);
    expect(ensureLead).not.toHaveBeenCalled();
  });
});

describe("POST /api/leads/:area/avatar", () => {
  beforeEach(async () => { await areas.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" }); });
  it("is a user action: saves the pick, and GET /api/leads returns it", async () => {
    const r = await post("/api/leads/app-shop/avatar", user, { variant: 3 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ area: "app-shop", avatar: 3 });
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop", avatar: 3 } });
    const rows = (await app.inject({ method: "GET", url: "/api/leads", headers: user })).json() as { area: string; avatar: number }[];
    expect(rows.map((x) => [x.area, x.avatar])).toEqual([["app-shop", 3]]);
    // It starts no lead and keeps the repos; a later repos save keeps the pick.
    expect(ensureLead).not.toHaveBeenCalled();
    await post("/api/leads", user, { area: "app-shop", repos: ["a"] });
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["a"], leadId: "lead-app-shop", avatar: 3 } });
  });
  it("variant 0 removes the pick", async () => {
    await post("/api/leads/app-shop/avatar", user, { variant: 5 });
    expect((await post("/api/leads/app-shop/avatar", user, { variant: 0 })).json()).toEqual({ area: "app-shop", avatar: 0 });
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop" } });
  });
  it("refuses a lead, a worker and a caller with no identity: nothing is saved", async () => {
    expect((await post("/api/leads/app-shop/avatar", hdr("lead-app-shop"), { variant: 3 })).statusCode).toBe(403);
    expect((await post("/api/leads/app-shop/avatar", hdr("w1"), { variant: 3 })).statusCode).toBe(403);
    expect((await post("/api/leads/app-shop/avatar", {}, { variant: 3 })).statusCode).toBe(403);
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop" } });
  });
  it("is 400 for a bad variant and 404 for an unknown area", async () => {
    for (const variant of [-1, 12, 1.5, "2", null]) {
      expect([variant, (await post("/api/leads/app-shop/avatar", user, { variant })).statusCode]).toEqual([variant, 400]);
    }
    expect((await post("/api/leads/app-shop/avatar", user)).statusCode).toBe(400);
    expect((await post("/api/leads/nope/avatar", user, { variant: 1 })).statusCode).toBe(404);
    expect((await post("/api/leads/__proto__/avatar", user, { variant: 1 })).statusCode).toBe(404);
    expect(await areas.read()).toEqual({ "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop" } });
  });
});

describe("GET /api/leads", () => {
  it("lists areas with lead status, report time, sessionId and cwd", async () => {
    await areas.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    await areas.set("infra", { repos: ["infra"] });
    mkdirSync(join(dir, "leads", "app-shop"), { recursive: true });
    writeFileSync(report(), "r");
    const r = await app.inject({ method: "GET", url: "/api/leads", headers: hdr("w1") });
    expect(r.statusCode).toBe(200);
    const rows = r.json();
    expect(rows).toHaveLength(2);
    const app2 = rows.find((x: any) => x.area === "app-shop");
    expect(app2).toMatchObject({ repos: ["app-shop"], leadId: "lead-app-shop", status: "running", sessionId: "sess-1", cwd: "/home/lead" });
    expect(typeof app2.reportAt).toBe("number");
    expect(rows.find((x: any) => x.area === "infra")).toMatchObject({ leadId: null, status: null, reportAt: null, sessionId: null, cwd: null });
    expect(app2).not.toHaveProperty("waits");
  });

  it("a lead that waits for the second sign-in says so in its row (the page reads it, never guesses it)", async () => {
    await areas.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    waiting = new Set(["lead-app-shop"]);
    try {
      const rows = (await app.inject({ method: "GET", url: "/api/leads", headers: hdr("w1") })).json();
      expect(rows.find((x: any) => x.area === "app-shop")).toMatchObject({ leadId: "lead-app-shop", waits: true });
    } finally { waiting = new Set(); }
  });
});

describe("GET /api/leads/:area", () => {
  it("returns the report", async () => {
    await areas.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    mkdirSync(join(dir, "leads", "app-shop"), { recursive: true });
    writeFileSync(report(), "hello");
    const r = await app.inject({ method: "GET", url: "/api/leads/app-shop", headers: user });
    expect(r.json()).toEqual({ area: "app-shop", repos: ["app-shop"], leadId: "lead-app-shop", report: "hello" });
  });
  it("is 404 for names that are not own areas", async () => {
    for (const n of ["constructor", "__proto__", "toString"]) {
      expect((await app.inject({ method: "GET", url: `/api/leads/${n}`, headers: user })).statusCode).toBe(404);
    }
    expect(await areas.areaOf("constructor")).toBe("constructor");
  });
  it("is 404 unknown area", async () => {
    const r = await app.inject({ method: "GET", url: "/api/leads/nope", headers: user });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "unknown area" });
  });
});

describe("misconfigured with throwing deps (as index.ts registers them)", () => {
  it("answers 503 on all five routes without touching a dep", async () => {
    await app.close(); rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "chief-leads-api-"));
    const devices = new DeviceStore(join(dir, "user-devices.json"));
    const boom = (): never => { throw new Error("touched"); };
    app = Fastify();
    registerLeadsApi(app, {
      gate: makeGate({ misconfigured: "x", userAuth: "log", deps: { devices, agents: { load: boom as never } } }),
      agents: { load: boom as never }, leadsDir: join(dir, "leads"), events: { addLead: boom },
      areas: { read: boom, setRepos: boom, setAvatar: boom }, runtimes: { ensure: boom }, ensureLead: boom,
    });
    for (const [method, url] of [["GET", "/api/leads"], ["GET", "/api/leads/app-shop"], ["POST", "/api/leads"], ["POST", "/api/leads/report"], ["POST", "/api/leads/app-shop/avatar"]] as const) {
      const r = await app.inject({ method, url, payload: {} });
      expect([method, url, r.statusCode]).toEqual([method, url, 503]);
      expect(r.json()).toEqual({ error: "chief-misconfigured" });
    }
  });
});

describe("misconfigured", () => {
  it("answers 503 on every route", async () => {
    await app.close(); rmSync(dir, { recursive: true, force: true });
    await build("no uid");
    expect((await app.inject({ method: "GET", url: "/api/leads", headers: user })).statusCode).toBe(503);
    expect((await post("/api/leads", user, { area: "a", repos: [] })).statusCode).toBe(503);
    expect((await post("/api/leads/report", hdr("lead-app-shop"), { text: "x" })).statusCode).toBe(503);
  });
});
