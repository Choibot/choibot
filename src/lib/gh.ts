import { chiefFetch, refusalSentence } from "./chief";
// src/lib/gh.ts — client for the console's GitHub (gh) endpoints.
export type PrSuggest = { title: string; body: string; existing?: { url: string; number?: number } };

export async function suggestPr(agentId: string): Promise<PrSuggest> {
  const r = await chiefFetch(`/api/agents/${agentId}/pr/suggest`);
  if (!r.ok) return { title: "", body: "" };
  return (await r.json()) as PrSuggest;
}

export async function openPr(
  agentId: string,
  input: { title: string; body: string; draft?: boolean },
): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }> {
  const r = await chiefFetch(`/api/agents/${agentId}/pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: body.error ?? `failed (${r.status})` };
  return { ok: true, url: body.url, number: body.number };
}

export type PrStatus = {
  pr: number | null;
  prState?: string; mergeable?: string; reviewDecision?: string; url?: string;
  checks?: { total: number; passed: number; failed: number; pending: number; rollup: "success" | "failure" | "pending" | "none" };
};

async function getJson(url: string): Promise<PrStatus | null> {
  try {
    const r = await chiefFetch(url);
    if (!r.ok) return null;
    return (await r.json()) as PrStatus;
  } catch { return null; }
}

export const fetchAgentChecks = (agentId: string) => getJson(`/api/agents/${agentId}/checks`);

// The agent's PR — recorded on the agent, or found by its head branch (covers
// PRs the agent opened itself with `gh pr create`). Null when none / offline.
export type AgentPr = { number: number; url: string; state: string; slug: string };
export async function fetchAgentPr(agentId: string): Promise<AgentPr | null> {
  try {
    const r = await chiefFetch(`/api/agents/${agentId}/pr`);
    if (!r.ok) return null;
    return (((await r.json()).pr) ?? null) as AgentPr | null;
  } catch { return null; }
}
export const fetchRepoChecks = (repo: string, pr: number) =>
  getJson(`/api/gh/checks?repo=${encodeURIComponent(repo)}&pr=${pr}`);

// Compact one-line summary. Order: checks · mergeability · review.
export function ciLabel(s: PrStatus): string {
  const c = s.checks;
  const parts: string[] = [];
  if (!c || c.total === 0) parts.push("no checks");
  else if (c.rollup === "failure") parts.push(`✗ ${c.failed} failing`);
  else if (c.rollup === "pending") parts.push(`● ${c.pending} pending`);
  else parts.push(`✓ ${c.passed}/${c.total} checks`);
  if (s.prState === "MERGED") parts.push("merged");
  else if (s.prState === "CLOSED") parts.push("closed");
  else if (s.mergeable === "CONFLICTING") parts.push("conflicts");
  else if (s.mergeable === "MERGEABLE") parts.push("mergeable");
  if (s.reviewDecision === "APPROVED") parts.push("approved");
  else if (s.reviewDecision === "CHANGES_REQUESTED") parts.push("changes requested");
  return parts.join(" · ");
}

export type CockpitChecks = { total: number; passed: number; failed: number; pending: number; rollup: "success" | "failure" | "pending" | "none" };
export type CheckRun = { name: string; status: "passed" | "failed" | "pending"; url: string; durationMs: number | null };
export type CockpitPr = {
  number: number; title: string; author: string; url: string;
  rollup: "success" | "failure" | "pending" | "none"; mergeable?: string;
  reviewDecision?: string; updatedAt?: string; checks?: CockpitChecks; checkRuns?: CheckRun[];
};
export type CockpitIssue = { number: number; title: string; author: string; url: string; createdAt?: string };
export type CockpitRepo = { name: string; slug: string; prs: CockpitPr[]; issues: CockpitIssue[]; error?: string };

export async function fetchCockpit(): Promise<CockpitRepo[]> {
  try {
    const r = await chiefFetch("/api/gh/cockpit");
    if (!r.ok) return [];
    return ((await r.json()).repos ?? []) as CockpitRepo[];
  } catch { return []; }
}

// Lazy CI-output detail for one PR (fresh runs + deployment preview URLs +
// failing-run log tails). Fetched when the cockpit's CI view expands.
export type DeploymentInfo = { environment: string; state: string; url: string };
export type FailedLog = { runId: string; tail: string };
export type PrCi = { checkRuns: CheckRun[]; deployments: DeploymentInfo[]; logs: FailedLog[] };

// `fresh`: read past the server's 60 s cache (a pr ticket whose rollup word just changed).
export async function fetchPrCi(repo: string, pr: number, fresh = false): Promise<PrCi | null> {
  try {
    const r = await chiefFetch(`/api/gh/pr/ci?repo=${encodeURIComponent(repo)}&pr=${pr}${fresh ? "&fresh=1" : ""}`);
    if (!r.ok) return null;
    return (await r.json()) as PrCi;
  } catch { return null; }
}

export function repoSummary(r: { slug: string; prs: unknown[]; issues: unknown[] }): string {
  const p = r.prs.length, i = r.issues.length;
  return `${r.slug} · ${p} PR${p === 1 ? "" : "s"} · ${i} issue${i === 1 ? "" : "s"}`;
}

// --- write-action client fns (POST to the gh write endpoints) ---
type Ok = { ok: true } | { ok: false; error: string };
async function post(url: string, body: unknown): Promise<Ok> {
  try {
    const r = await chiefFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: refusalSentence(r.status, j) ?? j.error ?? `failed (${r.status})` };
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

export const mergePr = (repo: string, pr: number, method: "squash" | "merge" | "rebase") =>
  post("/api/gh/pr/merge", { repo, pr, method });
export const closePr = (repo: string, pr: number) => post("/api/gh/pr/close", { repo, pr });
export const reopenPr = (repo: string, pr: number) => post("/api/gh/pr/reopen", { repo, pr });
export const closeIssue = (repo: string, number: number) => post("/api/gh/issue/close", { repo, number });
export const reopenIssue = (repo: string, number: number) => post("/api/gh/issue/reopen", { repo, number });
export const comment = (repo: string, kind: "pr" | "issue", number: number, body: string) =>
  post("/api/gh/comment", { repo, kind, number, body });
