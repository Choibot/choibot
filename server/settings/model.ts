// server/settings/model.ts — Settings > Model: the model of an agent that has none of its own
// (agents/model.ts). The owner asked for it as a setting (2026-11-26).
//   GET  /api/settings/model   any session: { model, set, wrong, choices, canSave, why }
//   POST /api/settings/model   USER (gateUser): { model: "fable" | "opus" | "sonnet" | "haiku" }.
//                              AGENT_MODEL is written through the one .env writer (envfile.ts) and
//                              used at once: the next start or resume of an agent reads it.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isAgentModel, MODEL_REFUSAL, MODEL_SETTING_KEY, settingModel } from "../agents/model.js";
import { gateUser, type ChiefGate } from "../chief/gate.js";
import { envFileWritable, envWriteBusy, EnvWriteError, writeEnvFile } from "./envfile.js";
import { NEEDS_CHIEF } from "./api.js";

export type ModelSettingsDeps = {
  envFile?: string;
  gate?: ChiefGate;
  // The env the agents' starts read (process.env in production): a save changes it in place.
  env?: Record<string, string | undefined>;
  log?: (s: string) => void;
};

const saveBody = z.object({ model: z.string().max(40) }).strict();

// The boot line for a value that is not a model: the console then uses the default.
export function wrongModelLine(env: Record<string, string | undefined> = process.env): string | null {
  const { wrong } = settingModel(env);
  return wrong === null ? null
    : `[settings] ${MODEL_SETTING_KEY}=${JSON.stringify(wrong.slice(0, 40))} is not a model (${AGENT_MODELS.join(", ")}): agents start on ${DEFAULT_AGENT_MODEL}`;
}

export function registerModelSettings(app: FastifyInstance, d: ModelSettingsDeps): void {
  const env = d.env ?? process.env;
  const log = d.log ?? ((s: string) => console.warn(s));

  app.get("/api/settings/model", async () => {
    const { model, wrong } = settingModel(env);
    const file = d.envFile ? await envFileWritable(d.envFile) : { ok: false as const, why: "the console has no settings file (.env)" };
    return {
      model, set: (env[MODEL_SETTING_KEY] ?? "").trim() !== "" && wrong === null, wrong, choices: AGENT_MODELS,
      canSave: !!d.gate && file.ok,
      why: !d.gate ? "Saving needs a paired device: the chief of staff is off" : file.ok ? null : `Saving is off: ${file.why}`,
    };
  });

  app.post("/api/settings/model", async (req, reply) => {
    if (!d.envFile) return reply.code(404).send({ error: "not found" });
    if (!d.gate) return reply.code(403).send(NEEDS_CHIEF);
    const caller = await gateUser(d.gate, req, reply);
    if (!caller) return reply;
    const b = saveBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "The request was not understood." });
    const next = b.data.model.trim();
    if (!isAgentModel(next)) return reply.code(400).send({ error: `Not saved: the ${MODEL_REFUSAL}.` });
    if (envWriteBusy()) return reply.code(409).send({ error: "Another save is running. Try again in a moment." });
    const file = await envFileWritable(d.envFile);
    if (!file.ok) return reply.code(409).send({ error: `Saving is off: ${file.why}` });
    try {
      await writeEnvFile(d.envFile, { [MODEL_SETTING_KEY]: next });
    } catch (e) {
      log(`[settings] model not saved: ${e instanceof EnvWriteError ? e.message : "the write failed"}`);
      return reply.code(500).send({ error: "Not saved: the settings file of your server could not be written." });
    }
    env[MODEL_SETTING_KEY] = next;
    log(`[settings] model of new agents set to ${next} by device ${caller.device ?? "?"}`);
    return { model: next };
  });
}
