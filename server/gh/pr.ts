// server/gh/pr.ts
//
// Push an agent's branch and open a PR from it (PR-first integration). The gh
// token lives only in this server process. With the chief gate: the paired user for
// any agent, or an agent (or lead) for itself only; never the master, the Coordinator,
// a cron task or a request with no identity. An agent with its own clone (strong
// protection) goes through clonepr.ts; every other agent as before.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { runGit } from "../agents/git.js";
import type { SessionStore } from "../agents/store.js";
import { commitPending, pushBranch } from "../agents/reconcile.js";
import { CLONE_NO_HELPER, agentClones, agentRef, cloneFolders, isClone } from "../agents/agentclone.js";
import { gateRoute, pairRequired, type ChiefGate } from "../chief/gate.js";
import { ClonePrError, clonePrInput, clonePushAndPr, fetchBaseFromGitHub } from "./clonepr.js";
import { gh as defaultGh, GhError, extractPrUrl } from "./exec.js";

export type GhRunner = (args: string[], opts?: { cwd?: string; input?: string }) => Promise<string>;

export const PR_CALLER_ONLY = "Only the user, or the agent itself, can push its branch and open its pull request.";
// false after the refusal is sent. No gate (chief off): as before, no check.
async function gatePrCaller(gate: ChiefGate | undefined, req: FastifyRequest, reply: FastifyReply, id: string): Promise<boolean> {
  if (!gate) return true;
  if (!gateRoute(gate, reply)) return false;
  const c = await gate.caller(req);
  if (c.level === "user") return true;
  if ((c.level === "agent" || c.level === "lead") && c.agentId === id) return true;
  if (c.agentHeaders) reply.code(403).send({ error: PR_CALLER_ONLY });
  else pairRequired(gate, reply);
  return false;
}

// One push of an agent at a time: a second call waits for the first.
const agentChain = new Map<string, Promise<unknown>>();
function oneAtATime<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (agentChain.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  agentChain.set(id, run);
  void run.catch(() => {}).finally(() => { if (agentChain.get(id) === run) agentChain.delete(id); });
  return run;
}

// First non-empty commit line -> title; the remainder -> body. Falls back to
// the branch name when there are no commits between base and head.
export function suggestFromLog(log: string, branch: string): { title: string; body: string } {
  const lines = log.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return { title: branch, body: "" };
  const title = lines[firstIdx].trim();
  const body = lines.slice(firstIdx + 1).join("\n").trim();
  return { title, body };
}

export async function createPr(
  a: { repoPath: string; base: string; head: string; title: string; body: string; draft?: boolean },
  ghRun: GhRunner,
): Promise<{ url: string; number: number }> {
  const args = ["pr", "create", "--base", a.base, "--head", a.head, "--title", a.title, "--body", a.body];
  if (a.draft) args.push("--draft");
  const out = await ghRun(args, { cwd: a.repoPath });
  const url = extractPrUrl(out);
  if (!url) throw new GhError("unknown", `gh pr create returned no PR url: ${out.trim().slice(0, 200)}`);
  return { url, number: Number(url.match(/\/pull\/(\d+)/)![1]) };
}

const KIND_STATUS: Record<string, number> = {
  not_authed: 401, no_github_remote: 400, not_fast_forward: 409,
  already_exists: 409, not_found: 404, rate_limited: 429, unknown: 502,
};

// `ghCwd`: a folder of the console's app data dir, the cwd of gh for an agent with its own clone
// (in no repo; made when needed).
export function registerGhPrApi(app: FastifyInstance, deps: { store: SessionStore; gh?: GhRunner; chief?: ChiefGate; ghCwd?: string }): void {
  const ghRun = deps.gh ?? defaultGh;

  // Suggested title/body for the create dialog (or the existing PR if opened).
  app.get("/api/agents/:id/pr/suggest", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await deps.store.load(id);
    if (!rec) { reply.code(404); return { error: "unknown agent" }; }
    if (rec.prUrl) return { title: "", body: "", existing: { url: rec.prUrl, number: rec.prNumber } };
    let log = "";
    // An agent with its own clone: its branch as the console fetched it last (refs/agents/<id>/).
    const head = isClone(rec) ? agentRef(rec.id, rec.branch) : rec.branch;
    try { log = (await runGit(rec.repo, ["-C", rec.repo, "log", `${rec.baseBranch}..${head}`, "--reverse", "--format=%B"], undefined, rec.repo)).stdout; }
    catch { /* branch/base may not exist yet — fall back to branch name */ }
    return suggestFromLog(log, rec.branch);
  });

  // Commit -> push branch -> gh pr create -> record on the agent. Idempotent:
  // if a PR is already recorded, return it.
  app.post("/api/agents/:id/pr", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(await gatePrCaller(deps.chief, req, reply, id))) return reply;
    const body = (req.body ?? {}) as { title?: string; body?: string; draft?: boolean };
    const rec = await deps.store.load(id);
    if (!rec) { reply.code(404); return { error: "unknown agent" }; }
    if (!rec.repo || !rec.branch) { reply.code(400); return { error: "agent has no branch to push" }; }
    // Strong protection: an agent with its own clone. Its commits are its own (no commit here); a
    // later call pushes new commits to the same pull request.
    if (isClone(rec)) {
      const x = agentClones();
      const folders = cloneFolders();
      if (!x || !folders) { reply.code(409); return { error: CLONE_NO_HELPER }; }
      const input = clonePrInput(body, rec.branch);
      if (typeof input === "string") { reply.code(400); return { error: input }; }
      try {
        return await oneAtATime(id, async () => {
          const cur = (await deps.store.load(id)) ?? rec;
          const pr = await clonePushAndPr(cur, input, { exec: x, folders, gh: ghRun, ghCwd: deps.ghCwd ?? process.cwd() });
          if (!cur.prUrl) await deps.store.patch(id, { prUrl: pr.url, prNumber: pr.number });
          return pr;
        });
      } catch (e) {
        if (e instanceof ClonePrError) { reply.code(e.code); return { error: e.message }; }
        if (e instanceof GhError && e.kind === "already_exists" && e.url) {
          const number = Number(e.url.match(/\/pull\/(\d+)/)?.[1]);
          await deps.store.patch(id, { prUrl: e.url, prNumber: number });
          return { url: e.url, number };
        }
        const kind = e instanceof GhError ? e.kind : "unknown";
        reply.code(KIND_STATUS[kind] ?? 502);
        return { error: e instanceof Error ? e.message : String(e), kind };
      }
    }
    if (rec.prUrl) return { url: rec.prUrl, number: rec.prNumber };

    const title = (body.title ?? "").trim() || rec.branch;
    const prBody = body.body ?? "";
    try {
      const committed = await commitPending(rec);
      if (!committed.ok) { reply.code(409); return { error: `could not commit: ${committed.message}`, kind: "commit_failed" }; }
      await pushBranch(rec, rec.branch);
      const pr = await createPr(
        { repoPath: rec.repo, base: rec.baseBranch, head: rec.branch, title, body: prBody, draft: body.draft },
        ghRun,
      );
      await deps.store.patch(id, { prUrl: pr.url, prNumber: pr.number });
      return pr;
    } catch (e) {
      // If the PR already existed, gh gives us its url — record and return it.
      if (e instanceof GhError && e.kind === "already_exists" && e.url) {
        const number = Number(e.url.match(/\/pull\/(\d+)/)?.[1]);
        await deps.store.patch(id, { prUrl: e.url, prNumber: number });
        return { url: e.url, number };
      }
      const kind = e instanceof GhError ? e.kind : "unknown";
      reply.code(KIND_STATUS[kind] ?? 502);
      return { error: e instanceof Error ? e.message : String(e), kind };
    }
  });

  // The agent (or the user) asks for the new state of the base: the console fetches it from GitHub
  // into its own repo. Then, in the agent's copy: `git fetch console` and `git merge console/<base>`.
  app.post("/api/agents/:id/fetch-base", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(await gatePrCaller(deps.chief, req, reply, id))) return reply;
    const rec = await deps.store.load(id);
    if (!rec) { reply.code(404); return { error: "unknown agent" }; }
    if (!rec.repo || !isClone(rec)) { reply.code(409); return { error: "Only an agent with its own copy of the repo needs this: other agents fetch the base themselves." }; }
    try {
      const r = await fetchBaseFromGitHub(rec.repo, rec.baseBranch);
      return { ...r, base: rec.baseBranch, next: `git fetch console && git merge console/${rec.baseBranch}` };
    } catch (e) {
      if (e instanceof ClonePrError) { reply.code(e.code); return { error: e.message }; }
      reply.code(502);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
}
