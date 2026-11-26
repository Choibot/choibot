// server/chief/gate.ts — the one way a gated route answers (spec §4.4, §7, plan
// decision 12). Each helper sends the refusal itself and returns a falsy value;
// the route then returns `reply` unchanged:
//   if (!gateRoute(gate, reply)) return reply;
//   const caller = await gateUser(gate, req, reply); if (!caller) return reply;
//   if (!(await gateMerge(gate, req, reply))) return reply;
// Misconfigured mode answers 503 before any caller lookup.
import type { FastifyReply, FastifyRequest } from "fastify";
import { callerOf, type Caller, type CallerDeps } from "./auth.js";

export const CHIEF_ERR = { pairRequired: "pair-required", misconfigured: "chief-misconfigured", mergeUserOnly: "merge is a user action" } as const;

// With strong protection all agents run as one Linux account, so an agent can read the fleet
// master's token (deploy/RUNBOOK.md, "Known limit"). There a merge and an auto answer are for the
// user alone: the master's list (access.ts) and these gates both refuse them.
export const USER_ALONE_ERR = {
  merge: "with strong protection only the user merges: use the Merge button of the Queue",
  auto: "with strong protection only the user answers a ticket: recommend an answer instead (queue recommend)",
} as const;

// strong: strong protection is on (hardenedDeployment; boot.ts sets it).
export type ChiefGate = { misconfigured: string | null; userAuth: "telegram" | "log"; strong?: boolean; caller(req: FastifyRequest): Promise<Caller> };

export function makeGate(o: { misconfigured: string | null; userAuth: "telegram" | "log"; strong?: boolean; deps: CallerDeps }): ChiefGate {
  return {
    misconfigured: o.misconfigured,
    userAuth: o.userAuth,
    strong: o.strong === true,
    caller: (req) => callerOf(req.headers, o.deps),
  };
}

// false after a 503.
export function gateRoute(gate: ChiefGate, reply: FastifyReply): boolean {
  if (gate.misconfigured === null) return true;
  reply.code(503).send({ error: CHIEF_ERR.misconfigured });
  return false;
}

// The one 403 pair-required reply (spec §7): the client turns it into the
// pairing state, worded for the mode.
export function pairRequired(gate: ChiefGate, reply: FastifyReply): FastifyReply {
  return reply.code(403).send({ error: CHIEF_ERR.pairRequired, userAuth: gate.userAuth });
}

// USER routes: every non-USER caller gets pair-required, agent headers
// included (decision 12).
export async function gateUser(gate: ChiefGate, req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
  if (!gateRoute(gate, reply)) return null;
  const caller = await gate.caller(req);
  if (caller.level === "user") return caller;
  pairRequired(gate, reply);
  return null;
}

// The two merge routes: USER or an authenticated fleet master (with strong
// protection: USER only). Any other request with agent headers (other kinds, a
// token that does not match) is told merge is a user action; a request without
// them must pair.
export async function gateMerge(gate: ChiefGate, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!gateRoute(gate, reply)) return false;
  const caller = await gate.caller(req);
  if (caller.level === "user") return true;
  if (caller.kind === "fleet-master" && gate.strong) { reply.code(403).send({ error: USER_ALONE_ERR.merge }); return false; }
  if (caller.kind === "fleet-master") return true;
  if (caller.agentHeaders) reply.code(403).send({ error: CHIEF_ERR.mergeUserOnly });
  else pairRequired(gate, reply);
  return false;
}
