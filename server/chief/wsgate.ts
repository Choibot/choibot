// server/chief/wsgate.ts — the socket half of the code-route gate (spec §3,
// Phase 2c). A browser WebSocket cannot carry a header, so in a hardened
// deployment (ruling P4) the terminal sockets that reach a service PTY or a
// persistent agent take the user token as their first
// Sec-WebSocket-Protocol value. Not hardened: terminalWsGate is undefined and
// every terminal route runs today's code. The token is never logged.
import type { WebSocket } from "@fastify/websocket";
import type { FastifyRequest } from "fastify";
import type { SessionStore } from "../agents/store.js";
import { WS_CLOSE_FINAL } from "../wsKeepalive.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, type DeviceStore } from "./auth.js";
import { hardenedDeployment, setCodeRouteGate } from "./hardened.js";

type Env = Record<string, string | undefined>;

export const WS_PAIR_TEXT = "\r\n[pair this device to use this terminal]\r\n";

// The websocket plugin's handleProtocols, in every mode (ruling P7): a browser
// fails the handshake when the server does not echo a subprotocol it offered,
// so a stored token must never break a terminal. ws calls this only when the
// client offered one: none offered → no Sec-WebSocket-Protocol header, as today.
export function echoFirstProtocol(protocols: Set<string>): string | false {
  const [first] = protocols;
  return first ?? false;
}

// The first Sec-WebSocket-Protocol value, checked as a user token by `verify`
// (the device store check behind callerOf). As in callerOf, a request with an
// agent header is never the user. Absent, unknown or a verifier error → false.
export async function wsUserOk(req: FastifyRequest, verify: (token: string) => Promise<boolean>): Promise<boolean> {
  const h = req.headers;
  if (Object.hasOwn(h, AGENT_HEADER) || Object.hasOwn(h, AGENT_TOKEN_HEADER)) return false;
  const raw = h["sec-websocket-protocol"];
  if (typeof raw !== "string") return false;
  const token = raw.split(",")[0].trim();
  if (!token) return false;
  try {
    return await verify(token);
  } catch {
    return false;
  }
}

// Each check runs first in its route's handler. true: go on with today's code.
// false: the refusal is sent and the socket closed; the route returns at once,
// before ensureLive, any attach or any input handler.
export type TerminalWsGate = {
  // /api/services/:id/terminal: always.
  user(socket: WebSocket, req: FastifyRequest): Promise<boolean>;
  // /api/agents/:id/terminal: always (every agent: a worker's terminal is its screen and its
  // keyboard, and every process of the server can open the socket).
  agent(socket: WebSocket, req: FastifyRequest, id: string): Promise<boolean>;
};

// The socket is paused while a check runs: a frame the client sends right
// after the handshake (its first resize, a keypress) waits for the route's
// handler instead of reaching a socket with no listener. It flows again on a
// later tick, after a handler installed in the same turn as the return.
async function held(socket: WebSocket, ok: () => Promise<boolean>): Promise<boolean> {
  socket.pause();
  let pass = false;
  try {
    pass = await ok();
  } catch {
    pass = false;
  }
  if (!pass) {
    socket.send(WS_PAIR_TEXT);
    socket.close(WS_CLOSE_FINAL);
  }
  // Also after a refusal: the client's close frame must be read for the
  // close handshake to end (no listener takes any other frame).
  socket.resume();
  return pass;
}

export function terminalWsGate(d: {
  // `agents` is no longer read (every agent's terminal needs the token); kept for the callers.
  devices: Pick<DeviceStore, "verify">; agents: Pick<SessionStore, "load">; env?: Env;
}): TerminalWsGate | undefined {
  if (!hardenedDeployment(d.env ?? process.env)) return undefined;
  const verify = async (token: string) => (await d.devices.verify(token)) !== null;
  return {
    user: (socket, req) => held(socket, () => wsUserOk(req, verify)),
    // Before, a worker's terminal went without the token; the first real run showed any process
    // of the server reading and typing into it. Now every agent's terminal is the user's.
    agent: (socket, req) => held(socket, () => wsUserOk(req, verify)),
  };
}

// Check (4) of chiefHardened (spec §3): the code-route gate counts as active
// only once both halves are registered, the preHandler hook
// (registerCodeRouteGate) and these socket checks on the three terminal
// routes, and the agent exec helper's probe passed (agentExec set, ruling
// F3). index.ts calls this after the last terminal route; with anything
// missing the flag stays false.
export function armCodeRouteGate(d: { hook: boolean; sockets: TerminalWsGate | undefined; agentExec: boolean }): boolean {
  const on = d.hook && d.sockets !== undefined && d.agentExec;
  if (on) setCodeRouteGate(true);
  return on;
}
