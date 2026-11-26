// server/chief/wsgate.test.ts — the socket half of the code-route gate (spec
// §3; plan Task 2c-4, Review Focus 3). The real service terminal
// route runs with fake terminals: no PTY spawns. Sockets are injected
// (injectWS) except the handshake tests, which listen on an ephemeral
// 127.0.0.1 port.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../agents/store.js";
import { EventHub } from "../events.js";
import { registerServiceApi } from "../services/api.js";
import { createServiceManager } from "../services/manager.js";
import { ServiceStore } from "../services/store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER } from "./auth.js";
import { checkHardened, codeRouteGate, hardenedDeployment, setCodeRouteGate, type HardenedFs } from "./hardened.js";
import {
  WS_PAIR_TEXT, armCodeRouteGate, echoFirstProtocol, terminalWsGate, wsUserOk, type TerminalWsGate,
} from "./wsgate.js";

type Env = Record<string, string | undefined>;
const ACTIVE: Env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
const HARD: Env = { ...ACTIVE, CHIEF_AGENT_UID: "1001" };
// Not hardened: flag off, the chief on without CHIEF_AGENT_UID (rollback), an
// invalid uid, a misconfigured chief with a uid.
const NOT_HARD: [string, Env][] = [
  ["flag off", {}],
  ["no CHIEF_AGENT_UID", ACTIVE],
  ["invalid uid", { ...ACTIVE, CHIEF_AGENT_UID: "0" }],
  ["misconfigured", { CHIEF_ENABLED: "1", CHIEF_AGENT_UID: "1001" }],
];

const TOKEN = "u".repeat(43);
const devices = { verify: async (t: string) => (t === TOKEN ? { label: "phone", createdAt: 0, lastUsedAt: 0 } : null) };
const noAgents = { load: async (): Promise<AgentRecord | null> => null };
const hardGate = (): TerminalWsGate => terminalWsGate({ devices, agents: noAgents, env: HARD })!;
const proto = (v: string) => ({ "sec-websocket-protocol": v });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

// A fake FastifyRequest: wsUserOk reads only the headers.
const reqWith = (headers: Record<string, unknown>) => ({ headers }) as never;

describe("wsUserOk", () => {
  it("checks the first Sec-WebSocket-Protocol value as a user token", async () => {
    const asked: string[] = [];
    const verify = async (t: string) => { asked.push(t); return t === TOKEN; };
    expect(await wsUserOk(reqWith(proto(TOKEN)), verify)).toBe(true);
    expect(await wsUserOk(reqWith(proto(`${TOKEN}, other`)), verify)).toBe(true);
    expect(await wsUserOk(reqWith(proto(`other, ${TOKEN}`)), verify)).toBe(false);
    expect(await wsUserOk(reqWith(proto("nope")), verify)).toBe(false);
    expect(asked).toEqual([TOKEN, TOKEN, "other", "nope"]);
  });

  it("no header, an empty or non-string value → false, the verifier never asked", async () => {
    const asked: string[] = [];
    const verify = async (t: string) => { asked.push(t); return true; };
    expect(await wsUserOk(reqWith({}), verify)).toBe(false);
    expect(await wsUserOk(reqWith(proto("")), verify)).toBe(false);
    expect(await wsUserOk(reqWith(proto(" , x")), verify)).toBe(false);
    expect(await wsUserOk(reqWith({ "sec-websocket-protocol": [TOKEN] }), verify)).toBe(false);
    expect(asked).toEqual([]);
  });

  // callerOf (auth.ts): a request with an agent header is never USER.
  it("a request with an agent header is never the user, even with a valid token", async () => {
    const verify = async (t: string) => t === TOKEN;
    expect(await wsUserOk(reqWith({ ...proto(TOKEN), [AGENT_HEADER]: "w1" }), verify)).toBe(false);
    expect(await wsUserOk(reqWith({ ...proto(TOKEN), [AGENT_TOKEN_HEADER]: "x" }), verify)).toBe(false);
  });

  it("a verifier that throws → false", async () => {
    expect(await wsUserOk(reqWith(proto(TOKEN)), async () => { throw new Error("disk"); })).toBe(false);
  });
});

describe("terminalWsGate", () => {
  it.each(NOT_HARD)("is undefined when not hardened (%s)", (_n, env) => {
    expect(terminalWsGate({ devices, agents: noAgents, env })).toBeUndefined();
  });

  it("is defined in a hardened deployment", () => {
    expect(terminalWsGate({ devices, agents: noAgents, env: HARD })).toBeDefined();
  });
});

describe("echoFirstProtocol", () => {
  it("picks the first offered subprotocol", () => {
    expect(echoFirstProtocol(new Set([TOKEN, "b"]))).toBe(TOKEN);
    expect(echoFirstProtocol(new Set())).toBe(false);
  });
});

// Ruling P7: the plugin as index.ts registers it, on a real socket.
describe("handshake (websocket plugin with echoFirstProtocol)", () => {
  let app: FastifyInstance;
  let port: number;
  beforeEach(async () => {
    app = Fastify();
    await app.register(websocket, { options: { handleProtocols: echoFirstProtocol } });
    app.get("/t", { websocket: true }, (socket) => { socket.send("hi"); });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });
  afterEach(async () => { await app.close(); });

  function handshake(protocol?: string): Promise<IncomingHttpHeaders> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port, path: "/t",
        headers: {
          Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          ...(protocol === undefined ? {} : { "Sec-WebSocket-Protocol": protocol }),
        },
      });
      req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.headers); });
      req.on("response", (res) => reject(new Error(`no upgrade: ${res.statusCode}`)));
      req.on("error", reject);
      req.end();
    });
  }

  it("none offered → no Sec-WebSocket-Protocol header (today's handshake)", async () => {
    const h = await handshake();
    expect(Object.keys(h)).not.toContain("sec-websocket-protocol");
  });

  it("offered → the first one echoed", async () => {
    expect((await handshake(`${TOKEN}, b`))["sec-websocket-protocol"]).toBe(TOKEN);
  });

  // A browser fails the handshake when its subprotocol is not echoed: a
  // stored token must never break a terminal, whatever the mode.
  it("a browser-style client offering a token opens", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/t`, [TOKEN]);
    const first = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (e) => resolve(String(e.data));
      ws.onerror = () => reject(new Error("handshake failed"));
    });
    expect(first).toBe("hi");
    expect(ws.protocol).toBe(TOKEN);
    ws.close();
  });
});

// Fake terminals that log every call the gate must prevent.
function fakeTerminals() {
  const live = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    spawn(o: { id: string }) { calls.push(`spawn:${o.id}`); live.add(o.id); },
    kill(id: string) { live.delete(id); },
    drop(id: string) { live.delete(id); }, // the PTY died
    has: (id: string) => live.has(id),
    hasSession: async () => false,
    attach(id: string) { calls.push(`attach:${id}`); return { snapshot: "SNAP", subscribe: () => () => {} }; },
    reattach: async (id: string) => { calls.push(`reattach:${id}`); return null; },
    write(id: string, d: string) { calls.push(`write:${id}:${d}`); },
    resize(id: string, c: number, r: number) { calls.push(`resize:${id}:${c}x${r}`); },
  };
}

type Opened = { frames: string[]; closed: number | null };

// Opens a socket, sends `send` as soon as it is open, waits, then ends it.
async function open(app: FastifyInstance, path: string, headers: Record<string, string> = {}, send: object[] = []): Promise<Opened> {
  const out: Opened = { frames: [], closed: null };
  const ws = await app.injectWS(path, { headers } as never, {
    onInit: (s: any) => {
      s.on("message", (d: Buffer) => out.frames.push(d.toString()));
      s.on("close", (code: number) => { out.closed = code; });
    },
    onOpen: (s: any) => { for (const m of send) s.send(JSON.stringify(m)); },
  } as never);
  await tick();
  ws.terminate();
  return out;
}

const INPUT = { t: "input", data: "id\r" };
const RESIZE = { t: "resize", cols: 80, rows: 24 };

describe("/api/services/:id/terminal", () => {
  let t: ReturnType<typeof fakeTerminals>;
  let app: FastifyInstance;
  let dir: string;
  let loads: string[];
  const SVC = "svc-1";

  async function build(gate: TerminalWsGate | undefined): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "wsgate-svc-"));
    const store = new ServiceStore(dir);
    await store.save({
      id: SVC, createdAt: 1, name: "P", description: "", command: "/bin/true", args: [], cwd: "/tmp", env: {},
      requiresConfirm: false, confirmMessage: "", autoRestart: false,
    });
    loads = [];
    const load = store.load.bind(store);
    store.load = async (x: string) => { loads.push(x); return load(x); };
    t = fakeTerminals();
    app = Fastify();
    await app.register(websocket);
    const services = createServiceManager(t as never, store, new EventHub());
    registerServiceApi(app, { services, store, terminals: t as never, wsGate: gate });
    await app.ready();
  }
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it("hardened, no token → the reason line and a final close; nothing loaded, attached or resized", async () => {
    await build(hardGate());
    const r = await open(app, `/api/services/${SVC}/terminal`, {}, [RESIZE]);
    expect(r.frames).toEqual([WS_PAIR_TEXT]);
    expect(r.closed).toBe(4000);
    expect(t.calls).toEqual([]);
    expect(loads).toEqual([]);
  });

  it("hardened, the user token → today's stream", async () => {
    await build(hardGate());
    const r = await open(app, `/api/services/${SVC}/terminal`, proto(TOKEN));
    expect(r.frames).toEqual(["SNAP"]);
    expect(r.closed).toBe(null);
    expect(t.calls).toEqual([`attach:svc:${SVC}`]);
    expect(loads).toEqual([SVC]);
  });

  it.each(NOT_HARD)("not hardened (%s): no token → today's stream", async (_n, env) => {
    await build(terminalWsGate({ devices, agents: noAgents, env }));
    const r = await open(app, `/api/services/${SVC}/terminal`);
    expect(r.frames).toEqual(["SNAP"]);
    expect(t.calls).toEqual([`attach:svc:${SVC}`]);
  });
});

// Check (4) of chiefHardened: the flag the monitor reads (index.ts facts).
describe("armCodeRouteGate and check (4)", () => {
  afterEach(() => { setCodeRouteGate(false); });

  const fs: HardenedFs = {
    ownerUid: () => 1000, linkOwnerUid: () => 1001,
    mode: (p) => (p === "/fx/homes" ? 0o43770 : p === "/fx/console/.env" ? 0o100600 : 0o40700),
    readdir: () => [], readFile: () => "", readlink: () => "",
  };
  const check = (agentExec = true) => checkHardened({
    dataDir: "/fx/chief", cronDir: "/fx/cron", envFile: "/fx/console/.env", homeRoot: "/fx/homes",
    selfUid: 1000, agentUid: 1001, dtachDir: "/fx/dtach", procRoot: "/fx/proc",
    agentExec, codeRouteGate: codeRouteGate(), fs,
  });

  it("stays off until both halves are registered, then check (4) passes", () => {
    expect(codeRouteGate()).toBe(false);
    expect(check().reasons).toEqual(["code-route gate off"]);
    expect(armCodeRouteGate({ hook: false, sockets: hardGate(), agentExec: true })).toBe(false);
    expect(armCodeRouteGate({ hook: true, sockets: undefined, agentExec: true })).toBe(false);
    expect(codeRouteGate()).toBe(false);
    expect(check().strong).toBe(false);
    expect(armCodeRouteGate({ hook: true, sockets: hardGate(), agentExec: true })).toBe(true);
    expect(codeRouteGate()).toBe(true);
    expect(check()).toEqual({ strong: true, reasons: [], consoleUidAgents: [] });
  });

  // Ruling F3: a failed helper probe (no agentExec) never arms check (4), and
  // check (4) names it: widget scripts would run as the console uid.
  it("without agent exec (the probe failed) the gate is not armed: weak, agent exec unavailable", () => {
    expect(armCodeRouteGate({ hook: true, sockets: hardGate(), agentExec: false })).toBe(false);
    expect(codeRouteGate()).toBe(false);
    expect(check(false)).toEqual({
      strong: false, reasons: ["agent exec unavailable", "code-route gate off"], consoleUidAgents: [],
    });
  });

  // As index.ts calls it: the hook is registered only in a hardened deployment.
  it.each(NOT_HARD)("not hardened (%s): no socket gate, the flag stays off", (_n, env) => {
    const sockets = terminalWsGate({ devices, agents: noAgents, env });
    expect(armCodeRouteGate({ hook: hardenedDeployment(env), sockets, agentExec: false })).toBe(false);
    expect(codeRouteGate()).toBe(false);
  });
});

// Deferred 2c-4 test: index.ts registers the code-route hook before any
// route, the two terminal routes before armCodeRouteGate, and arms it only
// with agentExec (ruling F3). A static check of the source order: index.ts
// starts the whole server, so it cannot run here.
describe("index.ts registration order (static)", () => {
  it("hook, then every terminal route, then armCodeRouteGate with agentExec; the facts carry agentExec", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    const at = (needle: string): number => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      expect(src.indexOf(needle, i + 1), `${needle} once`).toBe(-1);
      return i;
    };
    const hook = at("registerCodeRouteGate(app, ");
    const firstRoute = at("registerApi(app, ");
    const agents = at("registerTerminalWs(app, terminals, {");
    const services = at("registerServiceApi(app, { services, store: serviceStore, terminals, wsGate: termGate });");
    const arm = at("armCodeRouteGate({ hook: codeRouteHook, sockets: termGate, agentExec: agentExec !== undefined });");
    expect(hook).toBeLessThan(firstRoute);
    expect(firstRoute).toBeLessThan(agents);
    expect(Math.max(agents, services)).toBeLessThan(arm);
    expect(src).toContain("agentExec: agentExec !== undefined,");
    expect(at("const termGate = chief ? terminalWsGate(")).toBeLessThan(agents);
  });
});
