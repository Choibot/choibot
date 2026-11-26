// server/chief/paths.ts — chief-of-staff data layout and the one place that
// reads CHIEF_ENABLED. Import-light on purpose: bin/lib/doctor.ts imports it.
import { join } from "node:path";
import { parseMasterTgConfig } from "../master/telegram.js";
import { parseIssuesUserId } from "../issues/paths.js";
import { resolveAppDataDir } from "../defaults.js";
import { envKey, names } from "../names.mjs";

export type Env = Record<string, string | undefined>;

export const CHIEF_PROMPT_REV = 16;

export function resolveChiefDataDir(env: Env = process.env): string {
  if (env.CHIEF_DATA_DIR) return env.CHIEF_DATA_DIR;
  return join(resolveAppDataDir(env), "chief");
}

export type ChiefPaths = {
  root: string; devices: string; queueDir: string; mediaDir: string; brainDir: string;
  rules: string; decisions: string; classified: string; brain: string; proposed: string; versionsDir: string;
  cards: string; runDir: string; auditAuto: string; leadsDir: string; areas: string;
  // The rule suggester's state: when it first ran (brain/suggest.ts).
  suggest: string;
  // The reminders agents set for themselves (one file, one lock).
  reminders: string;
  // The deploy run's state file and logs (spec §5.7).
  deployDir: string;
  // The hash of the code that pairs the first device of a new install (firstrun.ts).
  pairCode: string;
  // The hash of the code that a paired device made to add one more device (adddevice.ts).
  addCode: string;
  // The first-start file that an image's first-boot step writes, and the claim link the console
  // keeps from it (claimlink.ts).
  firstStart: string;
  claimLink: string;
  // The token of the console's own account (consoletoken.ts; strong protection only).
  consoleToken: string;
};

export function chiefPaths(root: string): ChiefPaths {
  const brainDir = join(root, "brain");
  const queueDir = join(root, "queue");
  return {
    root,
    devices: join(root, "user-devices.json"),
    queueDir,
    mediaDir: join(queueDir, "media"),
    brainDir,
    rules: join(brainDir, "rules.jsonl"),
    decisions: join(brainDir, "decisions.jsonl"),
    classified: join(brainDir, "classified.jsonl"),
    brain: join(brainDir, "BRAIN.md"),
    proposed: join(brainDir, "BRAIN.proposed.md"),
    versionsDir: join(brainDir, "versions"),
    cards: join(brainDir, "cards.json"),
    runDir: join(brainDir, "run"),
    suggest: join(brainDir, "suggest.json"),
    auditAuto: join(root, "audit", "auto.jsonl"),
    leadsDir: join(root, "leads"),
    areas: join(root, "areas.json"),
    reminders: join(root, "reminders.json"),
    deployDir: join(root, "deploy"),
    pairCode: join(root, "pair-code.json"),
    addCode: join(root, "add-device-code.json"),
    firstStart: join(root, "first-start.json"),
    claimLink: join(root, "claim-link.json"),
    consoleToken: join(root, "console-token"),
  };
}

export function chiefFlag(env: Env = process.env): boolean {
  return env.CHIEF_ENABLED === "1";
}

export function chiefUserAuth(env: Env = process.env): "telegram" | "log" {
  return env.CHIEF_USER_AUTH === "log" ? "log" : "telegram";
}

export function telegramReady(env: Env = process.env): boolean {
  return parseMasterTgConfig(env, parseIssuesUserId(env.TELEGRAM_ISSUES_USER_ID)) !== null;
}

// null when the flag is off or the config is sound.
export function chiefMisconfigured(env: Env = process.env): string | null {
  if (!chiefFlag(env)) return null;
  const auth = env.CHIEF_USER_AUTH;
  if (auth !== undefined && auth !== "" && auth !== "telegram" && auth !== "log") {
    return "CHIEF_USER_AUTH must be telegram or log";
  }
  if (!env.CHIEF_CONSOLE_URL) return "CHIEF_CONSOLE_URL is not set";
  const ready = telegramReady(env);
  if (chiefUserAuth(env) === "telegram" && !ready) {
    return "CHIEF_USER_AUTH=telegram but the Master topic is not configured";
  }
  // `log` with a Master topic is sound: devices still pair from the server (the Telegram route
  // answers /pair with one fixed line, chief/telegram.ts), and the topic gets the cards and the
  // fleet master chat. Auto-answer stays off in log mode (queue/eligibility.ts).
  return null;
}

export function chiefActive(env: Env = process.env): boolean {
  return chiefFlag(env) && chiefMisconfigured(env) === null;
}

// The chief's tunables (spec §4.4 env table). Each value is checked on its
// own; an invalid one is its default.
export type ChiefTunables = { undoMs: number; autoThreshold: number; telegramAuto: boolean; distillAt: string };

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Plain decimals only: no sign, exponent, hex or Infinity.
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

export function chiefTunables(env: Env = process.env): ChiefTunables {
  const minutes = /^\d+$/.test(env.CHIEF_UNDO_MINUTES ?? "") ? Number(env.CHIEF_UNDO_MINUTES) : NaN;
  const undoMs = minutes * 60_000;
  const threshold = DECIMAL.test(env.CHIEF_AUTO_THRESHOLD ?? "") ? Number(env.CHIEF_AUTO_THRESHOLD) : NaN;
  const at = env.CHIEF_DISTILL_AT ?? "";
  return {
    undoMs: minutes > 0 && Number.isSafeInteger(undoMs) ? undoMs : 10 * 60_000,
    autoThreshold: threshold > 0 && threshold <= 1 ? threshold : 0.85,
    telegramAuto: env.CHIEF_TELEGRAM_AUTO !== "0",
    distillAt: HH_MM.test(at) ? at : "03:30",
  };
}

export function chiefCli(repoDir: string): string {
  return `${repoDir}/node_modules/.bin/tsx ${repoDir}/${names().cliEntry}`;
}

// The identity keys of an agent: CHOIBOT_AGENT_ID / CHOIBOT_AGENT_PASS on an install with the old
// names, CHOIBOT_AGENT_ID / CHOIBOT_AGENT_PASS on a new one.
export function agentIdentityEnv(rec: { id: string; hookToken: string }): Record<string, string> {
  return { [envKey("AGENT_ID")]: rec.id, [envKey("AGENT_PASS")]: rec.hookToken };
}
