// server/coordinator/gate.ts — what the Coordinator may ask of the console. Fail closed: a
// request that names the Coordinator in its agent header (authenticated or not) gets the read
// routes and the three writes below, and nothing else. So a route that takes "any agent" or
// "any request" today (spawn, stop, resume, delete, a cron spool write, …) never takes the
// Coordinator, and a new route is refused until it is added here on purpose. The allowed
// routes still check the caller themselves (the token, the level, the item's owner).
// As every agent header, this is a mistake guard on a host that is not hardened (spec §3).
import type { FastifyInstance } from "fastify";
import { AGENT_HEADER } from "../chief/auth.js";
import { COORDINATOR_ID } from "./paths.js";

// Its writes: a new ticket, a recommendation, the withdrawal of its own ticket, and the link of
// a ticket to the run of a recurring task that it read (`cron note`; it changes nothing of the
// task or of the run itself).
export const COORDINATOR_WRITES: ReadonlySet<string> = new Set([
  "POST /api/queue",
  "POST /api/queue/:id/recommend",
  "POST /api/queue/:id/withdraw",
  "POST /api/cron/jobs/:name/note",
]);

export const COORDINATOR_REFUSAL = "not a Coordinator action: it reads, adds a ticket, recommends on a ticket and links a ticket to a run";

const READS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function coordinatorMay(method: string, route: string | undefined): boolean {
  return READS.has(method) || (route !== undefined && COORDINATOR_WRITES.has(`${method} ${route}`));
}

export function registerCoordinatorGate(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers[AGENT_HEADER] !== COORDINATOR_ID) return undefined;
    if (coordinatorMay(req.method, req.routeOptions.url)) return undefined;
    return reply.code(403).send({ error: COORDINATOR_REFUSAL });
  });
}
