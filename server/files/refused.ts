// server/files/refused.ts — what no file route serves (server/files/api.ts),
// to any caller, in every mode: the console's own .env and its .env.* copies
// in the checkout (.env.example aside), the console's data dirs, the console
// user's credential stores and git internals (.git/config can hold a token in
// a remote URL). Checked on real paths, so a symlink to one is refused too.
// The routes serve nothing outside WORKSPACE_DIR anyway: these rules matter
// when the checkout, a data dir or HOME sits inside it. An agent's worktree,
// its own .env included, stays readable.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveChiefDataDir } from "../chief/paths.js";
import { resolveCronDataDir } from "../../bin/lib/cronspec.js";
import { resolveIssuesDataDir } from "../issues/paths.js";
import { resolveMasterDataDir } from "../master/paths.js";
import { agentDataDir, servicesDataDir, settingsFile } from "../layout.js";

type Env = Record<string, string | undefined>;

// Under HOME: the console user's logins and keys.
const HOME_STORES = [
  ".ssh", ".gnupg", ".aws", ".docker", ".netrc", ".git-credentials", ".npmrc", ".pgpass",
  ".claude", ".claude.json", ".claude-accounts", ".codex", ".config/gh", ".config/choibot",
];
// Anywhere: a path through one of these dirs, or a file of one of these names.
const SECRET_DIRS = new Set([".git", ".ssh", ".gnupg"]);
const SECRET_NAMES = new Set([".git-credentials", ".netrc", ".credentials.json"]);
// Env pointers to Claude and Codex config dirs (logins), when set.
const CONFIG_DIR_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_ACCOUNTS_DIR", "CODEX_HOME", "AGENT_CLAUDE_CONFIG_DIR", "AGENT_CHIEF_CLAUDE_CONFIG_DIR"];

export type Refusal = { checkout: string; dirs: string[] };

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

// p is root or inside it: path boundaries, not string prefixes.
function within(p: string, root: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The refused places, resolved once (real paths; a dir that does not exist
 * yet keeps its resolved path). checkout: the console's own checkout (the
 * server's cwd); env: the console env.
 */
export function refusalFor(o: { env?: Env; checkout?: string } = {}): Refusal {
  const env = o.env ?? process.env;
  const checkout = resolve(o.checkout ?? process.cwd());
  const home = env.HOME || homedir();
  const dirs = [
    resolveChiefDataDir(env), resolveCronDataDir(env), resolveIssuesDataDir(env), resolveMasterDataDir(env),
    // The agent records (hook tokens) and the service records, and the settings file: where this
    // install's layout keeps them (server/layout.ts; in the checkout, or outside it in a release).
    agentDataDir(env, checkout), servicesDataDir(env, checkout), settingsFile(checkout),
    ...HOME_STORES.map((s) => join(home, s)),
    ...CONFIG_DIR_KEYS.map((k) => env[k]?.trim() ?? "").filter((d) => isAbsolute(d)),
  ];
  return { checkout: real(checkout), dirs: [...new Set(dirs.map(real))] };
}

/** Whether a real (or, for a result row, lexical) absolute path is refused. */
export function isRefused(p: string, r: Refusal): boolean {
  if (p.split(sep).some((c) => SECRET_DIRS.has(c))) return true;
  const name = basename(p);
  if (SECRET_NAMES.has(name)) return true;
  if (dirname(p) === r.checkout && name.startsWith(".env") && name !== ".env.example") return true;
  return r.dirs.some((d) => within(p, d));
}

export const REFUSED_TEXT = "refused: a console secret or data path";
