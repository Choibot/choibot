// server/master/api.ts — Master tab backend.
import type { FastifyInstance } from "fastify";

export type MasterStatus = {
  queuedEvents: number; queuedMessages: number; telegram: boolean; surface: "tab" | "telegram";
  // True with the quiet policy on (master/quiet.ts); absent otherwise.
  quiet?: boolean;
  // True when the Coordinator reads the events (server/coordinator): the master gets no digest
  // and queuedEvents is 0. Absent otherwise.
  coordinator?: boolean;
  // True while the master waits for the second sign-in (chief/chiefwait.ts): no session yet.
  waits?: boolean;
  // True when that wait is for a Claude login that was signed out on the page (agents/loginhold.ts),
  // not for the second sign-in.
  waitsLogin?: boolean;
};

export const KEPT_TEXT = "Kept: the fleet master gets it when it starts.";
export const NOT_WAITING_TEXT = "The fleet master runs: write in its pane.";

export function registerMasterApi(
  app: FastifyInstance,
  deps: { ensure: () => Promise<string>; status: () => MasterStatus; waits?: () => boolean; waitsLogin?: () => boolean; keep?: (text: string) => void },
): void {
  app.post("/api/master", async () => ({ id: await deps.ensure() }));
  app.get("/api/master/status", async () => ({ ...deps.status(), ...(deps.waits?.() ? { waits: true, ...(deps.waitsLogin?.() ? { waitsLogin: true } : {}) } : {}) }));
  // A message of the Master tab while the master WAITS for the second sign-in: kept in its
  // inbox (no time limit) and delivered after its start. The answer says so in one line.
  app.post("/api/master/message", async (req, reply) => {
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text: a non-empty string" });
    if (text.length > 20_000) return reply.code(400).send({ error: "text: at most 20000 characters" });
    if (!deps.waits?.() || !deps.keep) return reply.code(409).send({ error: NOT_WAITING_TEXT });
    deps.keep(text.trim());
    return { kept: true, text: KEPT_TEXT };
  });
}
