import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_TEXT, NOT_WAITING_TEXT, registerMasterApi, type MasterStatus } from "./api.js";
import { ensureFleetMaster } from "./master.js";
import { SessionStore, type AgentRecord } from "../agents/store.js";
import type { RecoveryCtx } from "../agents/recovery.js";

const tmps: string[] = [];
afterEach(async () => { while (tmps.length) await rm(tmps.pop()!, { recursive: true, force: true }); });
async function tmp(p: string) { const d = await mkdtemp(join(tmpdir(), p)); tmps.push(d); return d; }

describe("master api", () => {
  it("POST /api/master is idempotent", async () => {
    const store = new SessionStore(await tmp("agents-"));
    const masterDataDir = await tmp("master-");
    const ctx = {
      port: 3100, workspaceDir: "/ws", store,
      claudeHooksPathFor: (r: AgentRecord) => join(r.worktree, ".choibot-hooks.json"),
      writeClaudeHookSettings: async () => {},
      terminals: { has: () => false, reattach: async () => null, spawn: () => {} },
    } as unknown as RecoveryCtx;
    const app = Fastify();
    registerMasterApi(app, {
      ensure: () => ensureFleetMaster({ store, recoveryCtx: ctx, masterDataDir }),
      status: () => ({ queuedEvents: 0, queuedMessages: 0, telegram: false, surface: "tab" }),
    });
    const a = await app.inject({ method: "POST", url: "/api/master" });
    const b = await app.inject({ method: "POST", url: "/api/master" });
    expect(a.json()).toEqual({ id: "fleet-master" });
    expect(b.json()).toEqual({ id: "fleet-master" });
    expect(await store.list()).toHaveLength(1);
  });

  it("GET /api/master/status returns the live status", async () => {
    const s: MasterStatus = { queuedEvents: 3, queuedMessages: 1, telegram: true, surface: "telegram" };
    const app = Fastify();
    registerMasterApi(app, { ensure: async () => "fleet-master", status: () => s });
    const res = await app.inject({ method: "GET", url: "/api/master/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(s);
  });
});

// The fleet master WAITS for the second sign-in (chief/chiefwait.ts): the Master tab gets that
// fact, and a message written there is kept for its start, with one line that says so.
describe("master api while the master waits for the second sign-in", () => {
  function app(waits: boolean) {
    const kept: string[] = [];
    const a = Fastify();
    registerMasterApi(a, {
      ensure: async () => "fleet-master",
      status: () => ({ queuedEvents: 0, queuedMessages: kept.length, telegram: false, surface: "tab" }),
      waits: () => waits, keep: (t) => kept.push(t),
    });
    return { a, kept };
  }

  it("the status says it waits; a message is kept, and the answer says so", async () => {
    const { a, kept } = app(true);
    expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).toMatchObject({ waits: true, queuedMessages: 0 });
    const r = await a.inject({ method: "POST", url: "/api/master/message", payload: { text: "  plan the week  " } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kept: true, text: KEPT_TEXT });
    expect(kept).toEqual(["plan the week"]);
    expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).toMatchObject({ queuedMessages: 1 });
    expect((await a.inject({ method: "POST", url: "/api/master/message", payload: { text: " " } })).statusCode).toBe(400);
  });

  it("a wait for a login that was signed out on the page: the status says waitsLogin too", async () => {
    const a = Fastify();
    registerMasterApi(a, {
      ensure: async () => "fleet-master",
      status: () => ({ queuedEvents: 0, queuedMessages: 0, telegram: false, surface: "tab" }),
      waits: () => true, waitsLogin: () => true, keep: () => {},
    });
    expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).toMatchObject({ waits: true, waitsLogin: true });
    const b = Fastify();
    registerMasterApi(b, { ensure: async () => "fleet-master", status: () => ({ queuedEvents: 0, queuedMessages: 0, telegram: false, surface: "tab" }), waits: () => false, waitsLogin: () => true });
    expect((await b.inject({ method: "GET", url: "/api/master/status" })).json()).not.toHaveProperty("waitsLogin");
  });

  it("when it does not wait: no waits field, and no message route (it has its pane)", async () => {
    const { a, kept } = app(false);
    expect((await a.inject({ method: "GET", url: "/api/master/status" })).json()).not.toHaveProperty("waits");
    const r = await a.inject({ method: "POST", url: "/api/master/message", payload: { text: "hi" } });
    expect([r.statusCode, r.json().error]).toEqual([409, NOT_WAITING_TEXT]);
    expect(kept).toEqual([]);
  });
});
