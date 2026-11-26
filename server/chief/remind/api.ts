// server/chief/remind/api.ts — the /api/reminders routes. Registered only
// with CHIEF_ENABLED=1 (flag off: 404, as every chief route); every route
// answers 503 while misconfigured. Levels (headers are mistake guards, §3):
//   GET  /api/reminders[?status=open|all]  any session; an agent sees its
//                                         own, a lead its own and its
//                                         workers', master, user and the UI all
//   POST /api/reminders                    AGENT for itself, LEAD for itself
//                                         and agents with spawnedBy = it,
//                                         MASTER for any agent
//   POST /api/reminders/:id/cancel         the same, or USER for any
// The text is agent-written: it is stored and typed back as the agent's own
// note, never as a user order.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRecord, SessionStore } from "../../agents/store.js";
import { isAgentId } from "../../ids.js";
import type { Caller } from "../auth.js";
import { gateRoute, pairRequired, type ChiefGate } from "../gate.js";
import { MAX_OPEN_PER_AGENT, parseReminderInput, REMINDER_ID_RE } from "./schema.js";
import { isOpenReminder, type Reminder, type ReminderStore } from "./store.js";

export type RemindApiDeps = {
  gate: ChiefGate; store: ReminderStore; agents: Pick<SessionStore, "load">;
  now?: () => number; log?: (s: string) => void;
};

const ERR = {
  agentsOnly: "agents only", notFound: "not found", noAgent: "no such agent", internal: "internal error",
  notYours: "you may manage reminders only for yourself (a lead: and the agents it spawned)",
  closed: "the agent is closed", badAgent: "agentId must be an agent id",
  tooMany: `at most ${MAX_OPEN_PER_AGENT} open reminders per agent`, delivering: "being delivered; try again in a few minutes",
  invalidQuery: "invalid query",
} as const;

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// May `caller` set or cancel reminders whose target is `target` (its record,
// null when deleted)? USER is decided by each route.
export function mayManage(caller: Caller, target: string, rec: Pick<AgentRecord, "spawnedBy"> | null): boolean {
  if (caller.level === "master") return true;
  if (caller.level === "lead") return target === caller.agentId || rec?.spawnedBy === caller.agentId;
  if (caller.level === "agent") return target === caller.agentId;
  return false;
}

export function registerRemindApi(app: FastifyInstance, d: RemindApiDeps): void {
  const { gate, store, agents } = d;
  const now = d.now ?? Date.now;
  const log = d.log ?? ((s: string) => console.warn(s));

  // Any error answers a fixed 500 (no message, no stack) and is logged.
  const guard = (fn: Handler): Handler => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      log(`[chief] reminders ${req.method} ${req.routeOptions.url} failed: ${errText(e)}`);
      return reply.code(500).send({ error: ERR.internal });
    }
  };

  app.get("/api/reminders", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const status = (req.query as { status?: unknown }).status ?? "open";
    if (status !== "open" && status !== "all") return reply.code(400).send({ error: ERR.invalidQuery });
    const caller = await gate.caller(req);
    let list = await store.list();
    if (status === "open") list = list.filter(isOpenReminder);
    if (caller.level === "lead" || caller.level === "agent") {
      const recs = new Map<string, AgentRecord | null>();
      for (const id of new Set(list.map((r) => r.agentId))) recs.set(id, await agents.load(id));
      list = list.filter((r) => mayManage(caller, r.agentId, recs.get(r.agentId) ?? null));
    }
    return { reminders: list, serverNow: now() };
  }));

  app.post("/api/reminders", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const caller = await gate.caller(req);
    if (caller.level !== "agent" && caller.level !== "lead" && caller.level !== "master") return reply.code(403).send({ error: ERR.agentsOnly });
    if (caller.agentId === undefined) return reply.code(403).send({ error: ERR.agentsOnly });
    const body = (req.body ?? {}) as { agentId?: unknown };
    const target = body.agentId ?? caller.agentId;
    if (!isAgentId(target)) return reply.code(400).send({ error: ERR.badAgent });
    const rec = await agents.load(target);
    if (!mayManage(caller, target, rec)) return reply.code(403).send({ error: ERR.notYours });
    if (!rec) return reply.code(404).send({ error: ERR.noAgent });
    if (rec.closedAt !== undefined) return reply.code(409).send({ error: ERR.closed });
    const v = parseReminderInput(req.body, now());
    if (!v.ok) return reply.code(400).send({ error: v.error });
    const r = await store.add({ agentId: target, agentLabel: rec.label ?? target, setBy: caller.agentId, ...v.value });
    if (!r.ok) return reply.code(409).send({ error: ERR.tooMany });
    return { id: r.reminder.id, dueAt: r.reminder.dueAt };
  }));

  app.post("/api/reminders/:id/cancel", guard(async (req, reply) => {
    if (!gateRoute(gate, reply)) return reply;
    const id = (req.params as { id: string }).id;
    const caller = await gate.caller(req);
    if (caller.level === "none") return pairRequired(gate, reply);
    const cur = REMINDER_ID_RE.test(id) ? await store.get(id) : null;
    if (!cur) return reply.code(404).send({ error: ERR.notFound });
    if (caller.level !== "user" && !mayManage(caller, cur.agentId, await agents.load(cur.agentId))) {
      return reply.code(403).send({ error: ERR.notYours });
    }
    const by = caller.level === "user" ? "user" : caller.agentId!;
    // Only an open reminder; the state is checked again under the store lock.
    let seen: Reminder = cur;
    const next = await store.update(id, (r) => {
      seen = r;
      return r.state === "open" ? { ...r, state: "cancelled", cancelledAt: now(), cancelledBy: by } : null;
    });
    if (next) return next;
    return reply.code(409).send({ error: seen.state === "delivering" ? ERR.delivering : `already ${seen.state}` });
  }));
}
