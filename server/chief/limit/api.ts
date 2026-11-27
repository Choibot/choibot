// server/chief/limit/api.ts — POST /api/queue/:id/limit: a press of a button of the usage-limit
// ticket in the Queue view. The user only (gateUser: an agent gets "pair required"). The service
// checks the ticket, the row and the login again at press time (limit/service.ts).
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isAccountId } from "../../agents/accounts.js";
import { gateUser, type ChiefGate } from "../gate.js";
import { ITEM_ID_RE } from "../queue/store.js";
import type { LimitTicket } from "./service.js";
import { LIMIT_ALL, LIMIT_TAG_RE } from "./ticket.js";

export type LimitApiDeps = { gate: ChiefGate; limit: Pick<LimitTicket, "press">; log?: (s: string) => void };

const Press = z.object({
  row: z.union([z.literal(LIMIT_ALL), z.string().regex(LIMIT_TAG_RE)]),
  act: z.enum(["move", "continue"]),
  to: z.string().refine(isAccountId).optional(),
}).strict();

export function registerLimitApi(app: FastifyInstance, d: LimitApiDeps): void {
  const log = d.log ?? ((s: string) => console.warn(s));

  app.post("/api/queue/:id/limit", async (req, reply) => {
    const caller = await gateUser(d.gate, req, reply);
    if (!caller) return reply;
    const { id } = req.params as { id: string };
    if (!ITEM_ID_RE.test(id)) return reply.code(404).send({ error: "not found" });
    const body = Press.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "a press is { row: <tag> | \"all\", act: \"move\" | \"continue\", to?: <login> }" });
    try {
      const r = await d.limit.press(id, body.data);
      if (r.code === 200) return { item: r.item, text: r.text };
      return reply.code(r.code).send({ error: r.error, reason: "limit" });
    } catch (e) {
      log(`[limit] POST /api/queue/${id}/limit failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply.code(500).send({ error: "internal error" });
    }
  });
}
