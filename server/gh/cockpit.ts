// server/gh/cockpit.ts
//
// Read-only cockpit: open PRs (+ CI rollup) and open issues across the
// workspace's GitHub repos. Per-repo failure tolerant; result cached ~30s.
import type { FastifyInstance } from "fastify";
import { ghJson as defaultGhJson } from "./exec.js";
import { listRepos, type Repo } from "./repos.js";
import { foldChecks, describeChecks, type CheckCounts, type CheckRollup, type CheckRunInfo } from "./status.js";
import { resolveWorkspaceDir } from "../defaults.js";

export type CockpitPr = {
  number: number; title: string; author: string; url: string;
  rollup: CheckRollup; mergeable: string; reviewDecision: string; updatedAt: string;
  checks: CheckCounts; checkRuns: CheckRunInfo[];
};
export type CockpitIssue = { number: number; title: string; author: string; url: string; createdAt: string };
export type CockpitRepo = { name: string; slug: string; prs: CockpitPr[]; issues: CockpitIssue[]; error?: string };
export type GhJsonRunner = <T>(args: string[], opts?: { cwd?: string }) => Promise<T>;

const LIMIT = "30";

// Module-scoped cockpit cache so human-triggered write actions (in ./actions.ts)
// can bust it after a merge/close/reopen/comment and have the dashboard reflect
// the change on the next refresh.
let cockpitCache: { at: number; data: CockpitRepo[] } | null = null;
export function bustCockpitCache(): void { cockpitCache = null; }

export async function fetchRepoCockpit(repo: Repo, ghJson: GhJsonRunner): Promise<CockpitRepo> {
  try {
    const [prs, issues] = await Promise.all([
      ghJson<any[]>(["pr", "list", "--json", "number,title,author,state,statusCheckRollup,url,mergeable,reviewDecision,updatedAt", "--limit", LIMIT], { cwd: repo.path }),
      ghJson<any[]>(["issue", "list", "--json", "number,title,author,url,createdAt", "--limit", LIMIT], { cwd: repo.path }),
    ]);
    return {
      name: repo.name, slug: repo.slug,
      prs: (prs ?? []).map((p) => {
        const checks = foldChecks(p.statusCheckRollup);
        return {
          number: p.number, title: String(p.title ?? ""), author: String(p.author?.login ?? ""),
          url: String(p.url ?? ""), rollup: checks.rollup, mergeable: String(p.mergeable ?? ""),
          reviewDecision: String(p.reviewDecision ?? ""), updatedAt: String(p.updatedAt ?? ""),
          checks, checkRuns: describeChecks(p.statusCheckRollup),
        };
      }),
      issues: (issues ?? []).map((i) => ({
        number: i.number, title: String(i.title ?? ""), author: String(i.author?.login ?? ""),
        url: String(i.url ?? ""), createdAt: String(i.createdAt ?? ""),
      })),
    };
  } catch (e) {
    return { name: repo.name, slug: repo.slug, prs: [], issues: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchCockpit(repos: Repo[], ghJson: GhJsonRunner): Promise<CockpitRepo[]> {
  // allSettled is belt-and-suspenders — fetchRepoCockpit already catches — but
  // guarantees one rejected promise never rejects the whole aggregate.
  const settled = await Promise.allSettled(repos.map((r) => fetchRepoCockpit(r, ghJson)));
  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value
      : { name: repos[i].name, slug: repos[i].slug, prs: [], issues: [], error: String(s.reason) });
}

export function registerGhCockpitApi(app: FastifyInstance, deps: { ghJson?: GhJsonRunner; now?: () => number }): void {
  const ghJson = deps.ghJson ?? defaultGhJson;
  const now = deps.now ?? Date.now;
  const workspaceDir = resolveWorkspaceDir();
  const TTL = 30_000;

  app.get("/api/gh/cockpit", async () => {
    const t = now();
    if (cockpitCache && t - cockpitCache.at < TTL) return { repos: cockpitCache.data, cached: true };
    const data = await fetchCockpit(await listRepos(workspaceDir), ghJson);
    if (data.length > 0 && !data.every((r) => r.error)) cockpitCache = { at: t, data };
    return { repos: data, cached: false };
  });
}
