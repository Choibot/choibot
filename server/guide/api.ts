// server/guide/api.ts — the guide for the browser.
//   GET  /api/guide           the thread of the guide, and if the guide can answer now
//   POST /api/guide/sync      the page is open, or the list changed: the guide says what is new
//   POST /api/guide/message   the user wrote ({ text })
//   POST /api/guide/stopped   the chat box stopped a secret ({ secret: its kind, never the text })
// Every route is for the paired user only (gateUser), the reads too: an agent, a lead and the
// fleet master are refused. No route here runs an action of a step: a card of the thread is a
// line of data, and the form or the button on it calls the routes of setup/actions.ts.
//
// The guide exists on a new install only (guideOn). On an install with the old names no route
// of this file is there, no Guide is made and no model starts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { join } from "node:path";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { NEEDS_PAIRING } from "../setup/actions.js";
import type { Guide } from "./guide.js";
import { stoppedLine } from "./secret.js";

// A new install with device pairing: the guide has a user to talk with.
export const guideOn = (o: { newInstall: boolean; gate: unknown }): boolean => o.newInstall && !!o.gate;

// Where the guide keeps its thread, in the data folder of the console.
export const guideDir = (appDataDir: string): string => join(appDataDir, "guide");

export function registerGuideApi(app: FastifyInstance, d: { gate?: ChiefGate; guide: Guide }): void {
  const user = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!d.gate) { reply.code(403).send(NEEDS_PAIRING); return false; }
    return (await gateUser(d.gate, req, reply)) !== null;
  };

  app.get("/api/guide", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return d.guide.view();
  });

  app.post("/api/guide/sync", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    return d.guide.sync();
  });

  // The chat box found a secret and sent nothing of it. The thread gets the line that says so.
  app.post("/api/guide/stopped", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    if (!(await d.guide.stopped((req.body as { secret?: unknown } | null)?.secret))) return reply.code(400).send({ error: "This kind of secret is not known." });
    return d.guide.view();
  });

  app.post("/api/guide/message", async (req, reply) => {
    if (!(await user(req, reply))) return reply;
    const r = await d.guide.say((req.body as { text?: unknown } | null)?.text);
    if (r.ok) return reply.code(202).send(await d.guide.view());
    switch (r.why) {
      // The answer names the kind of the secret and where it belongs. It never repeats the text.
      case "secret": return reply.code(422).send({ error: stoppedLine(r.hit), secret: r.hit.kind, ...(r.hit.step ? { step: r.hit.step } : {}) });
      case "busy": return reply.code(409).send({ error: "The guide writes now. Wait a moment." });
      case "off": return reply.code(503).send({ error: r.off.text, off: r.off });
      case "long": return reply.code(400).send({ error: "This message is too long. Write a shorter one." });
      default: return reply.code(400).send({ error: "Write a message first." });
    }
  });
}
