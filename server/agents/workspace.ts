// server/agents/workspace.ts
//
// A "workspace agent" runs with its cwd at the workspace ROOT (the directory
// that holds the repos) rather than inside a per-repo git worktree. It has no
// base branch and no fork point: it edits the live repos in place. These helpers
// give the review UI the same shape it gets for a worktree agent — a flat list
// of changed files and a unified diff — by scanning every repo under the
// workspace and reporting each repo's working-tree changes vs its own HEAD.
//
// File paths are namespaced by repo (`<repo>/<path>`) so two repos with a file
// of the same name never collide, the changes rail groups them visually, and a
// click-to-focus `rel` lines up with the path the diff parser emits.
import { gitHardened, runGit, withPrivateIndex } from "./git.js";
import { unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listRepos } from "./repos.js";
import type { ChangedFile } from "./worktree.js";
import { names } from "../names.mjs";

const HOOK = names().hooksFile;

// Console/agent infrastructure that lives inside repos but isn't real work:
// other agents' worktrees, the per-agent hook dir, and agent skill caches.
// These are typically not gitignored, so without this a workspace agent's
// change list floods with hundreds of untracked infra files. Matched on the
// first path segment.
const INFRA_DIRS = new Set([".agent-worktrees", names().agentsFolder, ".agents"]);

// True for the internal hook file or anything under an infra directory.
function isInfra(sub: string): boolean {
  return sub === HOOK || INFRA_DIRS.has(sub.split("/")[0]);
}

// git pathspecs that exclude the hook file and every infra directory.
const EXCLUDE_PATHSPECS = [`:!${HOOK}`, ...[...INFRA_DIRS].map((d) => `:!${d}`)];

// Map a `git status --porcelain` two-char code to our status/state. Working-tree
// oriented: with no fork point every tracked change is "uncommitted"; only
// genuinely new files are "untracked".
function classify(code: string): Pick<ChangedFile, "status" | "state"> | null {
  if (code === "??") return { status: "untracked", state: "untracked" };
  // Prefer the worktree column (Y); fall back to the index column (X).
  const y = code[1] !== " " ? code[1] : code[0];
  if (y === "A") return { status: "added", state: "uncommitted" };
  if (y === "D") return { status: "deleted", state: "uncommitted" };
  if (y === "R") return { status: "renamed", state: "uncommitted" };
  if (y === "M" || y === "T" || y === "C") return { status: "modified", state: "uncommitted" };
  return null;
}

// The changed path a porcelain line refers to. Renames render as "old -> new";
// we report the new path (matching the worktree-agent behaviour).
function porcelainPath(rest: string): string {
  const arrow = rest.indexOf(" -> ");
  return arrow >= 0 ? rest.slice(arrow + 4) : rest;
}

// Changed files across every repo under the workspace, each `rel` namespaced as
// `<repo>/<path>`. Excludes the internal hook file. A per-repo git failure is
// swallowed so one broken repo doesn't blank the whole list.
export async function workspaceChangedFiles(workspaceDir: string): Promise<ChangedFile[]> {
  const repos = await listRepos(workspaceDir);
  const out: ChangedFile[] = [];
  for (const repo of repos) {
    let lines: string[] = [];
    try {
      const { stdout } = await runGit(repo.path, ["-C", repo.path, "status", "--porcelain", "--untracked-files=all"], undefined, repo.path);
      lines = stdout.split("\n");
    } catch {
      continue; // unreadable repo — skip
    }
    for (const line of lines) {
      if (line.length < 3) continue;
      const cls = classify(line.slice(0, 2));
      if (!cls) continue;
      const sub = porcelainPath(line.slice(3).trim());
      if (!sub || isInfra(sub)) continue;
      const rel = `${repo.name}/${sub}`;
      out.push({ rel, path: join(repo.path, sub), status: cls.status, state: cls.state });
    }
  }
  return out;
}

// Unified diff of working-tree changes vs HEAD across every repo, with paths
// prefixed by repo name (via --src-prefix/--dst-prefix) so they're unique and
// match the `rel` the changes rail emits. Untracked files are surfaced by a
// scoped, reverted intent-to-add — the same trick worktreeDiff uses — which
// leaves each repo's index untouched.
export async function workspaceDiff(workspaceDir: string): Promise<string> {
  const repos = await listRepos(workspaceDir);
  const parts: string[] = [];
  for (const repo of repos) {
    if (gitHardened()) {
      const d = await hardenedRepoDiff(repo);
      if (d.trim()) parts.push(d);
      continue;
    }
    let untracked: string[] = [];
    try {
      const { stdout } = await runGit(repo.path, ["-C", repo.path, "ls-files", "--others", "--exclude-standard"], undefined, repo.path);
      untracked = stdout.split("\n").map((s) => s.trim()).filter((s) => s && !isInfra(s));
    } catch { /* leave empty */ }
    if (untracked.length) {
      try { await runGit(repo.path, ["-C", repo.path, "add", "-N", "--", ...untracked], undefined, repo.path); } catch { /* best effort */ }
    }
    try {
      const { stdout } = await runGit(repo.path, [
        "-C", repo.path, "diff", "HEAD",
        `--src-prefix=a/${repo.name}/`, `--dst-prefix=b/${repo.name}/`,
        "--", ".", ...EXCLUDE_PATHSPECS,
      ], undefined, repo.path);
      if (stdout.trim()) parts.push(stdout);
    } catch { /* no HEAD yet / unreadable — skip this repo */ }
    finally {
      if (untracked.length) {
        try { await runGit(repo.path, ["-C", repo.path, "reset", "-q", "--", ...untracked], undefined, repo.path); } catch { /* best effort */ }
      }
    }
  }
  return parts.join("");
}

// Hardened (fix round 2, item 1): one repo's part of workspaceDiff on a
// private copy of its index, every gitlink left out of the intent-to-add (add
// asks a gitlink's nested repo with a child git that skips the ownership
// check); the repo's own index is never touched. "" when it has no HEAD yet
// or cannot be read, as today.
async function hardenedRepoDiff(repo: { name: string; path: string }): Promise<string> {
  const main = repo.path;
  try {
    return await withPrivateIndex(repo.path, main, async ({ opts, excludes }) => {
      let untracked: string[] = [];
      try {
        const { stdout } = await runGit(repo.path, ["-C", repo.path, "ls-files", "--others", "--exclude-standard"], opts, main);
        untracked = stdout.split("\n").map((s) => s.trim()).filter((s) => s && !isInfra(s));
      } catch { /* leave empty */ }
      if (untracked.length) {
        const paths = untracked.map((u) => `:(literal)${u}`);
        try { await runGit(repo.path, ["-C", repo.path, "add", "-N", "--", ...paths, ...excludes], opts, main); } catch { /* best effort */ }
      }
      const { stdout } = await runGit(repo.path, [
        "-C", repo.path, "diff", "HEAD",
        `--src-prefix=a/${repo.name}/`, `--dst-prefix=b/${repo.name}/`,
        "--", ".", ...EXCLUDE_PATHSPECS,
      ], opts, main);
      return stdout;
    });
  } catch {
    return "";
  }
}

// Revert one `<repo>/<path>` file back to its repo's HEAD (dropping the change),
// or remove it when it's a new file. Mirrors discardFileInWorktree but keyed on
// HEAD rather than a fork point, and resolves the owning repo from the rel's
// first path segment.
export async function workspaceDiscardFile(workspaceDir: string, rel: string): Promise<void> {
  const clean = rel.replace(/^\/+/, "");
  const slash = clean.indexOf("/");
  if (slash <= 0) throw new Error("invalid path");
  const repoName = clean.slice(0, slash);
  const sub = clean.slice(slash + 1);
  if (!sub || isInfra(sub) || sub.split("/").includes("..")) throw new Error("invalid path");

  const repo = (await listRepos(workspaceDir)).find((r) => r.name === repoName);
  if (!repo) throw new Error("unknown repo");

  // Never let a crafted rel escape the repo directory.
  const abs = resolve(repo.path, sub);
  if (abs !== repo.path && !abs.startsWith(repo.path + "/")) throw new Error("path escapes repo");

  // Present at HEAD? `cat-file -e` exits non-zero when the blob is absent.
  let inHead = true;
  try {
    await runGit(repo.path, ["-C", repo.path, "cat-file", "-e", `HEAD:${sub}`], undefined, repo.path);
  } catch {
    inHead = false;
  }
  if (inHead) {
    await runGit(repo.path, ["-C", repo.path, "checkout", "HEAD", "--", sub], undefined, repo.path);
  } else {
    try {
      await runGit(repo.path, ["-C", repo.path, "rm", "-f", "--", sub], undefined, repo.path);
    } catch {
      await unlink(abs).catch(() => { /* already gone */ });
    }
  }
}
