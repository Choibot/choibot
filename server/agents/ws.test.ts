import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { parseResume, registerTerminalWs } from "./ws.js";
import type { AgentRecord } from "./store.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER } from "../chief/auth.js";
import { WS_PAIR_TEXT, terminalWsGate, type TerminalWsGate } from "../chief/wsgate.js";

describe("registerTerminalWs", () => {
  it("hands every web input to onInput before writing it to the PTY", async () => {
    const order: string[] = [];
    const terminals = {
      attach: () => ({ snapshot: "", epoch: "e", offset: 0, resumed: false, subscribe: () => () => {}, onEnd: () => () => {} }),
      reattach: async () => null,
      write: (id: string, d: string) => { order.push(`write:${id}:${d}`); },
      resize: () => {},
      redrawSoon: () => {},
    };
    const app = Fastify();
    await app.register(websocket);
    registerTerminalWs(app, terminals as any, { onInput: (id, d) => { order.push(`input:${id}:${d}`); } });
    await app.ready();
    const ws = await app.injectWS("/api/agents/fleet-master/terminal");
    ws.send(JSON.stringify({ t: "input", data: "hi\r" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.terminate();
    expect(order).toEqual(["input:fleet-master:hi\r", "write:fleet-master:hi\r"]);
    await app.close();
  });

  it("parses a resume point, ignoring anything malformed", () => {
    expect(parseResume({ epoch: "e1", since: "42" })).toEqual({ epoch: "e1", offset: 42 });
    expect(parseResume({})).toBeUndefined();
    expect(parseResume({ epoch: "e1" })).toBeUndefined();
    expect(parseResume({ epoch: "e1", since: "-1" })).toBeUndefined();
    expect(parseResume({ epoch: "e1", since: "1e3" })).toBeUndefined();
  });

  it("sends the sync frame first, then only the delta, and closes when the terminal ends", async () => {
    const asked: unknown[] = [];
    let end = () => {};
    const terminals = {
      attach: (_id: string, resume?: unknown) => {
        asked.push(resume);
        return { snapshot: "delta", epoch: "e1", offset: 7, resumed: true, subscribe: () => () => {}, onEnd: (cb: () => void) => { end = cb; return () => {}; } };
      },
      reattach: async () => null,
      write: () => {},
      resize: () => {},
      redrawSoon: () => {},
    };
    const app = Fastify();
    await app.register(websocket);
    registerTerminalWs(app, terminals as any);
    await app.ready();
    const frames: { text: string; binary: boolean }[] = [];
    let closed: number | null = null;
    const ws = await app.injectWS("/api/agents/a1/terminal?epoch=e1&since=7", {}, {
      onInit: (s: any) => {
        s.on("message", (d: Buffer, binary: boolean) => frames.push({ text: d.toString(), binary }));
        s.on("close", (code: number) => { closed = code; });
      },
    } as any);
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([{ epoch: "e1", offset: 7 }]);
    expect(frames[0].binary).toBe(true);
    expect(JSON.parse(frames[0].text)).toEqual({ t: "sync", epoch: "e1", offset: 7, resumed: true });
    expect(frames[1]).toEqual({ text: "delta", binary: false });
    end();
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(4000);
    ws.terminate();
    await app.close();
  });

  // reattach() builds the dtach socket path from the id; a non-agent id (a
  // decoded `x%2F..%2Fy`, or a service's `svc:<id>` terminal) never gets there.
  it("closes a socket for a malformed id without asking the terminals", async () => {
    const asked: string[] = [];
    const terminals = {
      attach: (id: string) => { asked.push(`attach:${id}`); return null; },
      reattach: async (id: string) => { asked.push(`reattach:${id}`); return null; },
      write: () => {}, resize: () => {},
    };
    const app = Fastify();
    await app.register(websocket);
    registerTerminalWs(app, terminals as any);
    await app.ready();
    for (const id of ["x%2F..%2Ffleet-master", "svc%3Aprice-pusher"]) {
      let closed: number | null = null;
      const ws = await app.injectWS(`/api/agents/${id}/terminal`, {}, {
        onInit: (s: any) => { s.on("close", (code: number) => { closed = code; }); },
      } as any);
      await new Promise((r) => setTimeout(r, 50));
      expect(closed, id).toBe(4000);
      ws.terminate();
    }
    expect(asked).toEqual([]);
    await app.close();
  });

  it("an agent with no terminal for a known reason: the words say the reason, not “resume it”", async () => {
    const terminals = { attach: () => null, reattach: async () => null, write: () => {}, resize: () => {} };
    const app = Fastify();
    await app.register(websocket);
    registerTerminalWs(app, terminals as any, { whyNone: async (id) => (id === "a1" ? "this agent waits" : null) });
    await app.ready();
    const said: Record<string, string[]> = { a1: [], a2: [] };
    for (const id of ["a1", "a2"]) {
      const ws = await app.injectWS(`/api/agents/${id}/terminal`, {}, {
        onInit: (s: any) => { s.on("message", (d: Buffer) => said[id].push(d.toString())); },
      } as any);
      await new Promise((r) => setTimeout(r, 50));
      ws.terminate();
    }
    expect(said.a1).toEqual(["\r\n[this agent waits]\r\n"]);
    expect(said.a2).toEqual(["\r\n[no live terminal for this agent — resume it]\r\n"]);
    await app.close();
  });
});

// Hardened deployment (Phase 2c, spec §3; Review Focus 3): the user token, as
// the first Sec-WebSocket-Protocol value, for EVERY agent id (a worker's too: the first real run
// showed any process of the server reading and typing into a worker's terminal).
describe("registerTerminalWs gate", () => {
  type Env = Record<string, string | undefined>;
  const ACTIVE: Env = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
  const HARD: Env = { ...ACTIVE, CHIEF_AGENT_UID: "1001" };
  const NOT_HARD: [string, Env][] = [["flag off", {}], ["no CHIEF_AGENT_UID", ACTIVE], ["invalid uid", { ...ACTIVE, CHIEF_AGENT_UID: "0" }]];
  const TOKEN = "u".repeat(43);
  const SHELL = "shell-0f8fad5b-d9cb-469f-a165-70867728950e";

  // A string kind: "lead" is a persistent kind the record type does not list yet.
  const rec = (id: string, kind?: string): AgentRecord => ({
    id, label: id, repo: "", worktree: "", branch: "", baseBranch: "", sessionId: null,
    hookToken: `tok-${id}`, status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
  });
  const RECORDS: Record<string, AgentRecord> = {
    "fleet-master": rec("fleet-master", "fleet-master"),
    "lead-1": rec("lead-1", "lead"),
    w1: rec("w1"),
    iss1: rec("iss1", "issue"),
  };
  const loads: string[] = [];
  const agents = { load: async (id: string) => { loads.push(id); return RECORDS[id] ?? null; } };
  const devices = { verify: async (t: string) => (t === TOKEN ? { label: "phone", createdAt: 0, lastUsedAt: 0 } : null) };

  let app: FastifyInstance;
  let calls: string[];
  let redraws: string[];
  afterEach(async () => { await app.close(); });

  // slowReattach: nothing is live in this process; reattach() takes that long (the helper's
  // alive and kill-clients calls under sudo), then gives the terminal.
  async function build(gate: TerminalWsGate | undefined, slowReattach?: number): Promise<void> {
    calls = [];
    redraws = [];
    loads.length = 0;
    const att = () => ({ snapshot: "SNAP", epoch: "e", offset: 0, resumed: false, subscribe: () => () => {}, onEnd: () => () => {} });
    const terminals = {
      attach: (id: string) => {
        calls.push(`attach:${id}`);
        return slowReattach === undefined ? att() : null;
      },
      reattach: async (id: string) => {
        calls.push(`reattach:${id}`);
        if (slowReattach === undefined) return null;
        await new Promise((r) => setTimeout(r, slowReattach));
        calls.push(`reattached:${id}`);
        return att();
      },
      write: (id: string, d: string) => { calls.push(`write:${id}:${d}`); },
      resize: (id: string, cols: number, rows: number) => { calls.push(`resize:${id}:${cols}x${rows}`); },
      redrawSoon: (id: string) => { redraws.push(id); },
    };
    app = Fastify();
    await app.register(websocket);
    registerTerminalWs(app, terminals as any, { onInput: (id) => { calls.push(`onInput:${id}`); }, gate });
    await app.ready();
  }

  // Sends one input frame as soon as the socket is open (first: the size, as the browser's
  // XtermTerminal does on open, when `resize`), or the frames of `send`.
  async function open(id: string, headers: Record<string, string> = {}, o: { resize?: boolean; waitMs?: number; send?: string[] } = {}) {
    const out = { text: [] as string[], closed: null as number | null };
    const ws = await app.injectWS(`/api/agents/${id}/terminal`, { headers } as any, {
      onInit: (s: any) => {
        s.on("message", (d: Buffer, binary: boolean) => { if (!binary) out.text.push(d.toString()); });
        s.on("close", (code: number) => { out.closed = code; });
      },
      onOpen: (s: any) => {
        if (o.send) { for (const f of o.send) s.send(f); return; }
        if (o.resize) s.send(JSON.stringify({ t: "resize", cols: 157, rows: 41 }));
        s.send(JSON.stringify({ t: "input", data: "hi\r" }));
      },
    } as any);
    await new Promise((r) => setTimeout(r, o.waitMs ?? 50));
    ws.terminate();
    return out;
  }
  const hard = () => terminalWsGate({ devices, agents, env: HARD });
  const proto = (v: string) => ({ "sec-websocket-protocol": v });
  const refused = { text: [WS_PAIR_TEXT], closed: 4000 };

  it.each(["fleet-master", "lead-1"])("%s without a token → the reason line, a final close, no attach, no input", async (id) => {
    await build(hard());
    expect(await open(id)).toEqual(refused);
    expect(calls).toEqual([]);
  });

  it("the fleet master with an unknown token, or the token with agent headers → refused", async () => {
    await build(hard());
    expect(await open("fleet-master", proto("nope"))).toEqual(refused);
    expect(await open("fleet-master", { ...proto(TOKEN), [AGENT_HEADER]: "w1", [AGENT_TOKEN_HEADER]: "tok-w1" })).toEqual(refused);
    expect(calls).toEqual([]);
  });

  it("the fleet master with the user token → attached, input reaches the PTY", async () => {
    await build(hard());
    const r = await open("fleet-master", proto(TOKEN));
    expect(r).toEqual({ text: ["SNAP"], closed: null });
    expect(calls).toEqual(["attach:fleet-master", "onInput:fleet-master", "write:fleet-master:hi\r"]);
  });

  // The token check is async: an input sent at once waits for it.
  it("a worker id with the user token → the input sent at once still reaches the PTY", async () => {
    await build(hard());
    expect(await open("w1", proto(TOKEN))).toEqual({ text: ["SNAP"], closed: null });
    expect(calls).toEqual(["attach:w1", "onInput:w1", "write:w1:hi\r"]);
  });

  it.each(["w1", "iss1"])("a worker id (%s) without a token → refused, nothing attached", async (id) => {
    await build(hard());
    expect(await open(id)).toEqual(refused);
    expect(calls).toEqual([]);
  });

  // A shell id passes isAgentId and would attach a console-uid shell; it has
  // no agent record. Neither has a record that does not load (a half-written
  // master's, ruling 2c-3-c) or an id that is gone.
  it.each([SHELL, "gone-1"])("an id without an agent record (%s) without a token → refused", async (id) => {
    await build(hard());
    expect(await open(id)).toEqual(refused);
    expect(calls).toEqual([]);
  });

  it("a shell id with the user token → attached", async () => {
    await build(hard());
    expect(await open(SHELL, proto(TOKEN))).toEqual({ text: ["SNAP"], closed: null });
    expect(calls[0]).toBe(`attach:${SHELL}`);
  });

  // svc: ids are not agent ids (decision 47): never loaded, the token first,
  // then today's "no live terminal" close.
  it("a svc: id → the token first, never a record load; with it today's close", async () => {
    await build(hard());
    expect(await open("svc%3Aprice-pusher")).toEqual(refused);
    expect(await open("svc%3Aprice-pusher", proto(TOKEN))).toEqual({
      text: ["\r\n[no live terminal for this agent — resume it]\r\n"], closed: 4000,
    });
    expect(loads).toEqual([]);
    expect(calls).toEqual([]);
  });

  // Nothing live here after a console restart: the route awaits reattach() (through the helper,
  // two sudo calls). The size the browser sends at open comes during that wait; it must reach the
  // PTY after it (a lost size left Claude unredrawn: an empty tab). Keys typed during the wait are
  // dropped, as on main: typed blind, they could answer a dialog of the agent.
  it("a slow reattach with the user token → the size sent at open reaches the PTY after it; early keys are dropped", async () => {
    await build(hard(), 150);
    expect(await open("w1", proto(TOKEN), { resize: true, waitMs: 400 })).toEqual({ text: ["SNAP"], closed: null });
    expect(calls).toEqual(["attach:w1", "reattach:w1", "reattached:w1", "resize:w1:157x41"]);
    expect(redraws).toEqual(["w1"]);
  });

  it("a slow reattach, not hardened → the same", async () => {
    await build(undefined, 150);
    expect(await open("w1", {}, { resize: true, waitMs: 400 })).toEqual({ text: ["SNAP"], closed: null });
    expect(calls).toEqual(["attach:w1", "reattach:w1", "reattached:w1", "resize:w1:157x41"]);
  });

  it("a slow reattach → of the sizes sent during the wait, only the last reaches the PTY", async () => {
    await build(hard(), 150);
    const size = (cols: number) => JSON.stringify({ t: "resize", cols, rows: 41 });
    await open("w1", proto(TOKEN), { waitMs: 400, send: [size(100), JSON.stringify({ t: "input", data: "y" }), size(157)] });
    expect(calls).toEqual(["attach:w1", "reattach:w1", "reattached:w1", "resize:w1:157x41"]);
  });

  // The byte limit: during the wait the route reads only small frames (a size frame is ~40 bytes).
  it("a slow reattach → a frame over 256 bytes during the wait is not parsed and not kept", async () => {
    await build(hard(), 150);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const big = JSON.stringify({ t: "resize", cols: 99, rows: 41, pad: "BIG-FRAME".repeat(40) });
      expect(big.length).toBeGreaterThan(256);
      await open("w1", proto(TOKEN), { waitMs: 400, send: [big] });
      expect(parse.mock.calls.filter(([t]) => String(t).includes("BIG-FRAME"))).toEqual([]);
    } finally { parse.mockRestore(); }
    expect(calls).toEqual(["attach:w1", "reattach:w1", "reattached:w1"]);
  });

  // A refused socket still emits the frames that come while it closes: the route puts no listener
  // on it, so nothing is kept and nothing is parsed (main read none of them either).
  it("a refused socket → no listener of the route, no frame parsed", async () => {
    const gate = hard()!;
    let server: any = null;
    let before = -1;
    await build({ ...gate, agent: (s, req, id) => { server = s; before = s.listenerCount("message"); return gate.agent(s, req, id); } });
    const parse = vi.spyOn(JSON, "parse");
    try {
      const frame = JSON.stringify({ t: "resize", cols: 157, rows: 41, mark: "REFUSED-FRAME" });
      expect(await open("w1", {}, { send: Array(20).fill(frame), waitMs: 100 })).toEqual(refused);
      expect(parse.mock.calls.filter(([t]) => String(t).includes("REFUSED-FRAME"))).toEqual([]);
    } finally { parse.mockRestore(); }
    expect(server.listenerCount("message")).toBe(before);
    expect(calls).toEqual([]);
  });

  it.each(NOT_HARD)("not hardened (%s): every id as today, no record load", async (_n, env) => {
    await build(terminalWsGate({ devices, agents, env }));
    expect(await open("fleet-master")).toEqual({ text: ["SNAP"], closed: null });
    expect(await open(SHELL)).toEqual({ text: ["SNAP"], closed: null });
    expect(calls).toEqual([
      "attach:fleet-master", "onInput:fleet-master", "write:fleet-master:hi\r",
      `attach:${SHELL}`, `onInput:${SHELL}`, `write:${SHELL}:hi\r`,
    ]);
    expect(loads).toEqual([]);
  });
});
