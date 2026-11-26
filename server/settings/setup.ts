// server/settings/setup.ts — the Telegram set-up form of the Settings page: the check of what the
// user typed (plain field names, never env keys, in the request and in every error), the map to
// the env keys of the console's .env, and the restart that applies them.
//
// The token is write-only: it comes in, is checked (shape, then a live getMe), and goes to the
// .env writer. It is never sent back, logged or put in an error text. An empty token field keeps
// the current token.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chiefMisconfigured } from "../chief/paths.js";
import { ownUnit, type Armed } from "../chief/deploy/config.js";
import type { EnvChanges, WritableKey } from "./envfile.js";
import type { Env } from "./telegram.js";
import { userCli } from "../usercli.mjs";

const execFileP = promisify(execFile);

// The form's fields, and the env key each one writes.
export const SETUP_FIELDS = {
  token: "TELEGRAM_BOT_TOKEN",
  account: "TELEGRAM_ISSUES_USER_ID",
  masterGroup: "TELEGRAM_MASTER_CHAT_ID",
  masterTopic: "TELEGRAM_MASTER_THREAD_ID",
  cronGroup: "TELEGRAM_CRON_CHAT_ID",
  cronTopic: "TELEGRAM_CRON_THREAD_ID",
} as const satisfies Record<string, WritableKey>;
export type SetupField = keyof typeof SETUP_FIELDS;
export type SetupInput = Partial<Record<SetupField, string>>;

// The ids the form shows (the running console's values; the token is never one of them).
export function setupValues(env: Env): Record<Exclude<SetupField, "token">, string> {
  const v = (k: string) => (env[k] ?? "").trim();
  return {
    account: v(SETUP_FIELDS.account), masterGroup: v(SETUP_FIELDS.masterGroup), masterTopic: v(SETUP_FIELDS.masterTopic),
    cronGroup: v(SETUP_FIELDS.cronGroup), cronTopic: v(SETUP_FIELDS.cronTopic),
  };
}

export const TOKEN_RE = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
const POS = /^[1-9]\d{0,15}$/;
const GROUP = /^-[1-9]\d{0,15}$/;

export type SetupError = { field: SetupField | null; error: string };
export type SetupPlan = { changes: EnvChanges; newToken: string | null };

// Checks the form against the running env. Returns the changes to write (only the keys whose value
// differs from `current`, the file's own values) or the first problem, naming the field.
export function planSetup(input: SetupInput, env: Env, current: Partial<Record<WritableKey, string>>): SetupPlan | SetupError {
  const val = (f: SetupField): string => (input[f] ?? "").trim();
  const token = val("token");
  if (token && !TOKEN_RE.test(token)) return { field: "token", error: "This does not look like a bot token. Copy it from @BotFather: digits, a colon, then letters." };
  const hasToken = !!token || !!(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const ids: Array<[SetupField, RegExp, string]> = [
    ["account", POS, "Your Telegram user id is a whole number, like 123456789."],
    ["masterGroup", GROUP, "A group id starts with a minus, like -1001234567890."],
    ["masterTopic", POS, "A topic id is a whole number, like 2."],
    ["cronGroup", GROUP, "A group id starts with a minus, like -1001234567890."],
    ["cronTopic", POS, "A topic id is a whole number, like 4."],
  ];
  for (const [f, re, msg] of ids) if (val(f) && !re.test(val(f))) return { field: f, error: msg };
  if (!!val("masterGroup") !== !!val("masterTopic")) return { field: val("masterGroup") ? "masterTopic" : "masterGroup", error: "The fleet master chat needs both its group and its topic." };
  if (!!val("cronGroup") !== !!val("cronTopic")) return { field: val("cronGroup") ? "cronTopic" : "cronGroup", error: "Recurring results need both a group and a topic, or neither." };
  if (val("masterGroup") && !val("account")) return { field: "account", error: "The fleet master chat needs your Telegram user id: the bot answers only you." };
  if (!hasToken && (["account", "masterGroup", "cronGroup"] as const).some((f) => val(f))) return { field: "token", error: "Add the bot token first." };

  const changes: EnvChanges = {};
  for (const f of Object.keys(SETUP_FIELDS) as SetupField[]) {
    const key = SETUP_FIELDS[f];
    if (f === "token") { if (token && token !== current[key]) changes[key] = token; continue; }
    const next = val(f);
    const now = (current[key] ?? "").trim();
    if (next !== now) changes[key] = next || null;
  }
  // The chief of staff must still start after the restart: a console that pairs devices through
  // Telegram needs its fleet master chat. (A console that pairs devices from the server takes a
  // fleet master chat too: its pairing stays as it is.)
  const after: Env = { ...env };
  for (const [k, v] of Object.entries(changes)) after[k] = v ?? undefined;
  const before = chiefMisconfigured(env), then = chiefMisconfigured(after);
  if (before === null && then !== null) {
    return then.includes("telegram but")
      ? { field: "masterGroup", error: "This console pairs devices through the fleet master chat: keep its group and topic." }
      : { field: null, error: `Saving this would stop the chief of staff. Check the set-up on your server with \`${userCli()} doctor\`.` };
  }
  return { changes, newToken: token && changes.TELEGRAM_BOT_TOKEN ? token : null };
}

// The restart that applies a save: a transient user timer starts `systemctl --user restart` of
// the console's own unit a few seconds later, after the answer went out. It runs outside the
// console's unit, so the restart does not kill it, and the agents keep running (their own scopes).
// Armed only when the console is the main process of that unit (the deploy ticket's check).
export type Restarter = { armed(): Promise<Armed>; schedule(): Promise<void> };

export function systemdRestarter(unit: string): Restarter {
  const name = `${unit.replace(/\.service$/, "")}-settings-restart`;
  return {
    armed: () => ownUnit(unit),
    async schedule() {
      await execFileP("systemd-run", [
        "--user", "--collect", "--quiet", `--unit=${name}`, "--on-active=3", "--timer-property=AccuracySec=500ms",
        "--description=ChoiBot restart after a Settings save", "systemctl", "--user", "restart", unit,
      ], { timeout: 15_000 });
    },
  };
}
