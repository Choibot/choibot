// server/gh/clonepr.ts — the push and the pull request of an agent with its own clone (strong
// protection, design B, part 3). The rule: the console runs no git and no gh in a folder that an
// agent can write. Its own repo in the workspace (agents only read it) fetches the agent's branch
// through upload-pack run as the agent (agentclone.ts fetchAgentBranch), then pushes that commit to
// the GitHub address of its own origin, fast-forward only. gh opens the pull request with --repo of
// the same address, from a folder of the console, with the body on stdin. Never a merge, a review,
// a base change or a force push: a merge stays the user's, from the queue ticket.
import { mkdir } from "node:fs/promises";
import { runGit } from "../agents/git.js";
import { agentRef, fetchAgentBranch, type CloneFolders } from "../agents/agentclone.js";
import type { AgentExec } from "../agents/terminal.js";
import { plainRefName, validBranchName } from "../agents/worktree.js";
import { GhError, classifyError, extractPrUrl } from "./exec.js";

export type GhInputRunner = (args: string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

export class ClonePrError extends Error {
  constructor(public code: 400 | 409 | 502, message: string) { super(message); }
}

// What a caller gives: nothing else. The repo, the branch and the base come from the record.
export const TITLE_MAX = 256;
export const BODY_MAX = 65_536;
export type ClonePrInput = { title: string; body: string; draft: boolean };
export function clonePrInput(b: { title?: unknown; body?: unknown; draft?: unknown }, branch: string): ClonePrInput | string {
  const title = b.title === undefined ? "" : b.title;
  const body = b.body === undefined ? "" : b.body;
  if (typeof title !== "string" || title.length > TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) return `the title is one line of at most ${TITLE_MAX} characters`;
  if (typeof body !== "string" || Buffer.byteLength(body) > BODY_MAX) return `the body is a text of at most ${BODY_MAX} bytes`;
  if (b.draft !== undefined && typeof b.draft !== "boolean") return "draft is true or false";
  return { title: title.trim() || branch, body, draft: b.draft === true };
}

// The branches that the console never pushes for an agent (with the repo's default branch and the
// agent's base).
const KEPT = /^(main|master|develop|development|trunk|production|prod|staging|gh-pages|release([._/-].*)?)$/i;

// The GitHub repo of the console's own repo: the raw value of its remote.origin.url (the console's
// own config; agents cannot write that repo), in one of the three address forms of github.com,
// with a strict owner and name. The push address is written again from the owner and name, so no
// other host, user, port or path of the text is used.
export function githubRemote(url: string): { slug: string; pushUrl: string } | null {
  const u = url.trim();
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(u);
  if (!m || m[2] === "." || m[2] === "..") return null;
  const slug = `${m[1]}/${m[2]}`;
  return { slug, pushUrl: u.startsWith("https://") ? `https://github.com/${slug}.git` : `git@github.com:${slug}.git` };
}

// The reason to show: the helper's own line when there is one, else git's first "fatal:" line.
const firstLine = (e: unknown): string => {
  const err = e as { stderr?: string; message?: string };
  const lines = String(err.stderr || err.message || e).trim().split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /agent-exec: /.test(l)) ?? lines.find((l) => l.startsWith("fatal:")) ?? lines.pop() ?? "").slice(0, 300);
};

type Rec = { id: string; repo: string; branch: string; baseBranch: string; prUrl?: string; prNumber?: number };
export type ClonePrDeps = { exec: AgentExec; folders: CloneFolders; gh: GhInputRunner; ghCwd: string };

export async function clonePushAndPr(rec: Rec, input: ClonePrInput, d: ClonePrDeps): Promise<{ url: string; number: number; sha: string }> {
  const { repo, branch, baseBranch: base } = rec;
  const plain = (b: string) => validBranchName(b) !== null && plainRefName(b);
  if (!plain(branch) || !plain(base)) throw new ClonePrError(400, "The branch or the base of this agent has a name that the console does not push.");
  if (branch === base || KEPT.test(branch)) throw new ClonePrError(409, `The console does not push to ${branch}.`);
  const git = async (args: string[]): Promise<string> => (await runGit(repo, ["-C", repo, ...args], undefined, repo)).stdout.trim();
  const remote = githubRemote(await git(["config", "--get", "remote.origin.url"]).catch(() => ""));
  if (!remote) throw new ClonePrError(400, "The repo of this agent has no GitHub address.");
  if ((await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")) === `refs/remotes/origin/${branch}`) {
    throw new ClonePrError(409, `The console does not push to ${branch}: it is the default branch of the repo.`);
  }
  const baseRef = `refs/remotes/origin/${base}`;
  if (!(await git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).catch(() => ""))) {
    throw new ClonePrError(409, `The base branch ${base} is not on GitHub.`);
  }
  let sha: string;
  try { sha = await fetchAgentBranch(d.exec, d.folders, repo, rec.id, branch); }
  catch (e) { throw new ClonePrError(502, `The console could not fetch ${branch} from the agent's copy: ${firstLine(e)}`); }
  const ref = agentRef(rec.id, branch);
  if (!(Number(await git(["rev-list", "--count", `${baseRef}..${ref}`])) > 0)) {
    throw new ClonePrError(409, `${branch} has no commit that ${base} does not have. Commit your work first.`);
  }
  // No "+" and no --force: GitHub refuses a push that is not a fast-forward.
  try { await git(["push", remote.pushUrl, `${ref}:refs/heads/${branch}`]); }
  catch (e) {
    const text = String((e as { stderr?: string }).stderr || (e as Error).message || e);
    if (classifyError(text) === "not_fast_forward") {
      throw new ClonePrError(409, `GitHub has commits on ${branch} that this branch does not have. The console never force-pushes: merge them first, or use a new branch.`);
    }
    throw new GhError(classifyError(text), text.trim().slice(0, 600));
  }
  // One pull request for each agent: a later call only pushes the new commits to it.
  if (rec.prUrl) return { url: rec.prUrl, number: rec.prNumber ?? Number(rec.prUrl.match(/\/pull\/(\d+)/)?.[1]), sha };
  const args = ["pr", "create", `--repo=${remote.slug}`, `--head=${branch}`, `--base=${base}`, `--title=${input.title}`, "--body-file=-"];
  if (input.draft) args.push("--draft");
  await mkdir(d.ghCwd, { recursive: true, mode: 0o700 });
  const out = await d.gh(args, { cwd: d.ghCwd, input: input.body });
  const url = extractPrUrl(out);
  if (!url) throw new GhError("unknown", `gh pr create returned no PR url: ${out.trim().slice(0, 200)}`);
  return { url, number: Number(url.match(/\/pull\/(\d+)/)![1]), sha };
}

// The agent asks; the console fetches the base from GitHub into its own repo (its own login), one
// fetch at a time for each repo and at most one for each (repo, base) in BASE_FETCH_GAP_MS. The
// agent then gets it with `git fetch console` + `git merge console/<base>` (its clone maps the
// console's refs/remotes/origin/* to refs/remotes/console/*).
export const BASE_FETCH_GAP_MS = 30_000;
const repoChain = new Map<string, Promise<unknown>>();
const lastBaseFetch = new Map<string, number>();
export function resetBaseFetches(): void { repoChain.clear(); lastBaseFetch.clear(); }

export function fetchBaseFromGitHub(repo: string, base: string, now: () => number = Date.now): Promise<{ fetched: boolean; at: number; sha: string }> {
  if (validBranchName(base) === null || !plainRefName(base)) return Promise.reject(new ClonePrError(400, "The base of this agent has a name that the console does not fetch."));
  const git = async (args: string[], timeout?: number): Promise<string> => (await runGit(repo, ["-C", repo, ...args], timeout ? { timeout } : undefined, repo)).stdout.trim();
  const run = (repoChain.get(repo) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const key = `${repo}\0${base}`;
    const last = lastBaseFetch.get(key);
    let fetched = false;
    if (last === undefined || now() - last >= BASE_FETCH_GAP_MS) {
      lastBaseFetch.set(key, now());
      try { await git(["fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], 120_000); }
      catch (e) { throw new ClonePrError(502, `The console could not fetch ${base} from GitHub: ${firstLine(e)}`); }
      fetched = true;
    }
    const sha = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`]).catch(() => "");
    return { fetched, at: lastBaseFetch.get(key)!, sha };
  });
  repoChain.set(repo, run);
  void run.catch(() => {}).finally(() => { if (repoChain.get(repo) === run) repoChain.delete(repo); });
  return run;
}
