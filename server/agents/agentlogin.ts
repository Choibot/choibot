// server/agents/agentlogin.ts — the Claude login in strong protection (server/chief/hardened.ts).
// One login for the agents: it is the agents' own, in their Claude folder
// (AGENT_CLAUDE_CONFIG_DIR, under the agents' account). The console cannot read that folder, so
// it runs `claude auth login|status|logout` there through its exec helper (deploy/choibot-agent-exec,
// verb claude-auth): Claude Code itself makes the login with Anthropic's own flow, the page shows
// its link and hands it the pasted code. The console never reads or keeps a token.
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { parseStatus, type ClaudeAccount } from "../../bin/lib/login.js";
import { chiefAccount } from "../chief/chiefaccount.js";
import { hardenedDeployment, parseAgentUid } from "../chief/hardened.js";
import { makeClaudeRun, type ClaudeRun } from "../chief/brain/distill.js";
import { STATUS_MS } from "./claudelogin.js";
import { helperArgv, helperEnv, type AgentExec } from "./terminal.js";

type Env = Record<string, string | undefined>;
export type AuthSub = "login" | "status" | "logout";
export type AuthCommand = { bin: string; args: string[]; env: NodeJS.ProcessEnv };
// The agents' login: the helper to call, and their Claude folder.
export type AgentAuth = { exec: AgentExec; configDir: string; env: Env };

// How long an answer of the status is kept. A read costs one sudo line in the auth log and one
// Claude Code process: the list of logins, the Set-up page and agents ask often.
export const STATUS_KEEP_MS = 60_000;

// The helper call of one subcommand. The env: the keys sudo keeps, with the agents' Claude
// folder in place of the console's own (CLAUDE_CONFIG_DIR is in the env_keep list).
export function agentAuthCommand(a: AgentAuth, sub: AuthSub): AuthCommand {
  const argv = helperArgv(a.exec, "claude-auth", [sub]);
  return { bin: argv[0], args: argv.slice(1), env: { ...helperEnv(a.env), CLAUDE_CONFIG_DIR: a.configDir, NO_COLOR: "1", TERM: "dumb" } as unknown as NodeJS.ProcessEnv };
}

// The second sign-in (chief/chiefaccount.ts): the persistent agents' own login, in that account's
// Claude folder, made and read through the helper as that account. Null when the account is
// not set (or set but broken), or its helper is not ready.
export function chiefAuthOf(env: Env, exec: AgentExec | undefined): AgentAuth | null {
  const a = chiefAccount(env);
  if (!a || !exec || exec.uid !== a.uid) return null;
  return { exec, configDir: a.claudeDir, env };
}

// The agents' login of a strong deployment, from its settings, or null (not strong, or no
// agents' Claude folder). The server gives its probed helper; the CLI (doctor) builds the same
// one from the settings, as the server's defaults (index.ts).
export function agentAuthOf(env: Env, exec?: AgentExec): AgentAuth | null {
  if (!hardenedDeployment(env)) return null;
  const configDir = env.AGENT_CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (!isAbsolute(configDir)) return null;
  const uid = parseAgentUid(env.CHIEF_AGENT_UID);
  if (uid === null) return null;
  const x = exec ?? { sudo: env.AGENT_SUDO_BIN ?? "/usr/bin/sudo", helper: env.AGENT_EXEC_HELPER ?? "/usr/local/bin/choibot-agent-exec", uid };
  return { exec: x, configDir, env };
}

// Who is logged in for the agents, as Claude Code says it. A helper that fails (no sudo rule
// yet, a timeout) reads as no login.
export function agentLoginStatus(a: AgentAuth, run: typeof execFile = execFile): Promise<ClaudeAccount> {
  const c = agentAuthCommand(a, "status");
  return new Promise((done) => {
    run(c.bin, c.args, { env: c.env, timeout: STATUS_MS }, (_err, stdout) => done(parseStatus(String(stdout ?? ""))));
  });
}

// The status read, kept for a short time, with one run at a time shared by all callers. The
// console drops the kept answer when a login ends or is cancelled (forget).
export class AgentLoginStatus {
  private kept: { at: number; value: ClaudeAccount } | null = null;
  private running: Promise<ClaudeAccount> | null = null;
  private round = 0;
  private readonly now: () => number;
  private readonly keepMs: number;

  constructor(private readonly run: () => Promise<ClaudeAccount>, o: { now?: () => number; keepMs?: number } = {}) {
    this.now = o.now ?? Date.now;
    this.keepMs = o.keepMs ?? STATUS_KEEP_MS;
  }

  read(): Promise<ClaudeAccount> {
    if (this.kept && this.now() - this.kept.at < this.keepMs) return Promise.resolve(this.kept.value);
    if (this.running) return this.running;
    const round = this.round;
    const p = this.run().then((value) => {
      // A forget while it ran: its answer may be from before the change, so it is not kept.
      if (round === this.round) this.kept = { at: this.now(), value };
      return value;
    }).finally(() => { if (this.running === p) this.running = null; });
    this.running = p;
    return p;
  }

  forget(): void {
    this.kept = null;
    this.running = null;
    this.round++;
  }
}

// The console's own model calls in strong protection (the guide, Fill in, the clean-up words,
// the Brain review): `claude -p` with no tool, on the agents' login, through the helper's
// claude-print. The caller gives the argv of today's call (GUIDE_ARGV or DISTILL_ARGV, its model,
// maybe a system prompt); only the model and the system prompt go to the helper, which has the
// fixed flags itself. An argv of another shape is refused, never run. The cwd and env of the
// caller are not used: the helper makes a new folder and a fresh env.
export const PRINT_FLAGS: readonly string[] = ["-p", "--output-format", "json", "--tools", "", "--restricted", "--strict-mcp-config", "--no-session-persistence"];

// The model and the system prompt of a no-tool call, or null when the argv has another shape.
export function printCall(args: string[]): { model: string; system?: string } | null {
  const rest = [...args];
  let system: string | undefined;
  if (rest.length >= 2 && rest[rest.length - 2] === "--system-prompt") { system = rest[rest.length - 1]; rest.splice(-2); }
  const at = rest.indexOf("--model");
  if (at < 0 || at + 1 >= rest.length) return null;
  const model = rest[at + 1];
  rest.splice(at, 2);
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(model)) return null;
  if (rest.length !== PRINT_FLAGS.length || rest.some((a, i) => a !== PRINT_FLAGS[i])) return null;
  return system === undefined ? { model } : { model, system };
}

export function agentClaudeRun(a: AgentAuth, o: { run?: (bin: string) => ClaudeRun } = {}): ClaudeRun {
  const env = { ...helperEnv(a.env), CLAUDE_CONFIG_DIR: a.configDir };
  const make = o.run ?? ((bin: string) => makeClaudeRun(bin, { stop: "term" }));
  const run = make(a.exec.sudo);
  return (args, call) => {
    const p = printCall(args);
    if (!p) return Promise.reject(new Error("a model call of another shape is not run through the helper"));
    const argv = helperArgv(a.exec, "claude-print", p.system === undefined ? [p.model] : [p.model, p.system]);
    return run(argv.slice(1), { ...call, env });
  };
}

// The commit name of the agents' account (strong protection): the same name and e-mail as the
// console's (the Set-up step "commit name"), through the helper's git-identity, so that the
// agents' own commits are the user's. True: set.
export function agentGitIdentity(a: { exec: AgentExec; env: Env }, name: string, email: string, run: typeof execFile = execFile): Promise<boolean> {
  const argv = helperArgv(a.exec, "git-identity", [name, email]);
  return new Promise((done) => {
    run(argv[0], argv.slice(1), { env: helperEnv(a.env) as unknown as NodeJS.ProcessEnv, timeout: STATUS_MS }, (err) => done(!err));
  });
}

// The second account's git config names the agent folder of one of its homes as safe, through
// that account's helper (git-safe; chief/homes.ts prepareHome). Rejects with the helper's line.
export function agentGitSafe(x: AgentExec, dir: string, run: typeof execFile = execFile): Promise<void> {
  const argv = helperArgv(x, "git-safe", [dir]);
  return new Promise((done, fail) => {
    run(argv[0], argv.slice(1), { env: helperEnv(process.env) as unknown as NodeJS.ProcessEnv, timeout: STATUS_MS }, (err, _out, stderr) => {
      if (err) fail(new Error(String(stderr ?? "").trim().split("\n").pop()?.slice(0, 300) || err.message.split("\n")[0]));
      else done();
    });
  });
}
