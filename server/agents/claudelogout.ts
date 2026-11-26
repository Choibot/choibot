// server/agents/claudelogout.ts — "Sign out" of a Claude login, from the page (Settings, Claude
// accounts; the route is in agents/api.ts). Claude Code itself removes its login: the console
// runs `claude auth logout` for the config folder of that login. Basic protection: the Claude
// program of the agents, with the login's folder (accounts.ts claudeAccountEnv). Strong
// protection: through the exec helper, as the account of that login (agentlogin.ts,
// deploy/choibot-agent-exec claude-auth logout). The console never reads or keeps a token.
//
// What the official docs say of the command: "Log out from your Anthropic account"
// (code.claude.com/docs/en/cli-reference), and "Claude Code manages `.credentials.json` through
// `/login` and `/logout`" (…/authentication). They do not say what happens to the login at
// Anthropic, so the page says only that your server forgets the login.
import { execFile } from "node:child_process";
import { resolveClaudeBin } from "../defaults.js";
import { claudeAccountEnv, type AccountPaths } from "./accounts.js";
import { agentAuthCommand, type AgentAuth, type AuthCommand } from "./agentlogin.js";
import { STATUS_MS } from "./claudelogin.js";

type Env = Record<string, string | undefined>;

// Why a logout did not run to its end: the Claude program is not there, the server's helper is
// older than this console (it has no `logout` yet), or the command failed.
export type LogoutWhy = "no-claude" | "old-helper" | "failed";
export type LogoutRun = { ok: true } | { ok: false; why: LogoutWhy };

// The command of one logout. `auth`: strong protection, the helper of that login's account.
export function logoutCommand(o: { account: string; paths: AccountPaths; env?: Env; bin?: string; auth?: AgentAuth | null }): AuthCommand {
  if (o.auth) return agentAuthCommand(o.auth, "logout");
  const env = (o.env ?? process.env) as Env;
  return {
    bin: o.bin ?? resolveClaudeBin(env as NodeJS.ProcessEnv),
    args: ["auth", "logout"],
    env: { ...env, ...claudeAccountEnv(o.account, o.paths), NO_COLOR: "1", TERM: "dumb" } as unknown as NodeJS.ProcessEnv,
  };
}

// Run one logout. Nothing is read from its output but the helper's refusal of an unknown
// subcommand (deploy/choibot-agent-exec: "claude-auth: unknown subcommand: logout", exit 2).
export function runLogout(c: AuthCommand, o: { run?: typeof execFile; timeoutMs?: number } = {}): Promise<LogoutRun> {
  const run = o.run ?? execFile;
  return new Promise((done) => {
    const child = run(c.bin, c.args, { env: c.env, timeout: o.timeoutMs ?? STATUS_MS }, (err, _stdout, stderr) => {
      if (!err) return done({ ok: true });
      const code: unknown = (err as { code?: unknown }).code;
      if (code === "ENOENT" || code === "EACCES" || code === 127) return done({ ok: false, why: "no-claude" });
      if (code === 2 && /unknown subcommand: logout/.test(String(stderr ?? ""))) return done({ ok: false, why: "old-helper" });
      done({ ok: false, why: "failed" });
    });
    // The command reads nothing.
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}
