// server/chief/deploy/git.ts — the git reads of the deploy check (spec §5.7) on the console's
// own checkout. Only `fetch` writes, and only the remote-tracking ref of origin/main. Every
// argv is fixed here; the two commit ids a caller passes are checked to be full ids first.
import { runGit } from "../../agents/git.js";
import { DEPLOY_BRANCH, DEPLOY_REMOTE, type DeployPr } from "./ticket.js";

const SHA_RE = /^[0-9a-f]{40}$/;
const REMOTE_REF = `refs/remotes/${DEPLOY_REMOTE}/${DEPLOY_BRANCH}`;
const TIMEOUT_MS = 30_000;
// No hook and no filesystem monitor of the checkout runs in a console git call.
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

export type DeployGit = {
  // origin's main as GitHub has it now (ls-remote: no local change).
  remoteHead(): Promise<string>;
  // The local remote-tracking ref of origin/main, or null when it does not exist.
  trackedHead(): Promise<string | null>;
  fetch(): Promise<void>;
  head(): Promise<string>;
  branch(): Promise<string>;
  isAncestor(a: string, b: string): Promise<boolean>;
  // Commits on the first-parent line of from..to: one per merged PR (its merge or squash commit)
  // and one per commit made on main itself. 0 only when `to` has nothing that `from` lacks.
  count(from: string, to: string): Promise<number>;
  // The subjects and bodies of the first-parent commits in from..to, newest first.
  commits(from: string, to: string, max: number): Promise<{ subject: string; body: string }[]>;
  // Files with uncommitted changes that from..to also changes: the fast-forward would be refused.
  blockedFiles(from: string, to: string): Promise<string[]>;
};

const sha = (s: string): string => {
  if (!SHA_RE.test(s)) throw new Error("not a full commit id");
  return s;
};

export function deployGit(dir: string, env: NodeJS.ProcessEnv = process.env): DeployGit {
  const git = async (args: string[], timeout = TIMEOUT_MS): Promise<string> => {
    // runGit: in a hardened deployment it adds the console's git overrides (server/agents/git.ts).
    const { stdout } = await runGit(dir, [...SAFE, "-C", dir, ...args], { timeout, env, maxBuffer: 8 * 1024 * 1024 }, dir);
    return stdout;
  };
  const exitCode = (e: unknown): unknown => (e as { code?: unknown }).code;
  return {
    remoteHead: async () => {
      const out = await git(["ls-remote", DEPLOY_REMOTE, `refs/heads/${DEPLOY_BRANCH}`]);
      return sha(out.trim().split(/\s+/)[0] ?? "");
    },
    trackedHead: async () => {
      try { return sha((await git(["rev-parse", "--verify", "-q", `${REMOTE_REF}^{commit}`])).trim()); } catch { return null; }
    },
    fetch: async () => { await git(["fetch", "--no-tags", DEPLOY_REMOTE, `+refs/heads/${DEPLOY_BRANCH}:${REMOTE_REF}`], 120_000); },
    head: async () => sha((await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim()),
    branch: async () => {
      try { return (await git(["symbolic-ref", "--short", "-q", "HEAD"])).trim(); } catch { return ""; }
    },
    isAncestor: async (a, b) => {
      try { await git(["merge-base", "--is-ancestor", sha(a), sha(b)]); return true; } catch (e) {
        if (exitCode(e) === 1) return false;
        throw e;
      }
    },
    count: async (from, to) => Number((await git(["rev-list", "--count", "--first-parent", `${sha(from)}..${sha(to)}`])).trim()),
    commits: async (from, to, max) => {
      const out = await git(["log", "--first-parent", `--max-count=${Math.max(1, Math.floor(max))}`, "--format=%s%x1f%b%x1e", `${sha(from)}..${sha(to)}`]);
      return out.split("\x1e").map((r) => r.replace(/^\n+/, "")).filter((r) => r !== "").map((r) => {
        const [subject = "", body = ""] = r.split("\x1f");
        return { subject, body };
      });
    },
    blockedFiles: async (from, to) => {
      const changed = new Set((await git(["diff", "--name-only", sha(from), sha(to)])).split("\n").filter(Boolean));
      const dirty = (await git(["status", "--porcelain", "--untracked-files=all"])).split("\n").filter(Boolean)
        .map((l) => l.slice(3).split(" -> ").pop() ?? "");
      return dirty.filter((f) => changed.has(f));
    },
  };
}

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const TITLE_MAX = 100;
const clipTitle = (s: string): string => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

// The merged PRs among commits: a merge commit ("Merge pull request #5 from …", title on the
// first body line) or a squash commit ("title (#5)"). A PR number shows once.
export function mergedPrs(commits: { subject: string; body: string }[]): DeployPr[] {
  const out: DeployPr[] = [];
  const seen = new Set<number>();
  for (const c of commits) {
    const merge = /^Merge pull request #(\d{1,9}) /.exec(c.subject);
    const squash = merge ? null : /^(.*\S)\s*\(#(\d{1,9})\)$/.exec(c.subject);
    const number = Number(merge?.[1] ?? squash?.[2]);
    if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    const title = merge ? flat(c.body.split("\n").find((l) => l.trim() !== "") ?? "") : flat(squash![1]);
    out.push({ number, title: clipTitle(title || `PR #${number}`) });
  }
  return out;
}
