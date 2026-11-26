// server/pr/api.ts
//
// PR diff review: fetch a GitHub pull request by number from any workspace repo
// that has a github.com `origin`, compute the same diff GitHub shows under
// "Files changed" (merge-base..head, i.e. a three-dot diff), and return it as a
// unified patch the existing <DiffViewer> renders file-by-file, line-by-line.
//
// Read-only with respect to the target repos: we only `git fetch` (which updates
// FETCH_HEAD / remote-tracking refs) and `git diff` — never touch their working
// tree or local branches. `gh` is used only to read the PR's base branch (which
// is GitHub metadata git can't derive); the diff itself is pure git.
import type { FastifyInstance } from "fastify";
import { basename, resolve } from "node:path";
import { runGit } from "../agents/git.js";
import type { SessionStore } from "../agents/store.js";
import { listRepos } from "../gh/repos.js";
import { ghJson } from "../gh/exec.js";


// A base ref the operator may override with. Conservative on purpose — it is
// passed to `git fetch origin <ref>`, so keep it to branch-name-ish characters.
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const GIT_MAX_BUFFER = 96 * 1024 * 1024; // big PRs produce big patches

async function git(path: string, args: string[]): Promise<string> {
  const { stdout } = await runGit(path, ["-C", path, ...args], { maxBuffer: GIT_MAX_BUFFER }, path);
  return stdout;
}

// Serialize git work per-repo: two requests against the same repo must not
// interleave their `fetch` calls, or one's FETCH_HEAD clobbers the other's
// before it is read back.
const locks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// The range of a PR as GitHub's "Files changed" shows it, in the CONSOLE's own repo (never an
// agent's clone): fetch its head and capture the sha before any further fetch overwrites
// FETCH_HEAD; its base (the PR's ACTUAL base from gh with the console's login, else the default
// branch); merge-base..head. The caller holds withRepoLock. The user's review (POST /api/pr/diff)
// and an agent's read of its worker's PR (GET /api/agents/:id/pr-diff) both use it.
async function prRange(repoPath: string, pr: number, baseIn = ""): Promise<{ base: string; headSha: string; baseSha: string; mergeBase: string }> {
  let base = baseIn;
  await git(repoPath, ["fetch", "--no-tags", "--quiet", "origin", `pull/${pr}/head`]);
  const headSha = (await git(repoPath, ["rev-parse", "FETCH_HEAD"])).trim();
  if (!base) {
    try {
      const view = await ghJson<{ baseRefName?: string }>(["pr", "view", String(pr), "--json", "baseRefName"], { cwd: repoPath });
      const b = (view.baseRefName ?? "").trim();
      if (b && REF_RE.test(b)) base = b;
    } catch { /* fall through to default-branch resolution */ }
  }
  if (!base) {
    const symref = await git(repoPath, ["ls-remote", "--symref", "origin", "HEAD"]);
    base = symref.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/)?.[1] ?? "main";
  }
  await git(repoPath, ["fetch", "--no-tags", "--quiet", "origin", base]);
  const baseSha = (await git(repoPath, ["rev-parse", "FETCH_HEAD"])).trim();
  const mergeBase = (await git(repoPath, ["merge-base", baseSha, headSha])).trim();
  return { base, headSha, baseSha, mergeBase };
}

// An agent's read of its worker's PR (a lead or the fleet master, with strong protection: they
// have no GitHub login, and they run nothing in a worker's folder): at most 1 MB in one answer.
export const AGENT_READ_MAX = 1024 * 1024;
export const PR_READ_ERR = {
  noPr: "This worker has no pull request that the console recorded.",
  tooLarge: "The diff of the pull request is larger than 1 MB: read it file by file (agents pr-file <id> <path>).",
  fileTooLarge: "The file is larger than 1 MB.",
  notARepo: "The worker's repo is not a repo of this console.",
} as const;
const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
// The diff flags of an agent's read: no external diff driver and no text conversion, whatever a
// config says (as the clone views, since #112). The console's own repo config is the console's
// today; these keep a later config from running a program for an agent's read.
const AGENT_DIFF = ["--no-color", "--no-ext-diff", "--no-textconv"] as const;

export function registerPrApi(app: FastifyInstance, deps: { workspaceDir: string; store?: Pick<SessionStore, "load"> }): void {
  const { workspaceDir } = deps;

  // The PR RECORDED on the worker's record (the number the console wrote when it opened it) and
  // the console's own repo of it: never a repo or a number that the caller gives.
  const recordedPr = async (id: string): Promise<{ repo: { name: string; slug: string; path: string }; pr: number } | { code: number; error: string }> => {
    const rec = deps.store ? await deps.store.load(id) : null;
    if (!rec) return { code: 404, error: "unknown agent" };
    if (!rec.prNumber || !rec.repo || !Number.isInteger(rec.prNumber) || rec.prNumber <= 0) return { code: 404, error: PR_READ_ERR.noPr };
    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => resolve(r.path) === resolve(rec.repo)) ?? repos.find((r) => r.name === basename(rec.repo));
    return repo ? { repo, pr: rec.prNumber } : { code: 404, error: PR_READ_ERR.notARepo };
  };

  // Repos available to review PRs from (those with a github.com origin).
  app.get("/api/pr/repos", async () => {
    const repos = await listRepos(workspaceDir);
    return { repos: repos.map((r) => ({ name: r.name, slug: r.slug })) };
  });

  // Load a PR's diff. Body: { repo, pr, base? }. `repo` matches either the
  // directory name or the owner/repo slug; `base` defaults to the repo's
  // GitHub default branch.
  app.post("/api/pr/diff", async (req, reply) => {
    const body = (req.body ?? {}) as { repo?: string; pr?: number | string; base?: string };

    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => r.name === body.repo || r.slug === body.repo);
    if (!repo) { reply.code(400); return { error: "unknown repo" }; }

    const pr = Number(body.pr);
    if (!Number.isInteger(pr) || pr <= 0) { reply.code(400); return { error: "PR must be a positive integer" }; }

    let base = (body.base ?? "").trim();
    if (base && !REF_RE.test(base)) { reply.code(400); return { error: "invalid base ref" }; }

    try {
      const result = await withRepoLock(repo.path, async () => {
        const r = await prRange(repo.path, pr, base);
        const diff = await git(repo.path, ["diff", "--no-color", r.mergeBase, r.headSha]);
        // 5. Full file list at the PR head, so the tree can show every file,
        //    not just the changed ones.
        const tree = (await git(repo.path, ["ls-tree", "-r", "--name-only", r.headSha]))
          .split("\n").filter(Boolean);
        return { diff, ...r, tree };
      });

      return { repo: repo.name, slug: repo.slug, pr, ...result };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      const detail = String(err.stderr || err.message || e).trim().slice(0, 600);
      reply.code(502);
      return { error: `git failed: ${detail}` };
    }
  });

  // The diff of a worker's recorded PR, as GitHub shows it: the console's own fetch in its own
  // repo (prRange, the user's view), never the worker's clone. Its changed files, and the patch;
  // over 1 MB a 413 with the files, to read one by one.
  app.get("/api/agents/:id/pr-diff", async (req, reply) => {
    const got = await recordedPr((req.params as { id: string }).id);
    if ("error" in got) return reply.code(got.code).send({ error: got.error });
    const { repo, pr } = got;
    try {
      const r = await withRepoLock(repo.path, async () => {
        const range = await prRange(repo.path, pr);
        const files = (await git(repo.path, ["diff", ...AGENT_DIFF, "--name-status", range.mergeBase, range.headSha]))
          .split("\n").filter(Boolean).map((l) => { const [status, ...p] = l.split("\t"); return { status, path: p.join("\t") }; });
        const diff = await git(repo.path, ["diff", ...AGENT_DIFF, range.mergeBase, range.headSha]);
        return { ...range, files, diff };
      });
      const head = { repo: repo.name, slug: repo.slug, pr, base: r.base, headSha: r.headSha, mergeBase: r.mergeBase, files: r.files };
      if (bytes(r.diff) > AGENT_READ_MAX) return reply.code(413).send({ error: PR_READ_ERR.tooLarge, ...head });
      return { ...head, diff: r.diff };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return reply.code(502).send({ error: `git failed: ${String(err.stderr || err.message || e).trim().slice(0, 400)}` });
    }
  });

  // One file of a worker's recorded PR: its full-context diff when the PR changes it, else its
  // content at the PR head. The same fetch as above; at most 1 MB.
  app.get("/api/agents/:id/pr-file", async (req, reply) => {
    const path = String((req.query as { path?: unknown }).path ?? "");
    if (!path || path.includes("\0") || path.startsWith("-")) return reply.code(400).send({ error: "invalid path" });
    const got = await recordedPr((req.params as { id: string }).id);
    if ("error" in got) return reply.code(got.code).send({ error: got.error });
    const { repo, pr } = got;
    try {
      const out = await withRepoLock(repo.path, async () => {
        const range = await prRange(repo.path, pr);
        const changed = (await git(repo.path, ["diff", ...AGENT_DIFF, "--name-only", range.mergeBase, range.headSha, "--", path])).trim() !== "";
        const text = changed
          ? await git(repo.path, ["diff", ...AGENT_DIFF, "-U1000000", range.mergeBase, range.headSha, "--", path])
          : await git(repo.path, ["show", "--no-textconv", `${range.headSha}:${path}`]);
        return { changed, text, headSha: range.headSha };
      });
      if (bytes(out.text) > AGENT_READ_MAX) return reply.code(413).send({ error: PR_READ_ERR.fileTooLarge });
      return { repo: repo.name, pr, path, headSha: out.headSha, changed: out.changed, ...(out.changed ? { patch: out.text } : { content: out.text }) };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return reply.code(502).send({ error: `git failed: ${String(err.stderr || err.message || e).trim().slice(0, 400)}` });
    }
  });

  // One file's content for the right pane. For a changed file we return the
  // full-context diff (whole file, with +/- highlighting); for any other file
  // we return its full content at the PR head so it can be browsed/read.
  // headSha/mergeBase come from a prior /api/pr/diff response (validated here).
  const SHA = /^[0-9a-fA-F]{7,40}$/;
  app.post("/api/pr/file", async (req, reply) => {
    const body = (req.body ?? {}) as { repo?: string; path?: string; headSha?: string; mergeBase?: string; changed?: boolean };

    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => r.name === body.repo || r.slug === body.repo);
    if (!repo) { reply.code(400); return { error: "unknown repo" }; }

    const path = String(body.path ?? "");
    if (!path || path.includes("\0") || path.startsWith("-")) { reply.code(400); return { error: "invalid path" }; }

    const headSha = String(body.headSha ?? "");
    if (!SHA.test(headSha)) { reply.code(400); return { error: "invalid headSha" }; }

    try {
      if (body.changed) {
        const mergeBase = String(body.mergeBase ?? "");
        if (!SHA.test(mergeBase)) { reply.code(400); return { error: "invalid mergeBase" }; }
        // -U with a huge context → the entire file as a diff (all lines shown).
        const patch = await git(repo.path, ["diff", "--no-color", "-U1000000", mergeBase, headSha, "--", path]);
        return { changed: true, patch };
      }
      const content = await git(repo.path, ["show", `${headSha}:${path}`]);
      return { changed: false, content };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      const detail = String(err.stderr || err.message || e).trim().slice(0, 400);
      reply.code(502);
      return { error: `git failed: ${detail}` };
    }
  });
}
