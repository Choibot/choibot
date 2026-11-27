// server/agents/model.ts — the model a Claude agent may be told to start on (owner's order of
// 2026-11-26, "cut the token use"; owner's rule r_vu7nl: agents pick per task). The aliases of
// `claude --model` (https://code.claude.com/docs/en/model-config). An agent with no model of its
// own starts on the console's setting (startModel below). The console never writes a login's own
// settings: the --model flag of each start is the console's only means.
import { isPersistentKind } from "./store.js";

export const AGENT_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const isAgentModel = (v: unknown): v is AgentModel =>
  typeof v === "string" && (AGENT_MODELS as readonly string[]).includes(v);

export const MODEL_REFUSAL = `model must be one of ${AGENT_MODELS.join(", ")}`;

// The console's setting for the model of an agent that has none of its own (owner's answer on
// 2026-11-26: "opus seems good, only fable if necessary for hard task. make it a setting
// also"). In .env; Settings > Model changes it at once (server/settings/model.ts).
export const MODEL_SETTING_KEY = "AGENT_MODEL";
export const DEFAULT_AGENT_MODEL: AgentModel = "opus";

// The setting's model, and the raw value when it is set but not an alias (the model is then the
// default, and the boot log says so).
export function settingModel(env: Record<string, string | undefined> = process.env): { model: AgentModel; wrong: string | null } {
  const raw = (env[MODEL_SETTING_KEY] ?? "").trim();
  if (isAgentModel(raw)) return { model: raw, wrong: null };
  return { model: DEFAULT_AGENT_MODEL, wrong: raw === "" ? null : raw };
}

// The --model of a Claude agent's start: its own model (from its spawn), else the setting. A lead
// or the fleet master that resumes its session keeps the model the session was saved on (no
// flag; the owner changes it); its fresh start takes the setting. The Coordinator has its own
// fixed model (recovery.ts masterPreset), which this never replaces.
export function startModel(
  rec: { kind?: string; model?: AgentModel }, o: { fresh: boolean },
  env: Record<string, string | undefined> = process.env,
): AgentModel | undefined {
  if (rec.model) return rec.model;
  if (rec.kind === "coordinator") return undefined;
  if (isPersistentKind(rec.kind) && !o.fresh) return undefined;
  return settingModel(env).model;
}
