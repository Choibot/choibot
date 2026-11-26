// server/agents/reconcile.ts
import { gitHardened, runGit, withPrivateIndex } from "./git.js";
import { worktreeDiff, removeWorktree } from "./worktree.js";
import { GhError, classifyError } from "../gh/exec.js";
import type { AgentRecord } from "./store.js";
import { names } from "../names.mjs";
import { CLONE_NO_GIT, cloneExecOrRefuse, dropAgentRefs, isClone, removeClone, removeCloneFiles } from "./agentclone.js";

export async function diffPatch(record: AgentRecord): Promise<string> {
  if (isClone(record)) throw new Error(CLONE_NO_GIT);
  return worktreeDiff(record.worktree, record.baseBranch, record.repo);
}

// Commit any pending worktree edits so what was reviewed is what ships.
// Excludes the console's own per-agent state: the Claude hook settings file
// (.choibot-hooks.json) and the .choibot/ directory, which for a Codex agent holds the
// generated CODEX_HOME — hundreds of skill symlinks, the plugin cache, its
// config.toml, and a symlink to ~/.codex/auth.json. `.gitignore`-style exclusion
// via git-exclude is the first layer (ensureChoiBotExcluded at worktree creation);
// the unstage after `add -A` (git reset of those two paths) is the second, so a
// worktree that predates it, or whose exclude write failed, still cannot commit
// that tree. Without the exclude, `add -A` hashes the files into unreachable
// blobs before the reset (never pushed; low risk). No-op when the tree is clean.
export async function commitPending(
  record: AgentRecord,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // Strong protection: no git in an agent's own clone (so no merge and no push from here either).
  if (isClone(record)) return { ok: false, message: CLONE_NO_GIT };
  try {
    if (gitHardened()) {
      await commitPendingHardened(record);
      return { ok: true };
    }
    const { stdout: dirty } = await runGit(record.worktree, ["-C", record.worktree, "status", "--porcelain"]);
    if (dirty.trim()) {
      // `add -A -- :!path` exits 1 when path is git-ignored, so unstage instead.
      await runGit(record.worktree, ["-C", record.worktree, "add", "-A"]);
      await runGit(record.worktree, ["-C", record.worktree, "reset", "-q", "--", names().hooksFile, names().repoFolder]);
      const { stdout: staged } = await runGit(record.worktree, ["-C", record.worktree, "diff", "--cached", "--name-only"]);
      if (staged.trim()) await runGit(record.worktree, ["-C", record.worktree, "commit", "-m", "console: commit pending edits"]);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Hardened (fix round 2, item 1): the same steps on a private copy of the
// worktree's index, every gitlink left out of `add -A` (add asks a gitlink's
// nested repo with a child git that skips the ownership check); after a
// commit the worktree's own index is reset to the new HEAD (files untouched).
async function commitPendingHardened(record: AgentRecord): Promise<void> {
  const wt = record.worktree;
  const main = record.repo;
  const { stdout: dirty } = await runGit(wt, ["-C", wt, "status", "--porcelain"], undefined, main);
  if (!dirty.trim()) return;
  const committed = await withPrivateIndex(wt, main, async ({ opts, excludes }) => {
    await runGit(wt, ["-C", wt, "add", "-A", ...(excludes.length ? ["--", ".", ...excludes] : [])], opts, main);
    await runGit(wt, ["-C", wt, "reset", "-q", "--", names().hooksFile, names().repoFolder], opts, main);
    const { stdout: staged } = await runGit(wt, ["-C", wt, "diff", "--cached", "--name-only"], opts, main);
    if (!staged.trim()) return false;
    await runGit(wt, ["-C", wt, "commit", "-m", "console: commit pending edits"], opts, main);
    return true;
  });
  if (committed) await runGit(wt, ["-C", wt, "reset", "-q"], undefined, main);
}

// Push a branch to origin (the SSH remote from normalizeCloneUrl). Fast-forward
// only — force/delete are blocked by the guard and never attempted here.
export async function pushBranch(record: AgentRecord, branch: string): Promise<void> {
  // The console's repo has no work of an agent with its own clone (part 3 of design B fetches it).
  if (isClone(record)) throw new Error(CLONE_NO_GIT);
  try {
    await runGit(record.repo, ["-C", record.repo, "push", "-u", "origin", branch], undefined, record.repo);
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const text = String(err.stderr || err.message || e);
    throw new GhError(classifyError(text), text.trim().slice(0, 600));
  }
}

export async function merge(
  record: AgentRecord,
  baseBranch: string,
): Promise<{ ok: true } | { ok: false; conflict: true; message: string }> {
  // Commit any pending worktree edits so what was reviewed is what merges.
  // The merge guard already ensures the agent is stopped, so this is safe.
  const committed = await commitPending(record);
  if (!committed.ok) return { ok: false, conflict: true, message: `could not commit pending edits: ${committed.message}` };
  await runGit(record.repo, ["-C", record.repo, "checkout", baseBranch], undefined, record.repo);
  try {
    await runGit(record.repo, ["-C", record.repo, "merge", "--no-edit", record.branch], undefined, record.repo);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await runGit(record.repo, ["-C", record.repo, "merge", "--abort"], undefined, record.repo); } catch { /* nothing to abort */ }
    return { ok: false, conflict: true, message };
  }
}

export async function discard(record: AgentRecord): Promise<void> {
  // A workspace agent has no worktree or branch of its own (it edits the live
  // repos in place); there is nothing to tear down, and removing its "worktree"
  // would mean deleting the workspace root. No-op.
  if (!record.repo || !record.branch) return;
  // Strong protection (design B): the agent's own clone goes, as the agent; the console's repo
  // has no branch of the agent, only its fetched branch under refs/agents/<id>/ (part 3).
  // Its own files of the console go first (no helper needed), then the clone, as the agent.
  if (isClone(record)) {
    await removeCloneFiles(record.id);
    await dropAgentRefs(record.repo, record.id).catch(() => { /* no such ref, or no repo any more */ });
    return removeClone(cloneExecOrRefuse(), record.id);
  }
  await removeWorktree(record.repo, record.worktree);
  await runGit(record.repo, ["-C", record.repo, "branch", "-D", record.branch], undefined, record.repo);
}
