// server/chief/deploy/api.ts — the deploy routes (spec §5.7, §7).
//   GET  /api/deploy   any session: whether deploy is on here, the live and the main commit
//   POST /api/deploy   USER only: start the deploy of the console's own checkout
// POST is the strongest user-only gate there is (gateUser): the request itself must carry a
// paired device's token. A loopback request, the cookie session, an agent's hook token, the
// fleet master's and a lead's token all get 403 pair-required (a request with agent headers is
// never USER, callerOf). The body is never read: nothing in a request can name a repo, a branch,
// a commit or a command.
import type { FastifyInstance } from "fastify";
import { gateRoute, gateUser, type ChiefGate } from "../gate.js";
import type { DeployService } from "./service.js";

export type DeployApiDeps = { gate: ChiefGate; deploy: Pick<DeployService, "start" | "statusNow">; log?: (s: string) => void };

export function registerDeployApi(app: FastifyInstance, d: DeployApiDeps): void {
  const log = d.log ?? ((s: string) => console.warn(s));

  app.get("/api/deploy", async (_req, reply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    try {
      return await d.deploy.statusNow();
    } catch (e) {
      log(`[deploy] GET /api/deploy failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply.code(500).send({ error: "internal error" });
    }
  });

  app.post("/api/deploy", async (req, reply) => {
    const caller = await gateUser(d.gate, req, reply);
    if (!caller) return reply;
    try {
      const r = await d.deploy.start("tab");
      if (r.code === 200) {
        log(`[deploy] started from the tab by device ${caller.device ?? "?"}`);
        return r.item;
      }
      return reply.code(r.code).send({ error: r.error, ...(r.item ? { item: r.item } : {}) });
    } catch (e) {
      log(`[deploy] POST /api/deploy failed: ${e instanceof Error ? e.message : String(e)}`);
      return reply.code(500).send({ error: "internal error" });
    }
  });
}
