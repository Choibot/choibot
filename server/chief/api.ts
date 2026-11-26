// server/chief/api.ts — the chief of staff's pairing routes (spec §3.1 steps 2
// and 5, §7). Registered only when CHIEF_ENABLED=1 (server/index.ts). Neither
// route looks up a caller: start is open to a headerless request in log mode
// (the agent-header refusal is a mistake guard, §3), and claim is "any session,
// single use".
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TelegramClient } from "../issues/telegram.js";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, DEVICE_LABEL_RE, type DeviceStore, type PairingCodes } from "./auth.js";
import { gateRoute, type ChiefGate } from "./gate.js";

export const CHIEF_API_ERR = { agentHeaders: "agent headers are not allowed", pairGone: "pairing code expired or used" } as const;

export type ChiefApiDeps = {
  gate: ChiefGate;
  pairing: PairingCodes;
  devices: Pick<DeviceStore, "add">;
  consoleUrl: string;
  tg?: Pick<TelegramClient, "deleteMessage">;
  log?: (s: string) => void;
};

const startBody = z.object({ label: z.string().regex(DEVICE_LABEL_RE) });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function registerChiefApi(app: FastifyInstance, d: ChiefApiDeps): void {
  const log = d.log ?? ((s) => console.warn(s));

  // Log mode only (§3.1 step 5): the link goes to the server log once and back
  // to the caller (`choibot brain pair`). Telegram mode starts pairings from /pair.
  app.post("/api/chief/pair/start", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    if (d.gate.userAuth !== "log") return reply.code(404).send({ error: "not found" });
    // Key presence, as in callerOf: either agent header marks an agent's request.
    if (Object.hasOwn(req.headers, AGENT_HEADER) || Object.hasOwn(req.headers, AGENT_TOKEN_HEADER)) {
      return reply.code(403).send({ error: CHIEF_API_ERR.agentHeaders });
    }
    const body = startBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid label" });
    const { label } = body.data;
    const { code, expiresAt } = d.pairing.mint(label);
    const url = `${d.consoleUrl}/#pair=${code}`;
    log(`[chief] pairing link for ${label}: ${url}`);
    return reply.code(200).send({ url, expiresAt });
  });

  // §3.1 step 2: the [Pair] tap. Unknown, used and expired codes are all 410
  // (decision 10); a body without a string code is an unknown code. The
  // private message that held a /pair link is deleted without waiting: a
  // Telegram failure or stall must never cost the browser its token (the code
  // is already spent, so a retry could not get it back).
  app.post("/api/chief/pair/claim", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!gateRoute(d.gate, reply)) return reply;
    const code = (req.body as { code?: unknown } | null | undefined)?.code;
    const pending = typeof code === "string" ? d.pairing.claim(code) : null;
    if (!pending) return reply.code(410).send({ error: CHIEF_API_ERR.pairGone });
    const token = await d.devices.add(pending.label);
    if (pending.tg && d.tg) {
      const { chatId, messageId } = pending.tg;
      d.tg.deleteMessage(chatId, messageId)
        .catch((e) => { log(`[chief] pairing deleteMessage failed: ${errText(e)}`); });
    }
    return reply.code(200).send({ token, label: pending.label });
  });
}
