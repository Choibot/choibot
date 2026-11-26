// bin/lib/agent-env.mjs — the env an agent gets from the console env: worker,
// lead and master agents (server/agents/terminal.ts) and the claude of a cron
// job (bin/cron-runner.mjs). Plain JS: the cron runner starts with a bare node.
//
// AGENT_ENV_PASS in the console env (.env) picks the mode:
//   set, also empty: the allowlist below, the LC_* keys and the keys it names
//     (a comma list, e.g. AGENT_ENV_PASS=MY_DB_URL,MY_API_KEY);
//   unset: every key of the console env, as before this list existed.
// NEVER_PASS keys are dropped in both modes, also when AGENT_ENV_PASS names one.
// A strong-mode spawn goes through sudo, whose env_keep list is narrower again
// (deploy/choibot-agent-exec.sudoers.example): AGENT_ENV_PASS cannot widen it.

import { envKey, envKeys } from "../../server/names.mjs";

/** What an agent needs to run. Exact names, no prefix match (the user token key has the same prefix). */
export const AGENT_ENV_ALLOW = Object.freeze([
  // system and locale (LC_* below)
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK",
  // proxy and TLS trust
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  // Claude and Codex config pointers
  "CLAUDE_CONFIG_DIR", "CLAUDE_ACCOUNTS_DIR", "CLAUDE_DEFAULT_ACCOUNT", "CLAUDE_CODE_EXECUTABLE",
  "CODEX_HOME", "CODEX_EXECUTABLE",
  // non-secret console pointers (the choibot CLI reads PORT and CHIEF_TEST)
  "PORT", "CHIEF_TEST", "CHIEF_CONSOLE_URL", "WORKSPACE_DIR", "CRON_DATA_DIR",
  // identity keys the console sets on purpose (CHOIBOT_* on an install with the old names)
  envKey("AGENT_ID"), envKey("AGENT_PASS"), envKey("WIDGET_DIR"), envKey("CRON_SPOOL"),
]);

/**
 * Never in an agent env: the console's secrets (the cookie secret, the bot
 * token, the user token) and ANTHROPIC_API_KEY (agents bill the box's
 * subscription login, as before). A new secret key in bin/lib/env.ts gets
 * `secret: true` there and its name here (agent-env.test.ts checks it).
 */
export const NEVER_PASS = Object.freeze([
  // The user token under both spellings: the CLI reads either one on every install.
  "CONSOLE_COOKIE_SECRET", "TELEGRAM_BOT_TOKEN", ...envKeys("USER_TOKEN").reverse(), "ANTHROPIC_API_KEY",
]);

const LOCALE_RE = /^LC_[A-Z]+$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The key names AGENT_ENV_PASS lists (invalid names skipped), or null when it is unset.
 * @param {Record<string, string | undefined>} env
 * @returns {string[] | null}
 */
export function agentEnvPass(env) {
  const raw = env.AGENT_ENV_PASS;
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter((s) => NAME_RE.test(s));
}

/**
 * The env an agent gets from the console env `env` (a new object).
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function agentEnv(env) {
  const pass = agentEnvPass(env);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (pass === null || AGENT_ENV_ALLOW.includes(k) || LOCALE_RE.test(k) || pass.includes(k)) out[k] = v;
  }
  for (const k of NEVER_PASS) delete out[k];
  return out;
}
