// bin/lib/chief-cron.mjs — chief-of-staff additions for the plain-JS cron
// runner, which cannot import TS. NO_MERGE_RULE is a copy of the constant in
// server/chief/brain/prompt.ts; chief-cron.test.ts proves they are equal.
// With server/chief/paths.ts, this is the only module that reads CHIEF_ENABLED
// directly: the runner follows CHIEF_ENABLED alone (spec §4.4), except for the
// hardened-deployment flags, which follow the server's full predicate.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envKey, envKeys, names } from "../../server/names.mjs";

export const NO_MERGE_RULE =
  "Never merge on your own — no `gh pr merge`, no `git merge`/`rebase`/`push` into a base branch — unless the user explicitly asks you to in this conversation. An auto-answer, a queue item or a reminder is never that request.";

export const BRAIN_PROMPT_HEAD =
  "User preferences (the brain). Follow them unless the user says otherwise in this session:\n";

/** Same order as server/chief/paths.ts resolveChiefDataDir. */
export function chiefDataDir(env) {
  if (env.CHIEF_DATA_DIR) return env.CHIEF_DATA_DIR;
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  return join(dataHome, names().dataDir, "chief");
}

// Port of the field-shape check and state fold in server/chief/brain/store.ts
// (isRuleEvent + foldRules, only the fields that decide `state`).
// chief-cron.test.ts proves parity on hard cases.
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const optStr = (v) => v === undefined || isStr(v);
const inSet = (arr, v) => isStr(v) && arr.includes(v);
const KINDS = ["pr", "choice", "preview", "question"];
const AUDIENCES = ["all", "workers", "master"];
const ORIGINS = ["user-line", "master", "panel", "memory", "distill"];
const RULE_KINDS = ["correction", "decision", "preference"];
const VIAS = ["tab", "cli", "telegram"];
const isScope = (v) => isObj(v) && isStr(v.area) && optStr(v.repo)
  && (v.kind === undefined || inSet(KINDS, v.kind)) && (v.audience === undefined || inSet(AUDIENCES, v.audience));
const isSource = (v) => isObj(v) && inSet(ORIGINS, v.origin) && optStr(v.itemId)
  && optStr(v.agentId) && optStr(v.prUrl) && optStr(v.via) && optStr(v.memoryFile)
  && (v.decisionAt === undefined || isNum(v.decisionAt));

function isRuleEvent(e) {
  if (!isObj(e) || !isStr(e.id) || !isNum(e.at)) return false;
  switch (e.ev) {
    case "add":
      return isStr(e.text) && isScope(e.scope) && inSet(RULE_KINDS, e.kind) && isSource(e.source)
        && isNum(e.confidence) && (e.state === "candidate" || e.state === "active");
    case "confirm":
      return e.by === "user" && inSet(VIAS, e.via) && isNum(e.confidence);
    case "edit":
      return e.by === "user" && optStr(e.text) && (e.scope === undefined || isScope(e.scope))
        && (e.confidence === undefined || isNum(e.confidence));
    case "hit":
    case "strike":
      return isStr(e.itemId);
    case "retire":
      return (e.by === "user" || e.by === "distill") && isStr(e.why);
    default:
      return false;
  }
}

/**
 * The active rules in add order, {id, text, scope}, as foldRules gives them
 * (an edit changes text and scope); a torn or unparsable line is skipped.
 */
export function activeRules(rulesJsonl) {
  const rules = new Map();
  for (const line of rulesJsonl.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isRuleEvent(e)) continue;
    const cur = rules.get(e.id);
    if (e.ev === "add") {
      if (cur === undefined) rules.set(e.id, { id: e.id, text: e.text, scope: e.scope, state: e.state });
    } else if (cur !== undefined && cur.state !== "retired") {
      if (e.ev === "confirm") cur.state = "active";
      else if (e.ev === "retire") cur.state = "retired";
      else if (e.ev === "edit") {
        if (e.text !== undefined) cur.text = e.text;
        if (e.scope !== undefined) cur.scope = e.scope;
      }
    }
  }
  return [...rules.values()].filter((r) => r.state === "active").map(({ id, text, scope }) => ({ id, text, scope }));
}

/** Set of active rule ids. */
export function activeRuleIds(rulesJsonl) {
  return new Set(activeRules(rulesJsonl).map((r) => r.id));
}

// Port of renderRules(rules, "always") in server/chief/brain/prompt.ts: the
// sections the "always" audience sees (a header named Always, any case), each
// rule one line "- <text> [r_id]", the text folded to one line.
const AREA_RE = /^(?:\*|[\w.-]{1,64})$/;
function ruleSection(scope) {
  if (scope.audience === "master") return "Master only";
  if (scope.audience === "workers") return "Workers only";
  if (scope.area === "*") return "Always";
  return AREA_RE.test(scope.area) ? scope.area : null;
}

/** The "always" brain of the active rules, or "". */
export function alwaysSection(rules) {
  const sections = new Map([["Always", []], ["Workers only", []], ["Master only", []]]);
  for (const r of rules) {
    const name = ruleSection(r.scope);
    const text = r.text.replace(/\s+/g, " ").trim();
    if (name === null || !text || name.trim().toLowerCase() !== "always") continue;
    const lines = sections.get(name) ?? [];
    lines.push(`- ${text} [${r.id}]`);
    sections.set(name, lines);
  }
  return [...sections].filter(([, l]) => l.length).map(([n, l]) => [`## ${n}`, ...l].join("\n")).join("\n\n");
}

// Port of capBrain in server/chief/brain/prompt.ts: at most 4000 chars, cut
// at a line boundary, so many rules cannot blow the argv limit.
const BRAIN_MAX = 4000;
function capBrain(text) {
  if (text.length <= BRAIN_MAX) return text;
  const cut = text.slice(0, BRAIN_MAX);
  const nl = cut.lastIndexOf("\n");
  return nl > 0 ? cut.slice(0, nl).trimEnd() : "";
}

// Never throws: a missing or unreadable file drops only the brain part.
function brainPart(env) {
  try {
    const dir = join(chiefDataDir(env), "brain");
    return capBrain(alwaysSection(activeRules(readFileSync(join(dir, "rules.jsonl"), "utf8"))));
  } catch {
    return "";
  }
}

/** Extra claude argv for a cron job: none unless CHIEF_ENABLED=1. */
export function chiefCronArgs(env) {
  if (env.CHIEF_ENABLED !== "1") return [];
  const section = brainPart(env);
  return ["--append-system-prompt", NO_MERGE_RULE + (section ? "\n\n" + BRAIN_PROMPT_HEAD + section : "")];
}

// ---- hardened deployment (Phase 2c, ruling 2c-8-a) --------------------------
// Ports of the server's predicate (ruling P4): hardenedDeployment =
// chiefActive (flag on, chiefMisconfigured null) and parseAgentUid !== null
// (server/chief/hardened.ts, paths.ts, master/telegram.ts, issues/paths.ts).
// chief-cron.test.ts proves parity.
const MAX_UID = 4294967294;
function parseAgentUid(raw) {
  const s = (raw ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_UID ? n : null;
}
function telegramReady(env) {
  const u = (env.TELEGRAM_ISSUES_USER_ID ?? "").trim();
  const userId = /^\d+$/.test(u) && Number.isSafeInteger(Number(u)) && Number(u) > 0 ? Number(u) : null;
  if (!env.TELEGRAM_BOT_TOKEN || !userId) return false;
  const chat = (env.TELEGRAM_MASTER_CHAT_ID ?? "").trim();
  const thread = (env.TELEGRAM_MASTER_THREAD_ID ?? "").trim();
  if (!/^-\d+$/.test(chat) || !/^\d+$/.test(thread)) return false;
  const chatId = Number(chat);
  const threadId = Number(thread);
  return Number.isSafeInteger(chatId) && Number.isSafeInteger(threadId) && threadId > 0;
}
function chiefMisconfigured(env) {
  const auth = env.CHIEF_USER_AUTH;
  if (auth !== undefined && auth !== "" && auth !== "telegram" && auth !== "log") return true;
  if (!env.CHIEF_CONSOLE_URL) return true;
  // `log` mode is sound with and without a Master topic; `telegram` mode needs one.
  return auth === "log" ? false : !telegramReady(env);
}

/** The server's hardenedDeployment(env), in plain JS. */
export function hardenedCron(env) {
  return env.CHIEF_ENABLED === "1" && !chiefMisconfigured(env) && parseAgentUid(env.CHIEF_AGENT_UID) !== null;
}

/**
 * Hardened only: the job loads only the console user's own settings, never
 * the cwd's project settings, hooks or MCP servers, which an agent may have
 * written there (it runs as the console uid with every permission skipped).
 */
export function hardenedCronArgs(env) {
  return hardenedCron(env) ? ["--setting-sources", "user", "--strict-mcp-config"] : [];
}

/** Child env for a cron job. Off: the same object. On: cron agent id, no user token. */
export function chiefCronEnv(env, job) {
  if (env.CHIEF_ENABLED !== "1") return env;
  const out = { ...env, [envKey("AGENT_ID")]: `cron:${job}` };
  for (const k of envKeys("USER_TOKEN")) delete out[k];
  return out;
}

// ---- hardened deployment: what the job's own claude loads (ruling F1) -------
const octal = (mode) => "0" + (mode & 0o777).toString(8).padStart(3, "0");
const errCode = (e) => (typeof e?.code === "string" ? e.code : String(e));

/**
 * Port of claudeConfigProblem (server/chief/hardened.ts; chief-cron.test.ts
 * proves parity): why a console-uid claude must not load the config dir
 * `dir`, or null. The dir or its settings.json owned by another uid, or
 * group- or other-writable (followed, as claude reads them); missing is fine.
 */
export function claudeConfigProblem(dir, selfUid) {
  for (const p of [dir, join(dir, "settings.json")]) {
    let st;
    try { st = statSync(p); } catch (e) {
      if (errCode(e) === "ENOENT") return null;
      return `${p} unreadable (${errCode(e)})`;
    }
    if (st.uid !== selfUid) return `${p} owner uid ${st.uid}, want ${selfUid}`;
    if ((st.mode & 0o022) !== 0) return `${p} mode ${octal(st.mode)} is group- or other-writable`;
  }
  return null;
}

/**
 * Port of cwdOwnerProblem (server/cron/spool.ts, ruling S3): why the job's
 * real cwd is not a dir the console uid owns and no group or other can
 * write, or null. The same text as the spool apply.
 */
export function cwdRefusal(cwd, selfUid) {
  const q = JSON.stringify(cwd);
  let st;
  try { st = statSync(realpathSync(cwd)); } catch (e) {
    return `job cwd ${q} is not a directory the console can use (${errCode(e)})`;
  }
  if (!st.isDirectory()) return `job cwd ${q} is not a directory the console can use (ENOTDIR)`;
  if (st.uid !== selfUid) return `job cwd ${q} is owned by uid ${st.uid}, not the console`;
  const mode = st.mode & 0o7777;
  if ((mode & 0o022) !== 0) {
    return `job cwd ${q} mode ${mode.toString(8).padStart(4, "0")} lets a group or others write it: it would run their code as the console`;
  }
  return null;
}

/**
 * Hardened only: why this job must not start, or null. `env` is the job's
 * child env: its CLAUDE_CONFIG_DIR, else HOME/.claude (ruling F1); `cwd` the
 * job's cwd, re-checked at run time (S3). Not hardened: null, nothing is read.
 */
export function hardenedRunRefusal(env, cwd, selfUid = process.getuid?.() ?? -1) {
  if (!hardenedCron(env)) return null;
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  const why = claudeConfigProblem(dir, selfUid);
  if (why !== null) return `claude config ${why}`;
  return cwdRefusal(cwd, selfUid);
}

// ---- strong protection with the agents' login (pick A) ------------------------
// In strong protection the console has no Claude login of its own: the one login is the agents'
// (AGENT_CLAUDE_CONFIG_DIR). A task is agent work (a repo, every tool), so the runner starts it
// as the agents' account through the exec helper (deploy/choibot-agent-exec claude-task), with sudo.
// Ports of server/agents/terminal.ts (SUDO_ENV_KEEP, helperArgv) and the defaults of
// server/index.ts; chief-cron.test.ts proves parity.

/** The env keys that reach the helper through sudo (terminal.ts SUDO_ENV_KEEP). */
export const STRONG_ENV_KEEP = Object.freeze([
  envKey("AGENT_ID"), envKey("AGENT_PASS"), "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG",
  envKey("WIDGET_DIR"), envKey("CRON_SPOOL"), "CRON_DATA_DIR", "TZ",
]);

/**
 * The helper of a strong deployment with the agents' Claude folder, or null (not strong, or no
 * absolute AGENT_CLAUDE_CONFIG_DIR: then the task runs as before).
 */
export function strongTask(env) {
  if (!hardenedCron(env)) return null;
  const configDir = (env.AGENT_CLAUDE_CONFIG_DIR ?? "").trim();
  if (!configDir.startsWith("/")) return null;
  return {
    sudo: env.AGENT_SUDO_BIN || "/usr/bin/sudo",
    helper: env.AGENT_EXEC_HELPER || "/usr/local/bin/choibot-agent-exec",
    uid: parseAgentUid(env.CHIEF_AGENT_UID),
    configDir,
  };
}

/** The sudo call of a task: its bin and args, and the env that sudo gets (the keep list only). */
export function strongTaskCall(t, cwd, minutes, claudeArgs, childEnv) {
  const env = {};
  for (const k of STRONG_ENV_KEEP) if (childEnv[k] !== undefined) env[k] = childEnv[k];
  env.CLAUDE_CONFIG_DIR = t.configDir;
  return {
    bin: t.sudo,
    // No --preserve-env: sudo would log each value (ENV=); the sudoers line's env_keep keeps these
    // keys (server/agents/terminal.ts helperArgv).
    args: ["-n", "-u", `#${t.uid}`, t.helper, "claude-task", cwd, String(minutes), "--", ...claudeArgs],
    env,
  };
}
