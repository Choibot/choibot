// bin/lib/strong.ts — `strong-setup`: the root set-up that makes a NEW server start in strong
// protection (server/chief/hardened.ts). Agents then run under their own Linux account, so an
// agent cannot read the console's device keys, settings or data. It does, for one server, the
// root steps of the hardening checklist (C1-C7): the agent account and the shared group, the tools both accounts run, the folders and
// their modes, the exec helper with its config and its sudoers line, and the console's settings.
//
//   strong-setup --user <console user> --dry-run   print the plan; change nothing
//   strong-setup --user <console user>             run it (as root)
//   strong-setup --print-facts                     (as the console user) the facts the plan needs
//
// Two halves. The facts come from the console's own user, through the product's own path
// functions (data dirs, workspace, tools): no path is guessed twice. Root trusts none of them as
// they come: every field is checked (a strict shape), and the uid and the home are root's own
// lookup. The plan is a pure function of the checked facts (the unit tests read it). Root runs
// each action with argv and no shell, and stops at the first one that fails. Every step can run
// again: an action whose state is there already is skipped by its `unless` check.
//
// The rule of who does what: an action on a path that the console user can change (its home,
// the code, the workspace, the widget folder, the settings file, the sources of the tools) runs
// AS that user (runuser), so a symbolic link there gives it nothing more than its own rights.
// Root acts only on root's paths: the accounts, /usr/local, /etc, /srv, /run. The tools are read
// by the user and written by root into a root folder (the Node folder as a tar stream).
//
// For a new server (an image build), before any agent runs: root runs the product's code from a
// checkout that the console user can write. On a server where agents already ran, the set-up
// refuses unless the person accepts that (--accept-used-server; deploy/RUNBOOK.md says what it
// means). It refuses an install with the old names, and code, a workspace or a widget folder
// inside the console user's home (the agents must reach them, never the home). Debian or Ubuntu
// (apt-get). The Claude login of the agents is not here: the Set-up page makes it, through the
// helper's claude-auth verb (server/agents/agentlogin.ts).
//
// The second account (server/chief/chiefaccount.ts): the fleet master, the leads and the
// Coordinator run as their own account, which the workers' account cannot enter: its group, its
// homes folder (AGENT_HOME_ROOT/chief), its socket folder, its line in the sudoers file, its keys
// in the helper's config and in the console's settings. Its Claude login is a second sign-in on
// the Set-up page. On a server with persistent agents of the old layout (they ran as the workers'
// account) the set-up stops before any change: their move is not built yet. At the end the
// console starts again (a new group reaches a process only at its start), and the check reads
// the state after that start.
//
// Root's part (the check of the facts, the plan and its run) is bin/lib/strong-root.ts: one file
// with Node's own modules only, so that root can run it with plain Node from a root copy of a
// release (H4: the update of the root parts). This file holds the console user's half (the facts,
// through the product's own path functions) and the command of a checkout or an archive install.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveChiefDataDir } from "../../server/chief/paths.js";
import { resolveAppDataDir, resolveClaudeBin, resolveDtachBin, resolveWorkspaceDir, toolBin, type Env } from "../../server/defaults.js";
import { isChiefId } from "../../server/chief/chiefids.js";
import { resolveIssuesDataDir } from "../../server/issues/paths.js";
import { resolveMasterDataDir } from "../../server/master/paths.js";
import { names } from "../../server/names.mjs";
import { resolveCronDataDir } from "./cronspec.js";
import { parseEnv } from "./env.js";
import { agentDataDir, servicesDataDir, settingsFile, widgetsDataDir } from "../../server/layout.js";
import {
  RECORDS_MAX, STRONG_DEFAULTS, USER_RE, applyPlan, checkFacts, findOldHomes, lookupUser, okPath, planText, readFacts, realExec, realPipe, strongPlan,
  type Exec, type Pipe, type StrongFacts, type StrongOpts,
} from "./strong-root.js";

export * from "./strong-root.js";

// ------------------------------------------------------------------ the facts

// The persistent records of the console user's own record folder (server/agents/store.ts: one
// <id>.json per agent). A file it cannot read or parse is left out.
export function persistentRecords(dir: string): { id: string; cwd: string }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { id: string; cwd: string }[] = [];
  for (const n of names.sort()) {
    const id = n.endsWith(".json") ? n.slice(0, -5) : "";
    if (!isChiefId(id) || out.length >= RECORDS_MAX) continue;
    try {
      const cwd = (JSON.parse(readFileSync(join(dir, n), "utf8")) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string") out.push({ id, cwd });
    } catch { /* not a record */ }
  }
  return out;
}

const real = (p: string): string | null => {
  if (!isAbsolute(p) || !existsSync(p)) return null;
  try { return realpathSync(p); } catch { return null; }
};

// As the console user, from its checkout: the settings file over the env of the shell.
export function strongFacts(repoDir: string, shell: Env = process.env): StrongFacts {
  const envFile = settingsFile(repoDir);
  const env: Env = { ...shell, ...(existsSync(envFile) ? Object.fromEntries(parseEnv(readFileSync(envFile, "utf8"))) : {}) };
  const inApp = (v: string | undefined, def: string) => resolve(repoDir, v?.trim() || def);
  const base = dirname(repoDir);
  const wt = env.AGENT_WORKTREE_ROOT?.trim() ?? "";
  const agentData = agentDataDir(env, repoDir);
  return {
    user: userInfo().username, uid: process.getuid?.() ?? -1, home: homedir(),
    legacy: names().legacy,
    app: repoDir, envFile,
    privateDirs: [...new Set([
      resolveAppDataDir(env), resolveChiefDataDir(env), resolveCronDataDir(env), resolveMasterDataDir(env), resolveIssuesDataDir(env),
      agentData, servicesDataDir(env, repoDir),
    ])],
    privateFiles: ["install.log", "failed-step.log"].map((f) => join(base, f)).filter((f) => existsSync(f)),
    widgetsDir: widgetsDataDir(env, repoDir),
    workspace: resolveWorkspaceDir(env),
    worktreeRoot: isAbsolute(wt) ? wt : null,
    agentDataDir: agentData, claudeDir: env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
    nodeDir: dirname(dirname(process.execPath)),
    claude: real(resolveClaudeBin(env)), gh: real(toolBin("gh", undefined, env)), dtach: real(resolveDtachBin(env)),
    unit: names().unit, persistent: persistentRecords(agentData),
  };
}

// ------------------------------------------------------------------ the command

export type StrongCmd = {
  repoDir: string; user?: string; dryRun?: boolean; printFacts?: boolean; factsFile?: string; acceptUsed?: boolean;
  isRoot?: boolean; exec?: Exec; out?: (s: string) => void; err?: (s: string) => void;
  // The read of the facts as the console user (a test's stand-in; default: a pipe with a cap).
  pipe?: Pipe;
  // A test's stand-in for root's look at the homes' folder.
  findOldHomes?: (o: StrongOpts, consoleUid: number) => string[];
};

// A test's exec as the pipe of the facts.
const execPipe = (exec: Exec): Pipe => async (argv, o) => exec(argv, { as: o.as });

export async function runStrongSetup(c: StrongCmd): Promise<number> {
  const out = c.out ?? ((s: string) => console.log(s));
  const err = c.err ?? ((s: string) => console.error(s));
  if (c.printFacts) { out(JSON.stringify(strongFacts(c.repoDir))); return 0; }
  const root = c.isRoot ?? process.getuid?.() === 0;
  const exec = c.exec ?? realExec;
  const user = c.user ?? (root ? undefined : userInfo().username);
  if (!user) { err("Give --user <the user of the console>."); return 2; }
  if (!USER_RE.test(user)) { err("✖ --user is not a user name."); return 2; }
  if (c.factsFile && !c.dryRun) { err("✖ A file of facts is for the dry run only."); return 2; }
  if (!c.dryRun && !root) { err("✖ The set-up changes users, folders and sudo rules: run it as root. To read the plan: --dry-run."); return 1; }
  try {
    let raw: unknown;
    if (c.factsFile) raw = JSON.parse(readFileSync(c.factsFile, "utf8"));
    else if (user === userInfo().username) raw = strongFacts(c.repoDir);
    else if (root) raw = undefined;
    else { err(`✖ To read the facts of ${user}, run this as root, or as ${user}.`); return 1; }
    let who = lookupUser(user, exec);
    if (!who) {
      // A dry run on another machine, from a file: its uid and home stand in for the lookup.
      const f = raw as { uid?: unknown; home?: unknown } | undefined;
      if (!(c.dryRun && c.factsFile && typeof f?.uid === "number" && okPath(f?.home))) { err(`✖ There is no account ${user} on this server.`); return 1; }
      who = { user, uid: f.uid, home: f.home };
      out(`(dry run: no account ${user} here; the uid and the home of the file stand in)`);
    }
    if (raw === undefined) raw = await readFacts(c.pipe ?? (c.exec ? execPipe(c.exec) : realPipe), user, who.home, c.repoDir, `${dirname(process.execPath)}:/usr/bin:/bin`);
    const facts = checkFacts(raw, who);
    if ("refused" in facts) { err(`✖ The facts are refused: ${facts.refused}.`); return 1; }
    const opts: StrongOpts = { ...STRONG_DEFAULTS, acceptUsed: c.acceptUsed === true };
    // Root's own look at the homes' folder (the dry run too: it shows the stop of the old layout).
    const steps = strongPlan(facts, opts, { oldHomes: (c.findOldHomes ?? findOldHomes)(opts, who.uid) });
    if (c.dryRun) { out(planText(steps)); return 0; }
    return applyPlan(steps, { exec, envFile: facts.envFile, log: out, opts });
  } catch (e) {
    err(`✖ ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
