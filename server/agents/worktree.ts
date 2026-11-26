// server/agents/worktree.ts
import { gitHardened, runGit, withPrivateIndex } from "./git.js";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ensureChoiBotExcluded } from "./upload.js";
import { names } from "../names.mjs";

// The hook settings file of an agent in its worktree (.choibot-hooks.json on an install with the
// old names): internal, never a change of the agent.
const HOOKS_FILE = names().hooksFile;

export async function createWorktree(opts: {
  repo: string; baseBranch: string; branch: string; root: string; dirName?: string;
}): Promise<{ path: string; branch: string }> {
  // The on-disk directory is derived from `dirName` (callers pass a unique one
  // for user-named branches so two agents on similarly-named branches don't
  // collide); the git branch itself keeps the name the user chose, slashes and
  // all.
  const safe = (opts.dirName ?? opts.branch).replace(/[^\w.-]+/g, "-");
  // Resolve to an absolute path. A relative root would otherwise be interpreted
  // relative to the repo by git (where the worktree physically lands) but relative
  // to the server's cwd by the SDK when used as the agent's `cwd` — that mismatch
  // makes the SDK spawn the CLI in a non-existent directory and fail to launch.
  const root = isAbsolute(opts.root) ? opts.root : resolve(opts.repo, opts.root);
  const path = join(root, safe);
  // Reuse the branch if it already exists (so a name the user picked is checked
  // out as-is); otherwise fork a fresh branch from the base. Either way the
  // worktree lands on `branch`. Git refuses when the branch is already checked
  // out in another worktree — that error propagates so the caller can surface it.
  if (await branchExists(opts.repo, opts.branch)) {
    await runGit(opts.repo, ["-C", opts.repo, "worktree", "add", path, opts.branch], undefined, opts.repo);
  } else {
    const start = await latestStartPoint(opts.repo, opts.baseBranch);
    await runGit(opts.repo, ["-C", opts.repo, "worktree", "add", "-b", opts.branch, path, start], undefined, opts.repo);
  }
  try {
    await ensureChoiBotExcluded(path, opts.repo);
  } catch {
    /* Not fatal, but not cosmetic either: .choibot/ holds a Codex agent's whole
       generated CODEX_HOME (skill symlinks, plugin cache, config.toml, a
       symlink to ~/.codex/auth.json). Failing here only costs the exclude
       layer — commitPending in reconcile.ts also unstages .choibot after `add -A` — so the
       worktree still comes up rather than the launch failing outright. */
  }
  return { path, branch: opts.branch };
}

// Strong protection (agentclone.ts): the commit an agent's own clone starts its branch at, as a
// sha of the console's repo: the branch's tip when the console's repo has the branch (the user
// named one), else the start point of a new branch (below).
export async function startCommit(repo: string, baseBranch: string, branch: string): Promise<string> {
  const ref = (await branchExists(repo, branch)) ? `refs/heads/${branch}` : await latestStartPoint(repo, baseBranch);
  const { stdout } = await runGit(repo, ["-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], undefined, repo);
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no start commit for ${branch}`);
  return sha;
}

// The commit a NEW agent branch forks from: the base's remote tracking ref
// whenever it has commits the local copy lacks, else the local base itself.
// The local base can't always be fast-forwarded (it may be checked out with a
// dirty tree, or have DIVERGED — stale squash-merge artifacts are common when
// PRs merge on the remote), but the fork's start point is ours to choose: an
// agent must start from what's actually merged upstream, not a laptop-local
// copy that's missing PRs. When the local base is up to date or strictly
// ahead (unpushed work), it wins. Callers fetch first (ensureBaseBranch), so
// the tracking ref is current.
async function latestStartPoint(repo: string, base: string): Promise<string> {
  const remote = await remoteTrackingRef(repo, base);
  if (!remote) return base;
  try {
    const { stdout } = await runGit(repo, ["-C", repo, "rev-list", "--count", `${base}..${remote}`], undefined, repo);
    return Number(stdout.trim()) > 0 ? remote : base;
  } catch {
    return base; // e.g. base doesn't exist locally — let worktree-add surface it
  }
}

// The base's configured upstream, falling back to origin/<base> when no
// upstream was set (a plain `git push origin` without -u is common).
async function remoteTrackingRef(repo: string, base: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repo, [
      "-C", repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", `${base}@{upstream}`,
    ], undefined, repo);
    if (stdout.trim()) return stdout.trim();
  } catch { /* no upstream configured */ }
  try {
    await runGit(repo, ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], undefined, repo);
    return `origin/${base}`;
  } catch {
    return null;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await runGit(repo, ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], undefined, repo);
    return true;
  } catch {
    return false;
  }
}

// Validate a user-supplied branch name with git's own ref rules, plus a few
// belt-and-braces checks. Returns the trimmed name, or null if unusable.
export function validBranchName(name: string): string | null {
  const t = (name ?? "").trim();
  if (!t || t.startsWith("-") || t.startsWith("/") || t.endsWith("/") || t.includes("..") || /\s/.test(t)) {
    return null;
  }
  // git refname rules: no ~ ^ : ? * [ \, no control chars, no "@{".
  if (/[~^:?*\[\\\x00-\x1f]/.test(t) || t.includes("@{")) return null;
  return t;
}

// Final review C1 (hardened only): git writes `branch: Created from <start>`
// to a new branch's reflog and ignores GIT_REFLOG_ACTION there, and an agent
// can plant that reflog as a symlink to a console file. So in a hardened
// deployment every branch, base or start name the console creates a branch
// from is plain ref text: [A-Za-z0-9._/-] only, no leading "-".
const PLAIN_REF = /^[A-Za-z0-9._/-]+$/;
export function plainRefName(name: string): boolean {
  return PLAIN_REF.test(name) && !name.startsWith("-");
}

// The 400 text for the first named field a hardened deployment refuses, or
// null. An absent or empty field passes. Not hardened: always null, so
// today's checks are the only ones.
export function hardenedRefRefusal(fields: Record<string, unknown>, env: Record<string, string | undefined> = process.env): string | null {
  if (!gitHardened(env)) return null;
  for (const [field, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !plainRefName(v)) {
      return `invalid ${field}: only letters, digits, ".", "_", "/" and "-" (not first) in a hardened deployment`;
    }
  }
  return null;
}

// The branch the worktree currently has checked out, or null when detached.
// main (here and below): the agent's main repo (its record's `repo`), which
// a hardened deployment pins as the common dir (ruling 2c-6-d).
export async function worktreeHeadBranch(path: string, main?: string): Promise<string | null> {
  try {
    return (await gitLine(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], main)) || null;
  } catch {
    return null;
  }
}

// A short, human label for where HEAD points: the branch name, or
// "detached @<sha>" when HEAD isn't on a branch, or null when the worktree
// can't be read (e.g. removed). Used by the sidebar to show each agent's HEAD.
export async function worktreeHeadLabel(path: string, main?: string): Promise<string | null> {
  const branch = await worktreeHeadBranch(path, main);
  if (branch) return branch;
  try {
    const sha = await gitLine(path, ["rev-parse", "--short", "HEAD"], main);
    return sha ? `detached @${sha}` : null;
  } catch {
    return null;
  }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await runGit(repo, ["-C", repo, "worktree", "remove", "--force", path], undefined, repo);
}

// Full unified diff covering committed work, uncommitted tracked edits, AND
// new untracked files — relative to the fork point.
export async function worktreeDiff(path: string, baseBranch: string, main?: string): Promise<string> {
  // merge-base as a single diff arg compares it against the WORKING TREE, so
  // uncommitted changes are included (a `<base>...` range shows only commits).
  const { stdout: mbOut } = await runGit(path, ["-C", path, "merge-base", baseBranch, "HEAD"], undefined, main);
  const mb = mbOut.trim();
  if (gitHardened()) return hardenedDiff(path, mb, main);
  // `git diff` omits untracked files. To show new files an agent created, mark
  // them intent-to-add (scoped to exactly those paths, excluding the internal
  // hook file), diff, then undo the intent-to-add so the index is untouched.
  let untracked: string[] = [];
  try {
    const { stdout } = await runGit(path, ["-C", path, "ls-files", "--others", "--exclude-standard"], undefined, main);
    untracked = stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== HOOKS_FILE);
  } catch { /* leave empty */ }
  if (untracked.length) {
    try { await runGit(path, ["-C", path, "add", "-N", "--", ...untracked], undefined, main); } catch { /* best effort */ }
  }
  try {
    const { stdout } = await runGit(path, ["-C", path, "diff", mb], undefined, main);
    return stdout;
  } finally {
    if (untracked.length) {
      try { await runGit(path, ["-C", path, "reset", "-q", "--", ...untracked], undefined, main); } catch { /* best effort */ }
    }
  }
}

// A snapshot of where the worktree's git actually IS right now — its live HEAD,
// how that relates to the agent's intended branch + base, and any work parked
// off to the side (staged/unstaged/untracked/stashed). This is what reveals the
// two confusing cases: HEAD switched to an unrelated branch (a phantom diff) and
// work stashed away (an empty diff that hides real changes).
export type GitState = {
  head: string;        // current branch name; "" when detached
  detached: boolean;
  sha: string;         // short HEAD sha
  trackedBranch: string; // the branch the console created for this agent
  baseBranch: string;  // the fork point the diff is measured against
  onTracked: boolean;  // HEAD is the agent's own branch (not drifted)
  ahead: number;       // commits HEAD has that base does not
  behind: number;      // commits base has that HEAD does not
  staged: number;      // tracked files staged in the index
  unstaged: number;    // tracked files with unstaged edits
  untracked: number;   // new files (excluding the internal hook file)
  stashes: { ref: string; message: string }[]; // repo-wide stash entries
  error: boolean;      // git failed (e.g. not a repo) — fields are best-effort
};

// Hardened (fix round 2, item 1): the same intent-to-add trick on a private
// copy of the index, every gitlink left out; the worktree's own index is
// never touched, so there is nothing to undo.
async function hardenedDiff(path: string, mb: string, main?: string): Promise<string> {
  return withPrivateIndex(path, main, async ({ opts, excludes }) => {
    let untracked: string[] = [];
    try {
      const { stdout } = await runGit(path, ["-C", path, "ls-files", "--others", "--exclude-standard"], opts, main);
      untracked = stdout.split("\n").map((s) => s.trim()).filter((s) => s && s !== HOOKS_FILE);
    } catch { /* leave empty */ }
    if (untracked.length) {
      const paths = untracked.map((u) => `:(literal)${u}`);
      try { await runGit(path, ["-C", path, "add", "-N", "--", ...paths, ...excludes], opts, main); } catch { /* best effort */ }
    }
    const { stdout } = await runGit(path, ["-C", path, "diff", mb], opts, main);
    return stdout;
  });
}

async function gitLine(path: string, args: string[], main?: string): Promise<string> {
  const { stdout } = await runGit(path, ["-C", path, ...args], undefined, main);
  return stdout.trim();
}

// The outputs of the git state commands (each trimmed, or null when the command failed) → the
// state. Shared by a worktree (the console's git) and an agent's own clone (the helper's
// repo-read, strong protection: its output is untrusted text, parsed here the same way).
export type GitStateParts = {
  head: string | null; sha: string | null; aheadBehind: string | null;
  staged: string | null; unstaged: string | null; untracked: string | null; stashes: string | null;
};
export function gitStateOf(p: GitStateParts, trackedBranch: string, baseBranch: string): GitState {
  const base: GitState = {
    head: "", detached: false, sha: "", trackedBranch, baseBranch,
    onTracked: false, ahead: 0, behind: 0, staged: 0, unstaged: 0,
    untracked: 0, stashes: [], error: false,
  };
  // Live HEAD: a branch name, or detached (symbolic-ref exits non-zero).
  if (p.head === null) base.detached = true;
  else base.head = p.head;
  if (p.sha === null) return { ...base, error: true };
  base.sha = p.sha;
  base.onTracked = !base.detached && base.head === trackedBranch;
  // Ahead/behind the base's fork point. `--left-right --count base...HEAD`
  // prints "<behind>\t<ahead>" (left = base-only commits, right = HEAD-only).
  if (p.aheadBehind !== null) {
    const [behind, ahead] = p.aheadBehind.split(/\s+/).map((n) => Number(n) || 0);
    base.behind = behind ?? 0;
    base.ahead = ahead ?? 0;
  }
  // Dirty working tree, split into staged vs unstaged tracked files.
  const count = (out: string | null) => (out ? out.split("\n").filter(Boolean).length : 0);
  base.staged = count(p.staged);
  base.unstaged = count(p.unstaged);
  if (p.untracked !== null) {
    base.untracked = p.untracked.split("\n").map((s) => s.trim()).filter((s) => s && s !== HOOKS_FILE).length;
  }
  // Stash entries (repo-wide: git keeps a single refs/stash shared by all
  // worktrees, so this surfaces work parked from anywhere in the repo).
  if (p.stashes !== null) {
    base.stashes = p.stashes.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const tab = l.indexOf("\t");
      return tab < 0
        ? { ref: l, message: "" }
        : { ref: l.slice(0, tab), message: l.slice(tab + 1) };
    });
  }
  return base;
}

export async function worktreeGitState(
  path: string,
  trackedBranch: string,
  baseBranch: string,
  main?: string,
): Promise<GitState> {
  const line = async (args: string[]): Promise<string | null> => {
    try { return await gitLine(path, args, main); } catch { return null; }
  };
  return gitStateOf({
    head: await line(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    sha: await line(["rev-parse", "--short", "HEAD"]),
    aheadBehind: await line(["rev-list", "--left-right", "--count", `${baseBranch}...HEAD`]),
    staged: await line(["diff", "--cached", "--name-only"]),
    unstaged: await line(["diff", "--name-only"]),
    untracked: await line(["ls-files", "--others", "--exclude-standard"]),
    stashes: await line(["stash", "list", "--format=%gd%x09%gs"]),
  }, trackedBranch, baseBranch);
}

export type ChangedFile = {
  rel: string;
  path: string;
  // What kind of change it is, relative to the fork point (git porcelain shorthand).
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  // Where the change lives: already landed in a commit on the branch, sitting in
  // the working tree only, or a brand-new file git isn't tracking yet.
  state: "committed" | "uncommitted" | "untracked";
  // Lines added / removed against the fork point (untracked: the file's line
  // count). Absent for a binary file or when git cannot tell.
  add?: number;
  del?: number;
};

// `git diff -z --numstat` output → rel → counts. A rename's record has an empty
// path field followed by the old and the new path; the counts go to the new
// one, like the name-status pass. Binary files ("-") get no counts.
export function parseNumstat(out: string): Map<string, { add: number; del: number }> {
  const m = new Map<string, { add: number; del: number }>();
  const t = out.split("\0");
  for (let i = 0; i < t.length; i++) {
    const rec = t[i];
    if (!rec) continue;
    const [a, d, ...rest] = rec.split("\t");
    let rel = rest.join("\t");
    if (!rel) { rel = t[i + 2] ?? ""; i += 2; }
    if (!rel || a === "-" || d === "-") continue;
    m.set(rel, { add: Number(a), del: Number(d) });
  }
  return m;
}

// Line count of a new (untracked) file, or undefined when it is big or binary.
// The agent owns the worktree, so the file may be a symlink to anything on the box:
// lstat, never stat, and the read opens with O_NOFOLLOW (a swap to a symlink after
// the lstat fails the open). A symlink gets no count.
const UNTRACKED_COUNT_MAX = 100;
const UNTRACKED_BYTES_MAX = 256 * 1024;
async function lineCount(abs: string): Promise<number | undefined> {
  try {
    const st = await lstat(abs);
    // Only a plain file: a FIFO or a device would block or never end.
    if (!st.isFile() || st.size > UNTRACKED_BYTES_MAX) return undefined;
    const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let buf: Buffer;
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.size > UNTRACKED_BYTES_MAX) return undefined;
      buf = await fh.readFile();
    } finally {
      await fh.close();
    }
    if (buf.includes(0)) return undefined;
    if (buf.length === 0) return 0;
    let n = 0;
    for (const c of buf) if (c === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return undefined;
  }
}

// The outputs of the changed-files commands → the list (untracked files with no counts yet).
// Shared by a worktree and an agent's own clone (repo-read; untrusted text). dirty: `diff
// --name-only HEAD`; nameStatus: `diff --name-status <fork point>`; untracked: `ls-files --others
// --exclude-standard`; numstat: `diff -z --numstat <fork point>`, or null (no counts).
export function changedFilesOf(path: string, p: { dirty: string; nameStatus: string; untracked: string; numstat: string | null }): ChangedFile[] {
  // Paths with working-tree edits not yet committed (worktree vs HEAD). A
  // tracked change in this set is "uncommitted"; otherwise it reached the diff
  // vs base through a commit and is "committed".
  const dirty = new Set(p.dirty.split("\n").map((s) => s.trim()).filter(Boolean));
  const out: ChangedFile[] = [];
  const seen = new Set<string>();
  const add = (rel: string, status: ChangedFile["status"], state: ChangedFile["state"]) => {
    if (!rel || rel === HOOKS_FILE || seen.has(rel)) return;
    seen.add(rel);
    out.push({ rel, path: join(path, rel), status, state });
  };
  for (const line of p.nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    let rel: string;
    let status: ChangedFile["status"];
    if (code.startsWith("R")) {
      // rename: R<score>\t<old>\t<new> — report the new path
      rel = parts[2] ?? parts[1];
      status = "renamed";
    } else if (code.startsWith("A")) {
      rel = parts[1];
      status = "added";
    } else if (code.startsWith("D")) {
      rel = parts[1];
      status = "deleted";
    } else if (code.startsWith("M") || code.startsWith("T") || code.startsWith("C")) {
      rel = parts[1];
      status = "modified";
    } else {
      continue;
    }
    add(rel, status, dirty.has(rel) ? "uncommitted" : "committed");
  }
  for (const rel of p.untracked.split("\n")) {
    if (rel.trim()) add(rel.trim(), "untracked", "untracked");
  }
  // The +/- counts are extra: no numstat keeps the list without them.
  if (p.numstat !== null) {
    const counts = parseNumstat(p.numstat);
    for (const f of out) {
      const c = counts.get(f.rel);
      if (c) { f.add = c.add; f.del = c.del; }
    }
  }
  return out;
}

// List files changed in the worktree relative to the fork point — tracked
// (committed + uncommitted, via `diff --name-status <merge-base>`) plus
// untracked files. Each carries a `state` so the UI can label it committed /
// uncommitted / untracked. Excludes the internal `.choibot-hooks.json`. Returns []
// on any git error so a transient failure degrades to an empty rail, not a throw.
export async function worktreeChangedFiles(path: string, baseBranch: string, main?: string): Promise<ChangedFile[]> {
  try {
    const { stdout: mbOut } = await runGit(path, ["-C", path, "merge-base", baseBranch, "HEAD"], undefined, main);
    const mb = mbOut.trim();
    const { stdout: dirty } = await runGit(path, ["-C", path, "diff", "--name-only", "HEAD"], undefined, main);
    const { stdout: nameStatus } = await runGit(path, ["-C", path, "diff", "--name-status", mb], undefined, main);
    const { stdout: untracked } = await runGit(path, ["-C", path, "ls-files", "--others", "--exclude-standard"], undefined, main);
    let numstat: string | null = null;
    try {
      numstat = (await runGit(path, ["-C", path, "diff", "-z", "--numstat", mb], undefined, main)).stdout;
    } catch { /* no counts */ }
    const out = changedFilesOf(path, { dirty, nameStatus, untracked, numstat });
    const fresh = out.filter((f) => f.state === "untracked").slice(0, UNTRACKED_COUNT_MAX);
    await Promise.all(fresh.map(async (f) => {
      const n = await lineCount(f.path);
      if (n !== undefined) { f.add = n; f.del = 0; }
    }));
    return out;
  } catch {
    return [];
  }
}

// Strong protection (agentclone.ts repo-read): the base commit of an agent's own clone, as a sha
// of the console's own repo (the clone sees its objects through the alternates).
export async function baseCommit(repo: string, baseBranch: string): Promise<string> {
  const { stdout } = await runGit(repo, ["-C", repo, "rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`], undefined, repo);
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no base commit for ${baseBranch}`);
  return sha;
}

// Revert a single changed file back to its fork-point state, dropping it from
// the change set without rewriting any commits. Paths that exist at the fork
// point are restored to their base content (covers committed + uncommitted
// edits, and undoes deletions); paths the agent newly created are removed.
export async function discardFileInWorktree(path: string, baseBranch: string, rel: string, main?: string): Promise<void> {
  const clean = rel.replace(/^\/+/, "");
  if (!clean || clean === HOOKS_FILE || clean.split("/").includes("..")) {
    throw new Error("invalid path");
  }
  // Keep the target strictly inside the worktree — never let a crafted rel escape.
  const abs = resolve(path, clean);
  if (abs !== path && !abs.startsWith(path + "/")) throw new Error("path escapes worktree");

  const { stdout: mbOut } = await runGit(path, ["-C", path, "merge-base", baseBranch, "HEAD"], undefined, main);
  const mb = mbOut.trim();
  // Present at the fork point? `cat-file -e` exits non-zero when the blob is absent.
  let inBase = true;
  try {
    await runGit(path, ["-C", path, "cat-file", "-e", `${mb}:${clean}`], undefined, main);
  } catch {
    inBase = false;
  }
  if (inBase) {
    // Restore base content into index + worktree → no diff vs base for this path.
    await runGit(path, ["-C", path, "checkout", mb, "--", clean], undefined, main);
  } else {
    // New file (committed-add, staged, or untracked) — remove it. `git rm` covers
    // tracked paths and the index; fall back to an fs unlink for purely untracked.
    try {
      await runGit(path, ["-C", path, "rm", "-f", "--", clean], undefined, main);
    } catch {
      await unlink(abs).catch(() => { /* already gone */ });
    }
  }
}
