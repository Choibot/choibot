// server/agents/git.ts — console git calls in a hardened deployment (Task
// 2c-6; spec §3, overview decisions 36 and 44). The console runs git as its
// own uid inside repos an agent can write: hooks, core.fsmonitor, textconv and
// external diff drivers there would run agent code as the console. In a
// hardened deployment every console git (and gh, whose git inherits the env)
// gets config overrides through GIT_CONFIG_COUNT/KEY_n/VALUE_n and, on diff
// output, --no-textconv --no-ext-diff. No safe.directory (ruling 2c-6-a): a
// repo, gitdir or worktree dir the console does not own fails closed with
// git's own "dubious ownership" refusal, since config keys no override covers
// (filter, merge drivers, protocol, ...) would still run its code. A
// gitlink's nested repo is never asked (fix round 2, item 1): git asks it
// through a child git under an explicit GIT_DIR, which skips the ownership
// check. Where the call site knows the main repo, GIT_COMMON_DIR pins the
// common dir (ruling 2c-6-d): a planted <gitdir>/commondir file would move
// the config git reads past the ownership check. Otherwise argv and env stay
// exactly as today, so the user's own hooks and /etc/gitconfig keep working.
import { execFile, execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hardenedDeployment } from "../chief/hardened.js";
import type { Env } from "../chief/paths.js";
import { githubEnv, gitTalksToRemote } from "../gh/handoff.js";

const execFileP = promisify(execFile);

// Ruling P4: the one hardened-deployment predicate, not a second definition.
export const gitHardened = hardenedDeployment;

// Plan Global Constraints, in this order, less safe.directory (ruling
// 2c-6-a); then the submodule keys (fix round 2, item 1), a second layer for
// the git gh runs, which gets no gitArgs (a .gitmodules
// submodule.<name>.ignore beats diff.ignoreSubmodules there: a residual);
// then no auto-gc or auto-maintenance (ruling H1-a: an agent can fill
// .git/objects/ with loose objects and plant objects/info/commit-graph as a
// symlink; the auto-gc a console commit, merge or fetch starts writes the
// commit-graph through it). The console user's own global credential
// helpers follow (ruling 2c-6-b).
const OVERRIDES: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", ""],
  ["core.sshCommand", "ssh"],
  ["credential.helper", ""],
  ["diff.external", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["diff.ignoreSubmodules", "all"],
  ["fetch.recurseSubmodules", "false"],
  ["submodule.recurse", "false"],
  ["push.recurseSubmodules", "no"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
];
const CONFIG_ENV_KEY = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;
// Checklist hold item 1 (reflog symlinks): the reflog action of every
// hardened console git and gh call. git puts its own text in a reflog line
// ("merge <branch>: …", "checkout: moving from <a> to <b>") only when
// GIT_REFLOG_ACTION is unset; set, the line holds this fixed text instead of
// an agent-chosen ref name, whatever file a planted symlink sends it to.
const REFLOG_ACTION = "choibot";

// Global options that take the next argument as their value.
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
// log options that make it print a diff (and so may run textconv).
const LOG_DIFF_FLAG = /^(-p|-u|-U\d*|--patch|--patch-with-(stat|raw)|--unified(=.*)?|--(num|short)?stat(=.*)?|--dirstat(=.*)?|--compact-summary|--cc|-c|--remerge-diff|--word-diff(=.*)?|--color-words(=.*)?|--check|-[SGL].+)$/;
const NO_DRIVERS = ["--no-textconv", "--no-ext-diff"];
const NO_SUBMODULES = "--ignore-submodules=all";
const NO_RECURSE = "--no-recurse-submodules";
// What goes right after each subcommand (log: only with a diff option). The
// CLI flag beats a .gitmodules submodule.<name>.ignore; a config key does not.
// checkout -q: a branch switch reports local changes through each gitlink's
// nested repo, unless quiet.
const INSERT: Record<string, readonly string[]> = {
  diff: [...NO_DRIVERS, NO_SUBMODULES],
  show: NO_DRIVERS,
  status: [NO_SUBMODULES],
  fetch: [NO_RECURSE],
  pull: [NO_RECURSE],
  push: [NO_RECURSE],
  checkout: ["-q"],
};

// Hardened: args with INSERT[subcommand] right after the subcommand (for log,
// --no-textconv --no-ext-diff when a diff-printing option comes before any
// --). Not hardened: args itself. repoPath is the repo the call runs in, as
// for gitEnv; the argv does not depend on it.
export function gitArgs(repoPath: string, args: string[], env: Env = process.env): string[] {
  if (!gitHardened(env)) return args;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += GLOBAL_WITH_VALUE.has(args[i]) ? 2 : 1;
  const sub = args[i];
  if (sub === undefined) return args;
  const end = args.indexOf("--", i + 1);
  const opts = args.slice(i + 1, end < 0 ? args.length : end);
  const add = sub === "log" ? (opts.some((a) => LOG_DIFF_FLAG.test(a)) ? NO_DRIVERS : []) : (INSERT[sub] ?? []);
  return add.length > 0 ? [...args.slice(0, i + 1), ...add, ...args.slice(i + 1)] : args;
}

// The console user's own global credential helpers (ruling 2c-6-b): every
// credential.*helper entry of its global config (a console-owned file), in
// order, with its exact key and value, include.path followed. Read once, on
// the first hardened gitEnv, with the console's env; cached for the process,
// a failed read (none) too: no blocking read per call after a failure. Not
// hardened: never read.
let consoleHelpers: (readonly [string, string])[] | null = null;
function consoleCredentialHelpers(): readonly (readonly [string, string])[] {
  if (consoleHelpers) return consoleHelpers;
  let out = "";
  try {
    out = execFileSync("git", ["config", "--global", "--includes", "--null", "--get-regexp", "^credential\\..*helper$"], {
      cwd: "/", encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
    });
  } catch { /* exit 1: no entry; any other failure: none either */ }
  // --null: "<key>\n<value>\0" per entry; a key with no value ("<key>\0") is
  // no helper and is skipped.
  consoleHelpers = out.split("\0").flatMap((entry) => {
    const nl = entry.indexOf("\n");
    return nl < 0 ? [] : [[entry.slice(0, nl), entry.slice(nl + 1)] as const];
  });
  return consoleHelpers;
}

// Forget the cached global helpers: the next hardened git call reads them again. Tests, and each
// `gh auth setup-git` of the console that ends well (server/gh/setupgit.ts).
export function resetCredentialHelpers(): void {
  consoleHelpers = null;
}

// The common dir to pin for a main repo: <realpath(main)>/.git.
function commonDirOf(mainRepo: string): string {
  let real: string;
  try { real = realpathSync(mainRepo); } catch { real = resolve(mainRepo); }
  return join(real, ".git");
}

// Hardened: a copy of env with GIT_CONFIG_NOSYSTEM=1, GIT_REFLOG_ACTION =
// REFLOG_ACTION (an inherited one replaced) and, as
// GIT_CONFIG_COUNT/KEY_n/VALUE_n, exactly the override keys then the console
// user's global credential helpers (any inherited ones dropped). The
// credential.helper reset drops every helper so far (system, global, the
// repo's); the global ones come back after it, the repo's do not. With
// mainRepo (ruling 2c-6-d): GIT_COMMON_DIR=<realpath(mainRepo)>/.git, so git
// never reads a commondir file. Not hardened: env itself. `deploy` decides,
// not the child env: a caller may pass an allowlisted env with no CHIEF_*
// keys. repoPath is the repo the call runs in; the env does not depend on it
// (no safe.directory).
export function gitEnv(
  repoPath: string, env: NodeJS.ProcessEnv = process.env, deploy: Env = process.env, mainRepo?: string,
): NodeJS.ProcessEnv {
  if (!gitHardened(deploy)) return env;
  const out = { ...env };
  for (const k of Object.keys(out)) if (CONFIG_ENV_KEY.test(k)) delete out[k];
  const pairs = [...OVERRIDES, ...consoleCredentialHelpers()];
  pairs.forEach(([k, v], n) => {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  out.GIT_CONFIG_COUNT = String(pairs.length);
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_REFLOG_ACTION = REFLOG_ACTION;
  if (mainRepo) out.GIT_COMMON_DIR = commonDirOf(mainRepo);
  return out;
}

export type GitExecOpts = { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number };

// Exec options for a console git or gh run in repoPath. Not hardened: opts
// itself. Hardened: a copy whose env is gitEnv over opts.env (else
// process.env), with mainRepo pinned when given.
export function gitOpts<T extends GitExecOpts>(repoPath: string, opts: T, deploy: Env = process.env, mainRepo?: string): T {
  return gitHardened(deploy) ? { ...opts, env: gitEnv(repoPath, opts.env ?? process.env, deploy, mainRepo) } : opts;
}

// One console git run in repoPath (args include any -C), as
// promisify(execFile) gives it; mainRepo: the main repo it belongs to, when
// the call site knows it (ruling 2c-6-d). Not hardened, execFile gets exactly
// the arguments today's call sites passed: (args) or (args, opts).
// A call that talks to a remote (fetch, push, pull, ls-remote, clone), with the GitHub app switch
// on and an app token: its one git child gets GH_TOKEN, which gh's credential helper gives to git
// (server/gh/handoff.ts). Every other call: exactly as before.
export async function runGit(
  repoPath: string, args: string[], opts?: GitExecOpts, mainRepo?: string,
): Promise<{ stdout: string; stderr: string }> {
  const argv = gitArgs(repoPath, args);
  const tokenEnv = gitTalksToRemote(args) ? await githubEnv(opts?.env ?? process.env) : null;
  const o = tokenEnv ? { ...opts, env: tokenEnv } : opts;
  if (!gitHardened()) return o === undefined ? execFileP("git", argv) : execFileP("git", argv, o);
  return execFileP("git", argv, gitOpts(repoPath, o ?? {}, process.env, mainRepo));
}

// Hardened only (fix round 2, item 1): `git add` whose pathspec reaches a
// tracked gitlink asks its nested repo with a child `git status` under an
// explicit GIT_DIR (no ownership check), whatever .gitmodules says. So a
// console add stages on a private copy of the worktree's index (a
// console-owned temp file: the agent cannot add a gitlink between our look
// and git's), and leaves out every gitlink in that copy. fn gets the exec
// options (GIT_INDEX_FILE at the copy) and one `:(exclude,literal)<path>`
// pathspec per gitlink; the copy is gone after.
export async function withPrivateIndex<T>(
  path: string, mainRepo: string | undefined, fn: (p: { opts: GitExecOpts; excludes: string[] }) => Promise<T>,
): Promise<T> {
  const { stdout } = await runGit(path, ["-C", path, "rev-parse", "--git-path", "index"], undefined, mainRepo);
  const index = resolve(path, stdout.trim());
  const dir = await mkdtemp(join(tmpdir(), "choibot-index-"));
  try {
    const copy = join(dir, "index");
    let bytes: Buffer | null = null;
    try {
      // No symlink, no FIFO: a regular file, read from what was opened.
      const fh = await open(index, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await fh.stat()).isFile()) throw new Error(`git index ${index} is not a regular file`);
        bytes = await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch (e) {
      if (errCode(e) !== "ENOENT") throw e; // no index yet: git starts an empty one
    }
    if (bytes) await writeFile(copy, bytes, { mode: 0o600 });
    const opts: GitExecOpts = { env: { ...process.env, GIT_INDEX_FILE: copy } };
    const { stdout: staged } = await runGit(path, ["-C", path, "ls-files", "-s", "-z"], opts, mainRepo);
    const excludes = staged.split("\0")
      .filter((e) => e.startsWith("160000 "))
      .map((e) => `:(exclude,literal)${e.slice(e.indexOf("\t") + 1)}`);
    return await fn({ opts, excludes });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The main repo of `dir` for a route given only a path (the files routes,
// ruling 2c-6-d), from the layout the console made: walking up from dir (not
// above stop), the first dir holding .git. A .git directory: that dir. A
// .git file consoleUid owns (a worktree the console added), read from what
// was opened, naming a gitdir <main>/.git/worktrees/<id>: <main>. Anything
// else (an agent's gitfile, another layout, no .git): null.
export function mainRepoOf(dir: string, stop: string, consoleUid: number): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const dotgit = join(d, ".git");
    let st;
    try { st = lstatSync(dotgit); } catch { st = null; }
    if (st?.isDirectory()) return d;
    if (st) return worktreeMain(dotgit, consoleUid);
    if (d === resolve(stop) || d === dirname(d)) return null;
  }
}

function worktreeMain(gitfile: string, consoleUid: number): string | null {
  let fd: number;
  try { fd = openSync(gitfile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== consoleUid || st.size > 4096) return null;
    const m = /^gitdir: (.+)$/m.exec(readFileSync(fd, "utf8"));
    if (!m) return null;
    const worktrees = dirname(resolve(dirname(gitfile), m[1].trim()));
    if (basename(worktrees) !== "worktrees" || basename(dirname(worktrees)) !== ".git") return null;
    return dirname(dirname(worktrees));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const octal4 = (mode: number): string => mode.toString(8).padStart(4, "0");
const errCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : String(e);
};

// Checklist C1 in one repo: what keeps an agent with group write on the repo
// from changing the config or hooks the user's own git runs (and the drivers
// no override covers). Problems, in a fixed order; empty when none:
// - the top dir not group- or world-writable, or sticky (ruling 2c-6-c: with
//   write on it an agent renames .git itself and puts its own in place);
// - .git/config a regular file (not a symlink), owned by consoleUid, 0644;
// - .git/ owned by consoleUid, not group- or world-writable (ruling F4: the
//   console's git writes MERGE_MSG, SQUASH_MSG, gc.log … there by path, so
//   a planted symlink would aim it at any console file), with the sticky bit;
// - .git/hooks/ owned by consoleUid, not group- or world-writable (ruling
//   2c-6-c: no new hook), with the sticky bit;
// - .git/info/, when there is one, a directory not group- or world-writable
//   (info/exclude, info/attributes);
// - no .git/commondir (ruling 2c-6-d: a main repo has none; one moves the
//   config the user's own git reads);
// - .git/worktrees/ owned by consoleUid with the sticky bit, and each
//   .git/worktrees/<x>/ a directory owned by consoleUid. Not sticky: the
//   agent's own git replaces HEAD and index there (a rename over the
//   console-made files), which a sticky bit forbids;
// - when there is one (hold item 1, reflog symlinks): .git/logs/ a directory
//   owned by consoleUid, not group- or world-writable (else an agent swaps
//   logs/HEAD for a symlink the console's reflog line follows); .git/logs/HEAD
//   a regular file owned by consoleUid; .git/logs/refs/ and
//   .git/logs/refs/heads/ directories owned by consoleUid with the sticky bit
//   (group-writable: the agent's git logs its own branches there);
// - .git/objects/info/, when there is one (ruling H1-a), a directory owned by
//   consoleUid, not group- or world-writable (git writes commit-graph and
//   alternates there by path).
// Never throws.
export function checkRepoProtection(repo: string, consoleUid: number): string[] {
  const problems: string[] = [];
  const gitDir = join(repo, ".git");
  try {
    const mode = statSync(repo).mode & 0o7777;
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) {
      problems.push(`top dir is group- or world-writable (mode ${octal4(mode)}) and has no sticky bit`);
    }
  } catch (e) {
    problems.push(`top dir unreadable (${errCode(e)})`);
  }
  try {
    const st = lstatSync(join(gitDir, "config"));
    if (!st.isFile()) problems.push(".git/config is not a regular file");
    else {
      if (st.uid !== consoleUid) problems.push(`.git/config owner uid ${st.uid}, want ${consoleUid}`);
      const mode = st.mode & 0o7777;
      if (mode !== 0o644) problems.push(`.git/config mode ${octal4(mode)}, want 0644`);
    }
  } catch (e) {
    problems.push(`.git/config unreadable (${errCode(e)})`);
  }
  for (const [label, dir] of [[".git/", gitDir], [".git/hooks/", join(gitDir, "hooks")]] as const) {
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) {
        problems.push(`${label} is not a directory`);
        continue;
      }
      const mode = st.mode & 0o7777;
      if (st.uid !== consoleUid) problems.push(`${label} owner uid ${st.uid}, want ${consoleUid}`);
      if ((mode & 0o022) !== 0) problems.push(`${label} is group- or world-writable (mode ${octal4(mode)})`);
      if ((mode & 0o1000) === 0) problems.push(`${label} has no sticky bit`);
    } catch (e) {
      problems.push(`${label} unreadable (${errCode(e)})`);
    }
  }
  try {
    const st = lstatSync(join(gitDir, "info"));
    const mode = st.mode & 0o7777;
    if (!st.isDirectory()) problems.push(".git/info/ is not a directory");
    else if ((mode & 0o022) !== 0) problems.push(`.git/info/ is group- or world-writable (mode ${octal4(mode)})`);
  } catch (e) {
    if (errCode(e) !== "ENOENT") problems.push(`.git/info/ unreadable (${errCode(e)})`);
  }
  try {
    lstatSync(join(gitDir, "commondir"));
    problems.push(".git/commondir exists (a main repo has none)");
  } catch (e) {
    if (errCode(e) !== "ENOENT") problems.push(`.git/commondir unreadable (${errCode(e)})`);
  }
  const worktrees = join(gitDir, "worktrees");
  let names: string[] = [];
  try {
    const st = lstatSync(worktrees);
    if (!st.isDirectory()) problems.push(".git/worktrees/ is not a directory");
    else {
      if (st.uid !== consoleUid) problems.push(`.git/worktrees/ owner uid ${st.uid}, want ${consoleUid}`);
      if ((st.mode & 0o1000) === 0) problems.push(".git/worktrees/ has no sticky bit");
      names = readdirSync(worktrees).sort();
    }
  } catch (e) {
    if (errCode(e) !== "ENOENT") problems.push(`.git/worktrees/ unreadable (${errCode(e)})`);
  }
  for (const name of names) {
    const label = `.git/worktrees/${name}/`;
    try {
      const st = lstatSync(join(worktrees, name));
      if (!st.isDirectory()) problems.push(`${label} is not a directory`);
      else if (st.uid !== consoleUid) problems.push(`${label} owner uid ${st.uid}, want ${consoleUid}`);
    } catch (e) {
      problems.push(`${label} unreadable (${errCode(e)})`);
    }
  }
  const logs = join(gitDir, "logs");
  let logsDir = false;
  try {
    const st = lstatSync(logs);
    if (!st.isDirectory()) problems.push(".git/logs/ is not a directory");
    else {
      logsDir = true;
      const mode = st.mode & 0o7777;
      if (st.uid !== consoleUid) problems.push(`.git/logs/ owner uid ${st.uid}, want ${consoleUid}`);
      if ((mode & 0o022) !== 0) problems.push(`.git/logs/ is group- or world-writable (mode ${octal4(mode)})`);
    }
  } catch (e) {
    if (errCode(e) !== "ENOENT") problems.push(`.git/logs/ unreadable (${errCode(e)})`);
  }
  if (logsDir) {
    try {
      const st = lstatSync(join(logs, "HEAD"));
      if (!st.isFile()) problems.push(".git/logs/HEAD is not a regular file");
      else if (st.uid !== consoleUid) problems.push(`.git/logs/HEAD owner uid ${st.uid}, want ${consoleUid}`);
    } catch (e) {
      if (errCode(e) !== "ENOENT") problems.push(`.git/logs/HEAD unreadable (${errCode(e)})`);
    }
    // refs/ before refs/heads/; nothing below a refs/ that is not a directory.
    for (const [label, dir] of [[".git/logs/refs/", join(logs, "refs")], [".git/logs/refs/heads/", join(logs, "refs", "heads")]] as const) {
      let st;
      try {
        st = lstatSync(dir);
      } catch (e) {
        if (errCode(e) !== "ENOENT") problems.push(`${label} unreadable (${errCode(e)})`);
        break;
      }
      if (!st.isDirectory()) {
        problems.push(`${label} is not a directory`);
        break;
      }
      if (st.uid !== consoleUid) problems.push(`${label} owner uid ${st.uid}, want ${consoleUid}`);
      if ((st.mode & 0o1000) === 0) problems.push(`${label} has no sticky bit`);
    }
  }
  try {
    const st = lstatSync(join(gitDir, "objects", "info"));
    const mode = st.mode & 0o7777;
    if (!st.isDirectory()) problems.push(".git/objects/info/ is not a directory");
    else {
      if (st.uid !== consoleUid) problems.push(`.git/objects/info/ owner uid ${st.uid}, want ${consoleUid}`);
      if ((mode & 0o022) !== 0) problems.push(`.git/objects/info/ is group- or world-writable (mode ${octal4(mode)})`);
    }
  } catch (e) {
    if (errCode(e) !== "ENOENT") problems.push(`.git/objects/info/ unreadable (${errCode(e)})`);
  }
  return problems;
}
