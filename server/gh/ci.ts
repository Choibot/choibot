// server/gh/ci.ts
//
// The "output" layer of CI for one PR, loaded lazily when the cockpit's CI
// view expands: fresh per-check runs, deployment preview URLs (Vercel et al
// create GitHub Deployments whose latest status carries environment_url), and
// the failing GitHub-Actions runs' log tails. Cached ~60s per repo#pr.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { gh as defaultGh, ghJson as defaultGhJson } from "./exec.js";
import { listRepos, type Repo } from "./repos.js";
import { describeChecks, type CheckRunInfo } from "./status.js";
import { resolveWorkspaceDir } from "../defaults.js";

export type DeploymentInfo = { environment: string; state: string; url: string };
export type FailedLog = { runId: string; tail: string };
export type PrCi = { checkRuns: CheckRunInfo[]; deployments: DeploymentInfo[]; logs: FailedLog[] };

export type GhJsonRunner = <T>(args: string[], opts?: { cwd?: string }) => Promise<T>;
export type GhTextRunner = (args: string[], opts?: { cwd?: string }) => Promise<string>;

const LOG_TAIL_LINES = 80;
const LOG_TAIL_BYTES = 8_000;
const MAX_LOG_RUNS = 2;
const MAX_DEPLOYMENTS = 5;

export function extractRunId(url: string): string | null {
  return url.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;
}

export function tailOf(text: string): string {
  const lines = text.split("\n");
  return lines.slice(-LOG_TAIL_LINES).join("\n").slice(-LOG_TAIL_BYTES).trim();
}

// The second source of a preview URL, for a repo whose head commit has no GitHub deployment:
// the Vercel bot's comment on the PR, which links each project's preview as "[Preview](url)"
// (older: "[Visit Preview](url)"). The URL is the one Vercel wrote; nothing is built here.
const VERCEL_PREVIEW_LINK = /\[(?:Visit )?Preview\]\((https?:\/\/[^)\s]+)\)/g;
export function vercelCommentPreviews(comments: unknown, state: string): DeploymentInfo[] {
  const urls = new Set<string>();
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!/^vercel(\[bot\])?$/.test(String(c?.author?.login ?? ""))) continue;
    for (const m of String(c?.body ?? "").matchAll(VERCEL_PREVIEW_LINK)) urls.add(m[1]);
  }
  return [...urls].slice(0, MAX_DEPLOYMENTS).map((url) => ({ environment: "Preview", state, url }));
}

export async function fetchPrCi(repo: Repo, pr: number, ghJson: GhJsonRunner, ghText: GhTextRunner): Promise<PrCi> {
  const view = await ghJson<any>(
    ["pr", "view", String(pr), "--json", "statusCheckRollup,headRefOid"],
    { cwd: repo.path },
  );
  const checkRuns = describeChecks(view?.statusCheckRollup);

  // Deployments for the head sha. Optional: repos without deployments (or with
  // API hiccups) still get runs + logs.
  let deployments: DeploymentInfo[] = [];
  if (view?.headRefOid) {
    try {
      const deps = await ghJson<any[]>(
        ["api", `repos/${repo.slug}/deployments?sha=${view.headRefOid}&per_page=${MAX_DEPLOYMENTS}`],
        { cwd: repo.path },
      );
      deployments = (
        await Promise.all(
          (deps ?? []).slice(0, MAX_DEPLOYMENTS).map(async (d) => {
            const statuses = await ghJson<any[]>(
              ["api", `repos/${repo.slug}/deployments/${d.id}/statuses?per_page=1`],
              { cwd: repo.path },
            ).catch(() => []);
            const s = statuses?.[0];
            return {
              environment: String(d.environment ?? ""),
              state: String(s?.state ?? "unknown"),
              url: String(s?.environment_url || s?.target_url || ""),
            };
          }),
        )
      ).filter((d) => d.url);
      // newest-first from the API; keep only the latest per environment
      const seen = new Set<string>();
      deployments = deployments.filter((d) => (seen.has(d.environment) ? false : (seen.add(d.environment), true)));
    } catch { /* optional */ }
  }

  // No deployment, but a Vercel check: one more read, of the PR's comments.
  const vercel = checkRuns.filter((r) => /vercel/i.test(r.name));
  if (deployments.length === 0 && vercel.length > 0) {
    try {
      const c = await ghJson<any>(["pr", "view", String(pr), "--json", "comments"], { cwd: repo.path });
      const state = vercel.some((r) => r.status === "failed") ? "failure" : vercel.some((r) => r.status === "pending") ? "pending" : "success";
      deployments = vercelCommentPreviews(c?.comments, state);
    } catch { /* optional */ }
  }

  // Failing GitHub-Actions runs → log tails ("why is it red" without leaving).
  const failedRunIds = [
    ...new Set(checkRuns.filter((r) => r.status === "failed").map((r) => extractRunId(r.url)).filter(Boolean)),
  ].slice(0, MAX_LOG_RUNS) as string[];
  const logs = (
    await Promise.all(
      failedRunIds.map(async (runId) => {
        try { return { runId, tail: tailOf(await ghText(["run", "view", runId, "--log-failed"], { cwd: repo.path })) }; }
        catch { return null; }
      }),
    )
  ).filter((l): l is FailedLog => l !== null && l.tail.length > 0);

  return { checkRuns, deployments, logs };
}

export function registerGhCiApi(app: FastifyInstance, deps: { ghJson?: GhJsonRunner; ghText?: GhTextRunner; now?: () => number }): void {
  const ghJson = deps.ghJson ?? defaultGhJson;
  const ghText = deps.ghText ?? defaultGh;
  const now = deps.now ?? Date.now;
  const workspaceDir = resolveWorkspaceDir();
  const TTL = 60_000;
  const cache = new Map<string, { at: number; data: PrCi }>();

  app.get("/api/gh/pr/ci", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { repo?: string; pr?: string; fresh?: string };
    const pr = Number(q.pr);
    if (!Number.isInteger(pr) || pr <= 0) { reply.code(400); return { error: "pr must be a positive integer" }; }
    const repos = await listRepos(workspaceDir);
    const repo = repos.find((r) => r.name === q.repo || r.slug === q.repo);
    if (!repo) { reply.code(400); return { error: "unknown repo" }; }
    const key = `${repo.slug}#${pr}`;
    const hit = cache.get(key);
    const t = now();
    // `fresh=1`: a pr ticket's rollup word changed, so the kept read is older than the change.
    if (q.fresh !== "1" && hit && t - hit.at < TTL) return { ...hit.data, cached: true };
    try {
      const data = await fetchPrCi(repo, pr, ghJson, ghText);
      cache.set(key, { at: t, data });
      return { ...data, cached: false };
    } catch (e) {
      reply.code(502);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
}
