// server/agents/api.close.test.ts — POST /api/agents/:id/close with the chief
// on (spec §7 "Close", §13): a lead closes a worker it spawned itself, and no
// other caller gains or loses anything.
import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAgentApi } from "./api.js";
import { CLOSED_TTL_MS, purgeClosedAgents, resumeClosedWithPrompt } from "./closed.js";
import { SessionStore, type AgentRecord } from "./store.js";
import { EventHub, type ConsoleEvent } from "../events.js";
import { makeGate } from "../chief/gate.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, USER_HEADER } from "../chief/auth.js";
import { openItemOf } from "../chief/leads/close.js";
import { QueueStore, type NewItem } from "../chief/queue/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import { ReminderStore } from "../chief/remind/store.js";

const UT = "user-token";
const rec = (over: Partial<AgentRecord> & { id: string }): AgentRecord => ({
  label: over.id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
  hookToken: `tok-${over.id}`, status: "idle", createdAt: 1, ...over,
});
const agent = (id: string) => ({ [AGENT_HEADER]: id, [AGENT_TOKEN_HEADER]: `tok-${id}` });
const user = { [USER_HEADER]: UT };
const choice = (agentId: string): NewItem => ({
  kind: "choice", agentId, createdBy: { agentId, kind: "worker" }, repo: "app-shop", area: "a",
  title: "Pick", body: "b", blocking: true, choice: { options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] },
});

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups) await c(); cleanups = []; });

// Leads lead-a and lead-b. Workers: wa and wa2 (spawned by lead-a), wb (by
// lead-b), wu (started by the user: no spawnedBy), wm (by the fleet master).
// Every worker has a live terminal. `chief: "off"` registers no gate (flag
// off); `queue: false` leaves the open-item lookup out.
async function setup(o: { chief?: "on" | "off" | "misconfigured"; queue?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lead-close-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new SessionStore(join(root, "store"));
  await store.save(rec({ id: "fleet-master", kind: "fleet-master" }));
  await store.save(rec({ id: "lead-a", kind: "lead", area: "a" }));
  await store.save(rec({ id: "lead-b", kind: "lead", area: "b" }));
  await store.save(rec({ id: "wa", spawnedBy: "lead-a" }));
  await store.save(rec({ id: "wa2", spawnedBy: "lead-a" }));
  await store.save(rec({ id: "wb", spawnedBy: "lead-b" }));
  await store.save(rec({ id: "wu" }));
  await store.save(rec({ id: "wm", spawnedBy: "fleet-master" }));
  const live = new Set(["wa", "wa2", "wb", "wu", "wm", "lead-a", "lead-b", "fleet-master"]);
  const killed: string[] = [];
  const terminals = {
    spawn() {}, kill(id: string) { killed.push(id); live.delete(id); }, has: (id: string) => live.has(id),
    write() {}, resize() {}, attach() { return null; },
  };
  const hub = new EventHub();
  const events: ConsoleEvent[] = [];
  hub.subscribe((e) => events.push(e));
  const queue = new QueueStore(join(root, "queue"), { log: () => {} });
  const mode = o.chief ?? "on";
  const chief = mode === "off" ? undefined : makeGate({
    misconfigured: mode === "misconfigured" ? "CHIEF_CONSOLE_URL is not set" : null, userAuth: "log",
    deps: { devices: { verify: async (t: string) => (t === UT ? { label: "phone", createdAt: 1, lastUsedAt: 1 } : null) }, agents: store },
  });
  const app = Fastify();
  cleanups.push(() => app.close());
  registerAgentApi(app, {
    terminals: terminals as any, store, hub, workspaceDir: join(root, "ws"), chief,
    ...(o.queue === false || mode !== "on" ? {} : { openQueueItem: (id: string) => openItemOf(queue, id) }),
  });
  const close = (id: string, headers: Record<string, string> = {}, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/agents/${id}/close`, headers, ...(payload ? { payload, query: payload as Record<string, string> } : {}) });
  const del = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/api/agents/${id}/delete`, headers });
  // The close did nothing: the record is as it was, its session was not stopped, no event went out.
  const untouched = async (id: string) => {
    const r = await store.load(id);
    expect(r?.closedAt).toBeUndefined();
    expect(r?.status).not.toBe("done");
    expect(killed).toEqual([]);
    expect(events.filter((e) => e.type !== "queue")).toEqual([]);
  };
  const setItem = async (id: string, patch: Partial<QueueItem>) => {
    await queue.withItem(id, async () => { await queue.write({ ...(await queue.get(id))!, ...patch }); });
  };
  return { root, store, queue, hub, events, killed, close, del, untouched, setItem };
}

describe("a lead closes a worker it spawned (chief on)", () => {
  it("its own idle worker -> 202: closed, stopped, and the rail hears agent-closed", async () => {
    const t = await setup();
    const res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(202);
    const r = await t.store.load("wa");
    expect(r?.closedAt).toBeTypeOf("number");
    expect(r?.status).toBe("done");
    expect(t.killed).toEqual(["wa"]);
    expect(t.events).toEqual([
      { type: "agent-status", agentId: "wa", status: "done" },
      { type: "agent-closed", agentId: "wa" },
    ]);
    // Its other worker is not touched.
    expect((await t.store.load("wa2"))?.closedAt).toBeUndefined();
  });

  it("a stopped own worker (done, error) is closed too", async () => {
    for (const status of ["done", "error"] as const) {
      const t = await setup();
      await t.store.patch("wa", { status });
      expect((await t.close("wa", agent("lead-a"))).statusCode).toBe(202);
      expect((await t.store.load("wa"))?.closedAt).toBeTypeOf("number");
    }
  });

  it("closing it again is a no-op that keeps the first close time", async () => {
    const t = await setup();
    await t.close("wa", agent("lead-a"));
    const first = (await t.store.load("wa"))?.closedAt;
    expect((await t.close("wa", agent("lead-a"))).statusCode).toBe(202);
    expect((await t.store.load("wa"))?.closedAt).toBe(first);
  });

  it.each([
    ["another lead's worker", "wb", "refused: wb was not spawned by lead-a; a lead closes only the workers it spawned"],
    ["an agent the user started", "wu", "refused: wu was not spawned by lead-a; a lead closes only the workers it spawned"],
    ["a worker of the fleet master", "wm", "refused: wm was not spawned by lead-a; a lead closes only the workers it spawned"],
    ["another lead", "lead-b", "refused: lead-b is a lead; a lead closes only the workers it spawned"],
    ["itself", "lead-a", "refused: lead-a is a lead; a lead closes only the workers it spawned"],
    ["the fleet master", "fleet-master", "refused: fleet-master is the fleet master; a lead closes only the workers it spawned"],
  ])("%s -> 403 with the reason, nothing changed", async (_n, id, error) => {
    const t = await setup();
    const res = await t.close(id, agent("lead-a"));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error });
    await t.untouched(id);
  });

  it("an unknown id -> 404", async () => {
    const t = await setup();
    expect((await t.close("nope", agent("lead-a"))).statusCode).toBe(404);
    expect((await t.close("x%2F..%2Fwb", agent("lead-a"))).statusCode).toBe(404);
    expect(t.killed).toEqual([]);
  });

  it("what the request says about itself does not count: only the record's spawnedBy and the token's own record", async () => {
    const t = await setup();
    // A body or query that claims the worker changes nothing.
    const res = await t.close("wb", agent("lead-a"), { spawnedBy: "lead-a", lead: "lead-a" });
    expect(res.statusCode).toBe(403);
    // lead-a's id with a token that is not lead-a's: not a lead at all.
    const forged = await t.close("wa", { [AGENT_HEADER]: "lead-a", [AGENT_TOKEN_HEADER]: "tok-wa" });
    expect(forged.statusCode).toBe(403);
    // A worker that names the lead in the actor header is still a worker.
    const actor = await t.close("wa", { ...agent("wa2"), "x-choibot-actor": "lead-a" });
    expect(actor.statusCode).toBe(403);
    await t.untouched("wa");
    await t.untouched("wb");
  });

  it("a running worker -> 409 with the reason", async () => {
    const t = await setup();
    await t.store.patch("wa", { status: "running" });
    const res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "refused: wa is running; close it when its task is done" });
    expect((await t.store.load("wa"))?.closedAt).toBeUndefined();
    expect(t.killed).toEqual([]);
  });

  it("a worker with an open or snoozed queue item -> 409 with the item id; allowed once the item is settled", async () => {
    const t = await setup();
    const { id: q } = await t.queue.add(choice("wa"));
    const refused = { error: `refused: wa has an open queue item (${q}); close it after the user answers the item` };
    let res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(refused);
    await t.setItem(q, { status: "snoozed", snoozedUntil: Date.now() + 3_600_000 });
    res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(refused);
    expect((await t.store.load("wa"))?.closedAt).toBeUndefined();
    expect(t.killed).toEqual([]);
    for (const status of ["answered", "auto", "withdrawn"] as const) {
      await t.setItem(q, { status });
      expect(await openItemOf(t.queue, "wa")).toBeNull();
    }
    expect((await t.close("wa", agent("lead-a"))).statusCode).toBe(202);
  });

  it("another agent's open item does not hold the worker", async () => {
    const t = await setup();
    await t.queue.add(choice("wa2"));
    await t.queue.add(choice("lead-a"));
    expect((await t.close("wa", agent("lead-a"))).statusCode).toBe(202);
  });

  it("without the open-item lookup a lead closes nothing (fails closed)", async () => {
    const t = await setup({ queue: false });
    const res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(503);
    await t.untouched("wa");
  });

  it("misconfigured -> 503 for a lead, nothing closed", async () => {
    const t = await setup({ chief: "misconfigured" });
    const res = await t.close("wa", agent("lead-a"));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "chief-misconfigured" });
    await t.untouched("wa");
  });
});

describe("the other callers of close (chief on)", () => {
  it.each([
    ["a worker on a sibling", "wa2", "wa"],
    ["a worker on itself", "wa", "wa"],
    ["a worker on a user-started agent", "wa", "wu"],
    ["a user-started agent on a lead's worker", "wu", "wa"],
  ])("%s -> 403, nothing changed", async (_n, caller, target) => {
    const t = await setup();
    const res = await t.close(target, agent(caller));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "refused: only the user or the lead that spawned an agent closes it; a lead closes only the workers it spawned" });
    await t.untouched(target);
  });

  it("agent headers that do not authenticate -> 403 (a bad token, an unknown id, a token alone)", async () => {
    const t = await setup();
    const tries: Record<string, string>[] = [
      { [AGENT_HEADER]: "lead-a", [AGENT_TOKEN_HEADER]: "wrong" },
      { [AGENT_HEADER]: "ghost", [AGENT_TOKEN_HEADER]: "tok-ghost" },
      { [AGENT_TOKEN_HEADER]: "tok-lead-a" },
      { [AGENT_HEADER]: "lead-a" },
      // Agent headers win over a valid user token (auth.ts): never USER.
      { ...user, [AGENT_HEADER]: "lead-a", [AGENT_TOKEN_HEADER]: "wrong" },
    ];
    for (const headers of tries) expect((await t.close("wa", headers)).statusCode).toBe(403);
    await t.untouched("wa");
  });

  it("the user's close works for every agent as before: any spawner, running, with an open item", async () => {
    const t = await setup();
    await t.store.patch("wa", { status: "running" });
    await t.queue.add(choice("wb"));
    for (const [id, headers] of [["wa", user], ["wb", {}], ["wu", user], ["wm", {}]] as const) {
      expect((await t.close(id, headers)).statusCode).toBe(202);
      expect((await t.store.load(id))?.closedAt).toBeTypeOf("number");
    }
    expect(t.killed).toEqual(["wa", "wb", "wu", "wm"]);
    // A persistent agent is never closed, by anyone.
    for (const id of ["lead-a", "fleet-master"]) {
      const res = await t.close(id, user);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "a master agent cannot be closed" });
    }
  });

  it("the fleet master keeps what it had: the gate does not stop it, and gives it nothing new", async () => {
    const t = await setup();
    await t.store.patch("wa", { status: "running" });
    expect((await t.close("wa", agent("fleet-master"))).statusCode).toBe(202);
    for (const id of ["lead-a", "fleet-master"]) {
      expect((await t.close(id, agent("fleet-master"))).statusCode).toBe(400);
    }
  });
});

describe("a lead still cannot delete an agent (chief on)", () => {
  it("its own worker, another agent, a closed worker -> 403, the record stays", async () => {
    const t = await setup();
    await t.close("wa2", agent("lead-a"));
    t.killed.length = 0;
    for (const id of ["wa", "wa2", "wb", "wu"]) {
      const res = await t.del(id, agent("lead-a"));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "refused: a lead does not delete agents; close a finished worker with `agents close <id>`" });
      expect(await t.store.load(id)).not.toBeNull();
    }
    expect(t.killed).toEqual([]);
    // A persistent target keeps its own answer (pair-required).
    expect((await t.del("lead-b", agent("lead-a"))).json()).toMatchObject({ error: "pair-required" });
  });

  it("the user and the fleet master delete as before; flag off, a lead's headers are not read", async () => {
    const t = await setup();
    expect((await t.del("wa", user)).statusCode).toBe(202);
    expect((await t.del("wb", {})).statusCode).toBe(202);
    expect((await t.del("wu", agent("fleet-master"))).statusCode).toBe(202);
    expect(await t.store.load("wa")).toBeNull();
    const off = await setup({ chief: "off" });
    expect((await off.del("wa", agent("lead-a"))).statusCode).toBe(202);
  });
});

describe("close with the chief flag off", () => {
  it("no gate and no agent-closed event: agent headers are not read", async () => {
    const t = await setup({ chief: "off" });
    await t.store.patch("wb", { status: "running" });
    for (const [id, headers] of [["wa", agent("wa2")], ["wb", agent("lead-a")], ["wu", {}]] as const) {
      expect((await t.close(id, headers)).statusCode).toBe(202);
    }
    expect(t.events).toEqual(["wa", "wb", "wu"].map((agentId) => ({ type: "agent-status", agentId, status: "done" })));
    const res = await t.close("lead-a", agent("lead-a"));
    expect(res.statusCode).toBe(400);
  });
});

describe("a worker its lead closed, with an open reminder", () => {
  it("is kept past the 7 days while the reminder is open, and reopens when the reminder is due", async () => {
    const t = await setup();
    const reminders = new ReminderStore(join(t.root, "reminders.json"));
    const added = await reminders.add({ agentId: "wa", agentLabel: "wa", setBy: "wa", dueAt: Date.now() + 9 * 86_400_000, text: "check the rollout" });
    expect(added.ok).toBe(true);
    // An open reminder does not stop the close.
    expect((await t.close("wa", agent("lead-a"))).statusCode).toBe(202);
    expect((await t.close("wa2", agent("lead-a"))).statusCode).toBe(202);
    const closedAt = (await t.store.load("wa"))!.closedAt!;

    // 8 days later: wa2 (no reminder) is deleted, wa is kept.
    const removed: string[] = [];
    const purged = await purgeClosedAgents({
      store: t.store, remove: async (id) => { removed.push(id); await t.store.delete(id); },
      now: () => closedAt + CLOSED_TTL_MS + 86_400_000, reminderHolds: () => reminders.purgeHolds(),
    });
    expect(purged).toEqual(["wa2"]);
    expect(await t.store.load("wa")).not.toBeNull();

    // The due reminder's path (remind/deliver.ts resumeClosed): the same session resumes and the row reopens.
    t.events.length = 0;
    const resumed: Array<{ id: string; prompt?: string }> = [];
    const done = await resumeClosedWithPrompt({
      store: t.store, emit: (e) => t.hub.emitEvent(e), isLive: async () => false,
      resume: async (r, o) => { resumed.push({ id: r.id, prompt: o.prompt }); return "resumed"; },
    }, "wa", "[reminder r_1] check the rollout");
    expect(done).toBe(true);
    expect(resumed).toEqual([{ id: "wa", prompt: "[reminder r_1] check the rollout" }]);
    const r = await t.store.load("wa");
    expect(r?.closedAt).toBeUndefined();
    expect(r?.spawnedBy).toBe("lead-a");
    expect(t.events).toContainEqual({ type: "agent-reopened", agentId: "wa" });
  });
});
