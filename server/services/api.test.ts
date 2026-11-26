// server/services/api.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceStore } from "./store.js";
import { EventHub } from "../events.js";
import { createServiceManager } from "./manager.js";
import { registerServiceApi } from "./api.js";

// Fake terminals so no real process spawns during API tests.
function fakeTerminals() {
  const live = new Set<string>();
  const killed: string[] = [];
  return {
    killed,
    spawn(o: any) { live.add(o.id); },
    kill(id: string) { killed.push(id); live.delete(id); },
    has: (id: string) => live.has(id),
    hasSession: async () => false,
    attach: () => null,
    reattach: async () => null,
    resize() {},
  } as any;
}

async function build(): Promise<{ app: FastifyInstance; store: ServiceStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "svc-api-"));
  const store = new ServiceStore(dir);
  const terminals = fakeTerminals();
  const services = createServiceManager(terminals, store, new EventHub());
  const app = Fastify();
  registerServiceApi(app, { services, store, terminals });
  await app.ready();
  return { app, store, dir };
}

describe("service API", () => {
  let app: FastifyInstance, store: ServiceStore, dir: string;
  beforeEach(async () => { ({ app, store, dir } = await build()); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const payload = {
    name: "Pusher", description: "d", command: "/bin/true", args: [], cwd: "/tmp",
    env: {}, requiresConfirm: true, confirmMessage: "spends SOL", autoRestart: true,
  };

  it("creates and lists a service", async () => {
    const created = await app.inject({ method: "POST", url: "/api/services", payload });
    expect(created.statusCode).toBe(201);
    const id = created.json().service.id as string;
    const list = await app.inject({ method: "GET", url: "/api/services" });
    expect(list.json().services.map((s: any) => s.id)).toContain(id);
    expect(list.json().services[0].status).toBe("stopped");
  });

  it("rejects a create with a blank command", async () => {
    const r = await app.inject({ method: "POST", url: "/api/services", payload: { ...payload, command: "  " } });
    expect(r.statusCode).toBe(400);
  });

  it("start without confirm on a requiresConfirm service returns 409", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/services", payload })).json().service.id;
    const r = await app.inject({ method: "POST", url: `/api/services/${id}/start`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().needsConfirm).toBe(true);
  });

  it("start with confirm succeeds", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/services", payload })).json().service.id;
    const r = await app.inject({ method: "POST", url: `/api/services/${id}/start`, payload: { confirm: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
  });

  it("delete is refused while running, allowed after stop", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/services", payload })).json().service.id;
    await app.inject({ method: "POST", url: `/api/services/${id}/start`, payload: { confirm: true } });
    const refused = await app.inject({ method: "DELETE", url: `/api/services/${id}` });
    expect(refused.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/services/${id}/stop` });
    const ok = await app.inject({ method: "DELETE", url: `/api/services/${id}` });
    expect(ok.statusCode).toBe(200);
    expect(await store.load(id)).toBeNull();
  });

  it("patches a definition", async () => {
    const id = (await app.inject({ method: "POST", url: "/api/services", payload })).json().service.id;
    const r = await app.inject({ method: "PATCH", url: `/api/services/${id}`, payload: { autoRestart: false } });
    expect(r.statusCode).toBe(200);
    expect((await store.load(id))?.autoRestart).toBe(false);
  });
});

// Fastify decodes %2F (and %7C) in a param. The default services dir is a
// sibling of the agents dir, so `..%2Fagents%2Ffleet-master` reached an agent
// record; and stop put the raw id into the pkill pattern (`x|` matched every
// dtach session). A malformed id is 404 and touches nothing.
describe("service API malformed ids", () => {
  let app: FastifyInstance, root: string, agentFile: string, agentBody: string;
  let terminals: ReturnType<typeof fakeTerminals>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "svc-api-trav-"));
    await mkdir(join(root, "agents"));
    agentFile = join(root, "agents", "fleet-master.json");
    agentBody = JSON.stringify({ id: "fleet-master", kind: "fleet-master", createdAt: 1 });
    await writeFile(agentFile, agentBody);
    const store = new ServiceStore(join(root, "services"));
    terminals = fakeTerminals();
    const services = createServiceManager(terminals as any, store, new EventHub());
    app = Fastify();
    registerServiceApi(app, { services, store, terminals: terminals as any });
    await app.ready();
  });
  afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

  const bad = "..%2Fagents%2Ffleet-master";

  it("DELETE and PATCH through ../agents/fleet-master -> 404, agent record untouched", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/services/${bad}` });
    expect(del.statusCode).toBe(404);
    const patch = await app.inject({
      method: "PATCH", url: `/api/services/${bad}`,
      payload: { name: "x", command: "/bin/true", cwd: "/tmp" },
    });
    expect(patch.statusCode).toBe(404);
    expect(await readFile(agentFile, "utf8")).toBe(agentBody);
  });

  it("start through ../agents/fleet-master never loads it", async () => {
    const r = await app.inject({ method: "POST", url: `/api/services/${bad}/start`, payload: { confirm: true } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("no such service");
    expect(await readFile(agentFile, "utf8")).toBe(agentBody);
  });

  it("stop with x%7C or an encoded-slash id -> 404, no kill", async () => {
    for (const id of ["x%7C", bad]) {
      const r = await app.inject({ method: "POST", url: `/api/services/${id}/stop` });
      expect(r.statusCode, id).toBe(404);
      expect(r.json(), id).toEqual({ error: "no such service" });
    }
    expect(terminals.killed).toEqual([]);
  });

  it("stop of a well-formed id is unchanged (200, kills svc:<id>)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/services/svc-nope/stop" });
    expect(r.statusCode).toBe(200);
    expect(terminals.killed).toEqual(["svc:svc-nope"]);
  });
});
