// server/gh/status.ts
//
// Read-only PR status for the console: a single `gh pr view --json …` folded
// into a compact summary (check rollup + PR state + mergeability + review).
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SessionStore } from "../agents/store.js";
import { ghJson as defaultGhJson, GhError } from "./exec.js";
import { listRepos } from "./repos.js";
import { resolveWorkspaceDir } from "../defaults.js";

export type CheckRollup = "success" | "failure" | "pending" | "none";
export type PrStatus = {
  prState: string; mergeable: string; reviewDecision: string; url: string;
  checks: { total: number; passed: number; failed: number; pending: number; rollup: CheckRollup };
};
export type GhJsonRunner = <T>(args: string[], opts?: { cwd?: string }) => Promise<T>;

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "EXPECTED"]);
const FAIL = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// A rollup entry is either a CheckRun (status/conclusion) or a StatusContext (state).
function classifyEntry(e: any): "passed" | "failed" | "pending" {
  if (e.status && e.status !== "COMPLETED") return "pending"; // IN_PROGRESS / QUEUED
  const v = String(e.conclusion ?? e.state ?? "").toUpperCase();
  if (PASS.has(v)) return "passed";
  if (FAIL.has(v)) return "failed";
  return "pending"; // "", PENDING, or unknown
}

// Fold a statusCheckRollup array (mixed CheckRun / StatusContext entries) into
// per-state counts + a single rollup state. Shared by summarizePr and the cockpit.
export type CheckCounts = { total: number; passed: number; failed: number; pending: number; rollup: CheckRollup };
export function foldChecks(entries: any[]): CheckCounts {
  const rollup: any[] = Array.isArray(entries) ? entries : [];
  let passed = 0, failed = 0, pending = 0;
  for (const e of rollup) {
    const c = classifyEntry(e);
    if (c === "passed") passed++; else if (c === "failed") failed++; else pending++;
  }
  const total = rollup.length;
  return { total, passed, failed, pending, rollup: failed > 0 ? "failure" : pending > 0 ? "pending" : total > 0 ? "success" : "none" };
}

export function checksRollup(entries: any[]): CheckRollup {
  return foldChecks(entries).rollup;
}

// Per-check detail for the cockpit's expandable CI view. An entry is either a
// CheckRun (name/detailsUrl/startedAt/completedAt) or a StatusContext
// (context/targetUrl) — normalize both to one shape.
export type CheckRunInfo = { name: string; status: "passed" | "failed" | "pending"; url: string; durationMs: number | null };
export function describeChecks(entries: any[]): CheckRunInfo[] {
  const rollup: any[] = Array.isArray(entries) ? entries : [];
  return rollup.map((e) => {
    const started = Date.parse(e.startedAt ?? "");
    const completed = Date.parse(e.completedAt ?? "");
    return {
      name: String(e.name ?? e.context ?? "check"),
      status: classifyEntry(e),
      url: String(e.detailsUrl ?? e.targetUrl ?? ""),
      durationMs: Number.isNaN(started) || Number.isNaN(completed) ? null : Math.max(0, completed - started),
    };
  });
}

export function summarizePr(view: any): PrStatus {
  return {
    prState: String(view?.state ?? ""),
    mergeable: String(view?.mergeable ?? ""),
    reviewDecision: String(view?.reviewDecision ?? ""),
    url: String(view?.url ?? ""),
    checks: foldChecks(view?.statusCheckRollup),
  };
}

export async function fetchPrStatus(repoPath: string, pr: number, ghJson: GhJsonRunner): Promise<PrStatus> {
  const view = await ghJson<any>(
    ["pr", "view", String(pr), "--json", "state,mergeable,reviewDecision,url,statusCheckRollup"],
    { cwd: repoPath },
  );
  return summarizePr(view);
}

// What a merge needs to know about a PR, read fresh just before it: the state, draft or not,
// the merge state, the base and head branches, the head commit, GitHub's title and the check
// counts. Read-only.
export type PrMergeFacts = {
  number: number; url: string; state: string; draft: boolean; mergeable: string; base: string;
  head: string; headSha: string; title: string; checks: CheckCounts;
};
export async function fetchPrMergeFacts(repoPath: string, pr: number, ghJson: GhJsonRunner): Promise<PrMergeFacts> {
  const v = await ghJson<any>(
    ["pr", "view", String(pr), "--json", "number,url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,title,statusCheckRollup"],
    { cwd: repoPath },
  );
  return {
    number: Number(v?.number ?? pr), url: String(v?.url ?? ""), state: String(v?.state ?? ""), draft: v?.isDraft === true,
    mergeable: String(v?.mergeable ?? ""), base: String(v?.baseRefName ?? ""), head: String(v?.headRefName ?? ""),
    headSha: String(v?.headRefOid ?? ""), title: String(v?.title ?? ""), checks: foldChecks(v?.statusCheckRollup),
  };
}

// owner/repo out of a PR url — the cockpit keys rows by this slug.
export function prSlug(url: string): string | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

export type AgentPr = { number: number; url: string; state: string; slug: string };

// The PR belonging to an agent's branch: the one recorded on the agent (opened
// via the console) or, failing that, whatever `gh pr view <branch>` finds —
// which covers PRs the agent opened itself with `gh pr create` in its own
// terminal, where the console never learns the number. Null when there's no PR
// or gh can't answer (offline / not authed) — callers degrade to no-PR UI.
export async function agentOpenPr(
  rec: { repo: string; branch: string; prNumber?: number },
  ghJson: GhJsonRunner,
): Promise<AgentPr | null> {
  if (!rec.repo || !rec.branch) return null;
  try {
    const ref = rec.prNumber ? String(rec.prNumber) : rec.branch;
    const view = await ghJson<any>(
      ["pr", "view", ref, "--json", "number,url,state"],
      { cwd: rec.repo },
    );
    const url = String(view?.url ?? "");
    const number = Number(view?.number);
    const slug = prSlug(url);
    if (!slug || !Number.isInteger(number) || number <= 0) return null;
    return { number, url, state: String(view?.state ?? ""), slug };
  } catch {
    return null; // no PR for this branch, or gh unavailable
  }
}

const KIND_STATUS: Record<string, number> = {
  not_authed: 401, no_github_remote: 400, not_found: 404, rate_limited: 429, unknown: 502,
};
function fail(reply: FastifyReply, e: unknown) {
  const kind = e instanceof GhError ? e.kind : "unknown";
  reply.code(KIND_STATUS[kind] ?? 502);
  return { error: e instanceof Error ? e.message : String(e), kind };
}

export function registerGhStatusApi(app: FastifyInstance, deps: { store: SessionStore; ghJson?: GhJsonRunner }): void {
  const ghJson = deps.ghJson ?? defaultGhJson;

  // Status for the PR an agent opened. 200 with { pr: null } if no PR yet.
  app.get("/api/agents/:id/checks", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await deps.store.load(id);
    if (!rec) { reply.code(404); return { error: "unknown agent" }; }
    if (!rec.prNumber) return { pr: null };
    try { return { pr: rec.prNumber, ...(await fetchPrStatus(rec.repo, rec.prNumber, ghJson)) }; }
    catch (e) { return fail(reply, e); }
  });

  // The agent's PR (recorded or found by head branch), with its live state so
  // the UI can offer "See PR" only while it's actually open.
  app.get("/api/agents/:id/pr", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const rec = await deps.store.load(id);
    if (!rec) { reply.code(404); return { error: "unknown agent" }; }
    return { pr: await agentOpenPr(rec, ghJson) };
  });

  // Status for an arbitrary repo+pr (the PR-review panel).
  app.get("/api/gh/checks", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { repo?: string; pr?: string };
    const pr = Number(q.pr);
    if (!Number.isInteger(pr) || pr <= 0) { reply.code(400); return { error: "pr must be a positive integer" }; }
    const workspaceDir = resolveWorkspaceDir();
    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => r.name === q.repo || r.slug === q.repo);
    if (!repo) { reply.code(400); return { error: "unknown repo" }; }
    try { return { pr, ...(await fetchPrStatus(repo.path, pr, ghJson)) }; }
    catch (e) { return fail(reply, e); }
  });
}
