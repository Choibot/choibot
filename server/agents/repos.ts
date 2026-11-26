// server/agents/repos.ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { gitHardened, runGit } from "./git.js";

export type RepoInfo = { name: string; path: string; branch: string };

// Rewrite a credential-less GitHub HTTPS clone URL to its SSH equivalent so the
// clone authenticates with the machine's SSH key instead of prompting for a
// username/password — which fails non-interactively ("could not read Username")
// on private repos. Left unchanged: URLs that already embed credentials
// (https://user:token@github.com/…), non-HTTPS schemes (git@…, ssh://, local
// paths), and anything not on github.com.
export function normalizeCloneUrl(url: string): string {
  const t = (url ?? "").trim();
  // Anchored to a bare `https://github.com/` host (no userinfo, since that would
  // put an `@` before the host) followed by exactly owner/repo.
  const m = /^https:\/\/github\.com\/([^/@:]+\/[^/@:]+?)(?:\.git)?\/?$/.exec(t);
  return m ? `git@github.com:${m[1]}.git` : t;
}

// List immediate subdirectories of `workspaceDir` that are git repositories,
// each with its current branch (HEAD). Non-git directories are skipped.
export async function listRepos(workspaceDir: string): Promise<RepoInfo[]> {
  let entries: string[] = [];
  try {
    entries = (await readdir(workspaceDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const repos: RepoInfo[] = [];
  for (const name of entries) {
    const path = join(workspaceDir, name);
    try {
      const { stdout } = await runGit(path, ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], undefined, path);
      repos.push({ name, path, branch: stdout.trim() });
    } catch {
      // `rev-parse HEAD` fails on a freshly-inited repo with no commits yet.
      // Fall back to the unborn branch name so empty repos are still listed;
      // genuinely non-git directories make this fail too and are skipped.
      try {
        const { stdout } = await runGit(path, ["-C", path, "symbolic-ref", "--short", "HEAD"], undefined, path);
        repos.push({ name, path, branch: stdout.trim() });
      } catch {
        // not a git repository — skip
      }
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return repos;
}

// Best-effort `git fetch` of every remote so tracking refs are current. A
// failure (offline / no remote) is swallowed — callers degrade to cached refs.
async function fetchAll(repoPath: string): Promise<void> {
  try {
    await runGit(repoPath, ["-C", repoPath, "fetch", "--all", "--prune"], { timeout: 15000 }, repoPath);
  } catch { /* offline or no remote */ }
}

// Fast-forward a local branch to its upstream when it has cleanly fallen behind,
// so work forked from it starts on the latest remote state instead of a stale
// local copy. Best-effort and non-destructive: it only ever fast-forwards (never
// rewrites local-only commits) and leaves the branch untouched when it has no
// upstream, is already current, has diverged or is ahead, or can't be moved
// (e.g. it's the working tree's branch with uncommitted changes).
async function fastForwardToUpstream(repoPath: string, branch: string): Promise<void> {
  let upstream = "";
  try {
    const { stdout } = await runGit(repoPath, [
      "-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`,
    ], undefined, repoPath);
    upstream = stdout.trim();
  } catch {
    return; // no upstream configured
  }
  if (!upstream) return;
  // Strict fast-forward only: local must be an ancestor of upstream (behind, not
  // diverged or ahead). `--is-ancestor` exits 0 when true, non-zero otherwise.
  try {
    await runGit(repoPath, ["-C", repoPath, "merge-base", "--is-ancestor", branch, upstream], undefined, repoPath);
  } catch {
    return; // diverged or ahead — preserve local commits, leave it
  }
  try {
    const [{ stdout: a }, { stdout: b }] = await Promise.all([
      runGit(repoPath, ["-C", repoPath, "rev-parse", branch], undefined, repoPath),
      runGit(repoPath, ["-C", repoPath, "rev-parse", upstream], undefined, repoPath),
    ]);
    if (a.trim() === b.trim()) return; // already up to date
  } catch {
    return;
  }
  // Move the ref. `git branch -f` works when the branch isn't checked out; when
  // it IS the working tree's current branch git refuses, so fall back to an
  // in-place fast-forward merge (which git allows only with a clean worktree).
  try {
    await runGit(repoPath, ["-C", repoPath, "branch", "-f", branch, upstream], undefined, repoPath);
  } catch {
    try {
      await runGit(repoPath, ["-C", repoPath, "merge", "--ff-only", upstream], undefined, repoPath);
    } catch { /* checked out + dirty, or other — leave stale, best effort */ }
  }
}

// Local heads + remote-tracking branches of a repo, most-recently-committed
// first. Runs a best-effort `git fetch` so the remote list is current; a fetch
// failure (offline / no remote) is ignored and cached refs are listed instead.
export async function listBranches(repoPath: string): Promise<{ local: string[]; remote: string[] }> {
  await fetchAll(repoPath);
  const refs = async (glob: string): Promise<string[]> => {
    try {
      const { stdout } = await runGit(repoPath, [
        "-C", repoPath, "for-each-ref", "--format=%(refname:short)",
        "--sort=-committerdate", glob,
      ], undefined, repoPath);
      return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  const local = await refs("refs/heads/");
  // Drop the symbolic `origin/HEAD` pointer — it's an alias, not a branch.
  const remote = (await refs("refs/remotes/")).filter((b) => !b.endsWith("/HEAD"));
  return { local, remote };
}

// The repo's default branch — what origin/HEAD points at (main, master, …) —
// as a base-branch candidate: the local name when it exists locally, else the
// `origin/<name>` tracking ref (which ensureBaseBranch materializes). When
// origin/HEAD isn't set (plain init, or a clone made before the remote's HEAD
// was recorded), fall back to a main/master that exists. Null when nothing
// resembling a default branch exists — callers fall back to the current HEAD.
export async function defaultBranch(repoPath: string): Promise<string | null> {
  let name = "";
  try {
    const { stdout } = await runGit(repoPath, [
      "-C", repoPath, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD",
    ], undefined, repoPath);
    name = stdout.trim().replace(/^refs\/remotes\/origin\//, "");
  } catch { /* origin/HEAD not set */ }
  for (const c of name ? [name] : ["main", "master"]) {
    if (await localExists(repoPath, c)) return c;
    if (await remoteRefExists(repoPath, `origin/${c}`)) return `origin/${c}`;
  }
  return null;
}

// Validate a branch name with git's own rules. Returns true if valid.
async function validBranchName(repoPath: string, name: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["check-ref-format", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

async function localExists(repoPath: string, name: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${name}`], undefined, repoPath);
    return true;
  } catch {
    return false;
  }
}

async function remoteRefExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], undefined, repoPath);
    return true;
  } catch {
    return false;
  }
}

// Resolve the user's base selection into a LOCAL, checkout-able branch name and
// create it if necessary (so reconcile's `git checkout <base>` works later).
//  - createFrom given         → create new branch `base` from that start point
//  - base is `remote/name`    → reuse local `name`, else create it tracking the remote
//  - otherwise                → an existing local branch, returned unchanged
export async function ensureBaseBranch(repoPath: string, base: string, createFrom?: string): Promise<string> {
  // Fetch first so the fork starts from the latest remote state, not whatever
  // was cached when the launcher's branch picker last loaded.
  await fetchAll(repoPath);
  if (createFrom) {
    if (!(await validBranchName(repoPath, base))) throw new Error(`invalid branch name: ${base}`);
    if (await localExists(repoPath, base)) throw new Error(`branch already exists: ${base}`);
    // If forking off a local branch, bring it up to date with its remote first.
    if (await localExists(repoPath, createFrom)) await fastForwardToUpstream(repoPath, createFrom);
    const start = await resolveStartPoint(repoPath, createFrom);
    await runGit(repoPath, ["-C", repoPath, "branch", base, start], undefined, repoPath);
    return base;
  }
  // No createFrom: an existing local branch, or a remote ref to materialize.
  if (await localExists(repoPath, base)) {
    await fastForwardToUpstream(repoPath, base);
    return base;
  }
  if (await remoteRefExists(repoPath, base)) {
    const name = base.slice(base.indexOf("/") + 1); // strip the remote name
    if (await localExists(repoPath, name)) return name;
    await runGit(repoPath, ["-C", repoPath, "branch", "--track", name, base], undefined, repoPath);
    return name;
  }
  // Fall through: treat as a local branch name (git will error at worktree-add
  // if it truly doesn't exist, surfacing a clear message).
  return base;
}

// A start point may be a local branch or a `remote/name` tracking ref; both are
// valid commit-ish args to `git branch <new> <start>`.
async function resolveStartPoint(repoPath: string, ref: string): Promise<string> {
  if (await localExists(repoPath, ref)) return ref;
  if (await remoteRefExists(repoPath, ref)) return ref;
  throw new Error(`unknown start point: ${ref}`);
}

// A clone url a hardened deployment takes (fix round 2, item 3): https://,
// ssh:// or scp-like user@host:path, neither user nor host starting with "-".
// Never a local path, file://, ext:: or another transport: a non-USER caller
// must not make the console copy a repo it can read into the workspace.
const NETWORK_URL = /^(?:(?:https|ssh):\/\/[A-Za-z0-9_][^\s]*|[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+)$/;

// The argv of the POST /api/repos clone (url already normalized). Not
// hardened: today's argv. Hardened: "--" before the url, and null (refused)
// for a url that is not a network url (a leading "-" included).
export function cloneArgv(url: string, dest: string, env: Record<string, string | undefined> = process.env): string[] | null {
  if (!gitHardened(env)) return ["clone", url, dest];
  return NETWORK_URL.test(url) ? ["clone", "--", url, dest] : null;
}
