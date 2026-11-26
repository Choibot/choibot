#!/usr/bin/env node
// bin/cron-runner.mjs — executes ONE cron job: run claude headless, record the
// result, notify the console. Plain JS on purpose: the systemd unit starts it
// with a bare `node`, no pnpm/tsx in the hot path. CRON_DATA_DIR arrives
// pre-resolved via the unit's Environment= line (see deploy/cron-job.service).
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chiefCronArgs, chiefCronEnv, hardenedCronArgs, hardenedRunRefusal, strongTask, strongTaskCall } from "./lib/chief-cron.mjs";
import { agentEnv } from "./lib/agent-env.mjs";
import { runFailure } from "./lib/cron-failure.mjs";
import { MAIN_LOGIN, consoleDefaultLogin, isLoginId, readLogins } from "./lib/cron-login.mjs";
import { WHY_WORDS, readResultLine, runMessageHtml, taskPageUrl, withResultInstruction } from "./lib/cron-result.mjs";

const RING_KEEP = 20;
const TAIL_CHARS = 4000;
// Matches SUMMARY_MAX in server/cron/api.ts: the whole digest travels to
// Telegram (4096-char message limit) as a visible tldr + expandable details.
const SUMMARY_CHARS = 3900;
const DEFAULT_TIMEOUT_MIN = 30; // matches validateSpec()'s default in cronspec.ts

const name = process.argv[2];
const dataDir = process.env.CRON_DATA_DIR;
if (!name || !dataDir) { console.error("usage: CRON_DATA_DIR=… cron-runner.mjs <job>"); process.exit(2); }

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function atomicWrite(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

const spec = readJson(join(dataDir, "jobs", `${name}.json`));
if (!spec) { console.error(`no spec for job ${name}`); process.exit(2); }
if (!spec.enabled) process.exit(0);

const claudeBin = process.env.CLAUDE_CODE_EXECUTABLE || "claude";
// The task's instructions end with the fixed result paragraph (lib/cron-result.mjs): the
// answer then ends with one line that says if a person must look at it.
const args = ["-p", withResultInstruction(spec.prompt), "--dangerously-skip-permissions"];
if (spec.model) args.push("--model", spec.model);
if (spec.effort) args.push("--effort", spec.effort);
args.push(...chiefCronArgs(process.env));
// Hardened deployment only (ruling 2c-8-a): no project settings, hooks or MCP
// servers from the cwd. Otherwise nothing is added.
args.push(...hardenedCronArgs(process.env));
// Bill the box's subscription login, same as interactive agents (terminal.ts).
let env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
env = chiefCronEnv(env, name);
// The mark of a run in progress: the page says "Runs now" while it is there, and "Sign out" of a
// Claude login waits for the runs on that login (server/cron/running.ts). finish() removes it.
// It is written BEFORE the login is known: a sign-out marks its login as signed out first and
// then reads these marks, so a run is either seen by the sign-out (no login yet: any login), or
// it reads the sign-out's mark below and never uses that login.
const startedAt = Date.now();
const runningFile = join(dataDir, "runs", name, "running.json");
const markRunning = (extra) => {
  try {
    mkdirSync(join(dataDir, "runs", name), { recursive: true });
    atomicWrite(runningFile, { startedAt, ...extra });
  } catch { /* the mark is for the page and the sign-out only: a run goes on with no mark */ }
};
markRunning({});
// Strong protection with the agents' login (pick A): the task runs as the agents' account, on
// their one login, through the exec helper. A named login of the spec is not used there.
const strong = strongTask(process.env);
const account = strong ? { login: MAIN_LOGIN } : resolveAccount(spec, env);
if (account.login) markRunning({ login: account.login });
if (strong && spec.account != null && spec.account !== "" && spec.account !== "default") {
  console.error(`[cron-runner] ${name}: the login "${spec.account}" is not used in strong protection; the task runs on the agents' login`);
}
if (account.dir) env.CLAUDE_CONFIG_DIR = account.dir;

// A hand-edited spec with a missing/garbage timeoutMinutes must not take the
// runner down: execFile throws ERR_OUT_OF_RANGE synchronously on a NaN timeout,
// which would lose the run record entirely. Fall back to the CLI's own default.
const mins = Number(spec.timeoutMinutes);
const timeoutMinutes = Number.isInteger(mins) && mins > 0 ? mins : DEFAULT_TIMEOUT_MIN;

const cwd = spec.workdir || process.env.WORKSPACE_DIR || process.cwd();
// Hardened deployment only: never a claude config (ruling F1) or a cwd (S3)
// that is not the console user's own or that a group can write. Otherwise null.
// Strong with the agents' login: the task runs as the agents' account, so these checks of a
// console-uid run do not apply; the helper checks the cwd against its roots.
const refused = account.error || strong ? null : hardenedRunRefusal(env, cwd);

if (account.error) {
  // Running under the wrong login is the failure this check exists to stop, so a job naming a
  // missing (or signed-out) account fails loudly instead of falling back.
  finish({ code: account.signedOut ? "ESIGNEDOUT" : "EACCOUNT", message: account.error }, "", "");
} else if (refused) {
  console.error(`[cron-runner] ${name} refused: ${refused}`);
  finish({ code: "EREFUSED", message: refused }, "", "");
} else {
  // The job's claude gets the agent env (never a console secret). The runner
  // keeps the console env: the checks above and the Telegram fallback read it.
  // Strong: sudo runs the helper as the agents' account; a stop is SIGTERM to sudo, which relays
  // it (SIGKILL would end sudo alone), and the helper ends the task a little later in any case.
  const call = strong
    ? strongTaskCall(strong, cwd, timeoutMinutes, args, agentEnv(env))
    : { bin: claudeBin, args, env: agentEnv(env) };
  const child = execFile(call.bin, call.args, {
    cwd,
    env: call.env, timeout: timeoutMinutes * 60_000, killSignal: strong ? "SIGTERM" : "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  }, finish);
  // claude -p inherits a piped stdin — close it immediately so the run starts
  // promptly. claude still prints a "no stdin data received in 3s" warning to
  // stderr regardless (and execFile ignores any stdio option, so stdin can't be
  // /dev/null); the success notify path below excludes stderr for this reason.
  child.stdin?.end();
}

function finish(err, stdout, stderr) {
  const finishedAt = Date.now();
  // Contract (CronRunResult): exitCode is the numeric status or null. err.code
  // is a *string* for spawn failures (ENOENT/EACCES) and absent on timeout.
  const exitCode = err && typeof err.code === "number" ? err.code : err ? null : 0;
  const ok = !err;
  // A spawn failure or a timeout produces no output at all — without the error
  // message the run record would be an empty, undebuggable husk.
  let output = `${stdout}\n${stderr}`.trim();
  if (err && !output) output = String(err.message ?? "").trim();
  const outputTail = output.slice(-TAIL_CHARS);
  // What the task said of its own run (the last line of its answer). Only a run that finished
  // keeps it: a run that failed or ran out of time is never "all clear", whatever it printed.
  const said = ok ? readResultLine(String(stdout)) : { result: null, text: "" };
  const failure = ok ? null : runFailure(err, exitCode, { strong: !!strong, timeoutMinutes, output });
  const why = failure?.why ?? null;
  const result = {
    startedAt, finishedAt, exitCode, ok, outputTail,
    ...(said.result ? { result: said.result } : {}),
    ...(why ? { why } : {}),
  };

  const runDir = join(dataDir, "runs", name);
  rmSync(runningFile, { force: true });
  mkdirSync(join(runDir, "ring"), { recursive: true });
  atomicWrite(join(runDir, "last.json"), result);
  atomicWrite(join(runDir, "ring", `${startedAt}.json`), result);
  const ring = readdirSync(join(runDir, "ring")).filter((f) => f.endsWith(".json")).sort();
  for (const f of ring.slice(0, Math.max(0, ring.length - RING_KEEP))) {
    rmSync(join(runDir, "ring", f), { force: true });
  }

  // Every run notifies the console: the reader of the runs (the Coordinator, or the fleet
  // master) gets its state and adds a ticket when it needs the user. `result` (state and
  // sentence) and `why` say what the run said: the console checks both. `telegram` carries the
  // job's notify policy: an OK run of
  // an "on-failure" job reaches the console but not Telegram, unless the task
  // itself says that a person must look at it.
  const telegram = !(spec.notify === "on-failure" && ok && said.result?.state !== "needs-you");
  // Successful runs notify from stdout alone: claude's stderr diagnostics
  // (e.g. its "no stdin data received in 3s" warning) sort after stdout in the
  // combined output and would eat the 500-char Telegram tail. Failures keep
  // the combined output — stderr is usually where the error is.
  // The result line is for the page: the summary is the answer with no such line (the
  // sentence of the line when the answer is nothing more). Telegram folds it under the
  // headline of the state (lib/cron-result.mjs runMessageHtml).
  const answer = lineTail(said.text.slice(-TAIL_CHARS));
  const summary = !ok ? `${failure.reason}: ${lineTail(outputTail)}`.trim()
    : said.result ? answer || said.result.sentence : answer || "(no output)";
  const sent = { name, ok, summary, telegram,
    ...(said.result ? { result: { state: said.result.state, sentence: said.result.sentence } } : {}),
    ...(why ? { why } : {}) };
  void notify(sent).finally(() => process.exit(0));
}

// The Bot API: a fake of a test instance (CHIEF_TEST=1 and a loopback address, as
// server/settings/telegram.ts testTelegramApi), else the real one.
function telegramApi() {
  const v = (process.env.CHIEF_TEST_TELEGRAM_API ?? "").trim();
  return process.env.CHIEF_TEST === "1" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(v) ? v : "https://api.telegram.org";
}

// Which Claude login the job runs under, as a CLAUDE_CONFIG_DIR (or none: keep
// the inherited env). Mirrors server/agents/accounts.ts so cron jobs bill the
// same login as interactive agents and the masters:
//   1. spec.account — the user chose it: "default" means the box's own login; any
//      other id must have its dir under CLAUDE_ACCOUNTS_DIR. A missing login, or one
//      that the console marked as signed out, fails the run.
//   2. an explicit CLAUDE_CONFIG_DIR in the env (e.g. a systemd drop-in).
//   3. the console's default login now (lib/cron-login.mjs): the pick of the Settings
//      page, else CLAUDE_DEFAULT_ACCOUNT, and never a signed-out login while another
//      one works; used when its dir exists.
// Without any of these, claude uses ~/.claude.
function resolveAccount(spec, env) {
  const root = env.CLAUDE_ACCOUNTS_DIR || join(homedir(), ".claude-accounts");
  const dirOf = (id) => {
    const dir = join(root, id);
    try { return lstatSync(dir).isDirectory() ? dir : null; } catch { return null; }
  };
  if (spec.account != null && spec.account !== "") {
    const id = String(spec.account);
    if (!isLoginId(id)) return { error: `invalid account ${JSON.stringify(id)}` };
    const dir = id === MAIN_LOGIN ? null : dirOf(id);
    if (id !== MAIN_LOGIN && !dir) return { error: `account "${id}" not found under ${root}` };
    if (readLogins(env).signedOut.has(id)) {
      return { error: `Claude login "${id}": sign in again on the Settings page`, signedOut: true };
    }
    return dir ? { dir, login: id } : { login: MAIN_LOGIN };
  }
  if (env.CLAUDE_CONFIG_DIR) return { login: MAIN_LOGIN };
  const id = consoleDefaultLogin(env);
  const dir = id === MAIN_LOGIN ? null : dirOf(id);
  return dir ? { dir, login: id } : { login: MAIN_LOGIN };
}

// Last SUMMARY_CHARS of the output, but cut at a line boundary so the summary
// never starts mid-word; "…" marks that earlier output was dropped.
function lineTail(s) {
  const t = s.trim();
  if (t.length <= SUMMARY_CHARS) return t;
  let cut = t.slice(-SUMMARY_CHARS);
  const nl = cut.indexOf("\n");
  if (nl !== -1 && nl < cut.length - 1) cut = cut.slice(nl + 1);
  return `…\n${cut.trim()}`;
}

async function notify(body) {
  let token = "";
  try { token = readFileSync(join(dataDir, "notify-token"), "utf8").trim(); } catch { /* no console install */ }
  const port = process.env.PORT || "3100";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cron/notify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cron-token": token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
  } catch { /* console down — fall through */ }
  // Fallback: direct Telegram, so results still arrive while the console is
  // down. Mirrors the server notifier's HTML rendering (telegramHtmlFor).
  if (!body.telegram) return;
  const tg = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tg || !chat) return;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sum = body.summary.trim().slice(0, SUMMARY_CHARS);
  // A run with a state: its words and its sentence (for did-not-finish: the reason words), no tail.
  const state = !body.ok ? (WHY_WORDS[body.why] ? "did-not-finish" : null) : body.result?.state ?? null;
  const said = state === "did-not-finish" ? WHY_WORDS[body.why] : body.result?.sentence;
  // Mirrors splitSummary() in server/agents/notifier.ts: text before the first
  // blank line (or first line, failing that) shows as the visible tldr, the
  // rest collapses into an expandable quote.
  const blank = sum.search(/\n[ \t]*\n/);
  const cut = blank !== -1 ? blank : sum.indexOf("\n");
  const tldr = cut === -1 ? sum : sum.slice(0, cut).trim();
  const details = cut === -1 ? "" : sum.slice(cut).trim();
  let text = `${body.ok ? "✅" : "❌"} <b>${esc(body.name)}</b>`;
  if (tldr) text += `\n${esc(tldr)}`;
  if (details) text += `\n<blockquote expandable>${esc(details)}</blockquote>`;
  if (state) text = runMessageHtml({ name: body.name, state, sentence: said, url: taskPageUrl(process.env.CHIEF_CONSOLE_URL, body.name), text: body.summary });
  const post = (payload) =>
    fetch(`${telegramApi()}/bot${tg}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000),
    });
  try {
    let res = await post({ chat_id: chat, text, parse_mode: "HTML" });
    // Malformed HTML must not lose the notification — retry plain.
    if (!res.ok) res = await post({ chat_id: chat, text: `${body.ok ? "✅" : "❌"} ${body.name} — ${sum}`.slice(0, 4000) });
    if (!res.ok) console.error(`[cron-runner] telegram fallback failed: ${res.status}`);
  } catch (e) { console.error(`[cron-runner] telegram fallback failed: ${e}`); }
}
