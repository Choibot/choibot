// server/agents/api.rename.test.ts — POST /api/agents/:id/rename: a new title for the list. The
// user and the masters rename every agent; a lead only a worker it spawned (the owner rule of a
// close, chief/leads/close.ts ownerRefusal); every rename sends "agent-renamed" to the page.
import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";

const UT = "user-token";
const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
  label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
});
const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const user = { [USER_HEADER]: UT };

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups) await c(); cleanups = []; });

// Leads lead-a and lead-b. Workers: wa (spawned by lead-a), wb (by lead-b), wu (by the user).
async function setup(o: { chief?: "on" | "off" | "misconfigured" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "rename-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(join(root, "store"));
  await store.save(rec({ id: "fleet-master", kind: "fleet-master" }));
  await store.save(rec({ id: "lead-a", kind: "lead", area: "a" }));
  await store.save(rec({ id: "lead-b", kind: "lead", area: "b" }));
  await store.save(rec({ id: "wa", spawnedBy: "lead-a" }));
  await store.save(rec({ id: "wb", spawnedBy: "lead-b" }));
  await store.save(rec({ id: "wu" }));
  const hub = new EventHub();
  const events: ConsoleEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const mode = o.chief ?? "on";
  const chief = mode === "off" ? undefined : makeGate({
    misconfigured: mode === "misconfigured" ? "CHIEF_CONSOLE_URL is not set" : null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) }, agents: store },
  });
  const terminals = { spawn() {}, kill() {}, has: () => true, write() {}, resize() {}, attach() { return null; } };
  const app = Fastify();
  cleanups.push(() => app.close());
  registerAgentApi(app, { terminals: terminals as any, store, hub, workspaceDir: join(root, "ws"), chief });
  const rename = (id: string, title: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/agents/${id}/rename`, headers, payload: { title } });
  const renamed = () => events.filter((e) => e.type === "agent-renamed");
  return { store, rename, renamed };
}

describe("POST /api/agents/:id/rename", () => {
  it("a lead renames a worker it spawned: the label changes and the event carries it", async () => {
    const t = await setup();
    const r = await t.rename("wa", "  Worker titles ", agent("lead-a"));
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ id: "wa", label: "Worker titles" });
    expect((await t.store.load("wa"))?.label).toBe("Worker titles");
    expect(t.renamed()).toEqual([{ type: "agent-renamed", agentId: "wa", label: "Worker titles" }]);
  });

  it("a lead cannot rename another lead's worker, a worker of the user, a lead or the fleet master", async () => {
    const t = await setup();
    const refused: Record<string, string> = {
      wb: "refused: wb was not spawned by lead-a; a lead renames only the workers it spawned",
      wu: "refused: wu was not spawned by lead-a; a lead renames only the workers it spawned",
      "lead-b": "refused: lead-b is a lead; a lead renames only the workers it spawned",
      "lead-a": "refused: lead-a is a lead; a lead renames only the workers it spawned",
      "fleet-master": "refused: fleet-master is the fleet master; a lead renames only the workers it spawned",
    };
    for (const [id, error] of Object.entries(refused)) {
      const r = await t.rename(id, "New name", agent("lead-a"));
      expect(r.statusCode, id).toBe(403);
      expect(r.json().error).toBe(error);
      expect((await t.store.load(id))?.label).toBe(id);
    }
    expect(t.renamed()).toEqual([]);
  });

  it("a worker cannot rename (not itself, not another): only the user or the lead that spawned it", async () => {
    const t = await setup();
    for (const id of ["wa", "wb"]) {
      const r = await t.rename(id, "Mine now", agent("wa"));
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("refused: only the user or the lead that spawned an agent renames it; a lead renames only the workers it spawned");
    }
    expect(t.renamed()).toEqual([]);
  });

  it("the user and the fleet master rename every agent", async () => {
    const t = await setup();
    expect((await t.rename("wb", "By the user", user)).statusCode).toBe(202);
    expect((await t.rename("lead-a", "Lead A", user)).statusCode).toBe(202);
    expect((await t.rename("wu", "By the master", agent("fleet-master"))).statusCode).toBe(202);
    expect((await t.store.load("wb"))?.label).toBe("By the user");
    expect((await t.store.load("wu"))?.label).toBe("By the master");
    expect(t.renamed().map((e) => e.type === "agent-renamed" && e.agentId)).toEqual(["wb", "lead-a", "wu"]);
  });

  it("a bad title is refused with one clear line; an unknown agent is not found", async () => {
    const t = await setup();
    for (const [title, error] of [["t".repeat(41), "title is 41 characters; the most is 40"], ["a\nb", "title must be one line"], ["  ", "title must not be empty"], [undefined, "title must be text"]] as const) {
      const r = await t.rename("wa", title, user);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe(error);
    }
    expect((await t.rename("w-ghost", "X", user)).statusCode).toBe(404);
    expect((await t.rename("wa", "x".repeat(40), user)).statusCode).toBe(202);
    expect(t.renamed()).toHaveLength(1);
  });

  it("a lead gets 503 when the chief is misconfigured; flag off renames as the user", async () => {
    const bad = await setup({ chief: "misconfigured" });
    expect((await bad.rename("wa", "X", agent("lead-a"))).statusCode).toBe(503);
    const off = await setup({ chief: "off" });
    expect((await off.rename("wb", "Off", agent("lead-a"))).statusCode).toBe(202);
    expect((await off.store.load("wb"))?.label).toBe("Off");
  });
});
