// src/lib/cockpit.ts — pure triage/format helpers behind the cockpit terminal view.
import type { CheckRun, CockpitIssue, CockpitPr, CockpitRepo } from "./gh";

export type Triage = "ready" | "failing" | "inflight";
export type Group = Triage | "issues";

export type CockpitItem =
  | { kind: "pr"; group: Triage; repo: string; slug: string; pr: CockpitPr; ts: number }
  | { kind: "issue"; group: "issues"; repo: string; slug: string; issue: CockpitIssue; ts: number };

export const GROUP_ORDER: Group[] = ["ready", "failing", "inflight", "issues"];
export const GROUP_LABEL: Record<Group, string> = {
  ready: "Ready", failing: "Failing", inflight: "In flight", issues: "Issues",
};

// Urgency triage: conflicts/red checks need a human, pending checks are in
// flight, everything else (green or no checks) is ready to act on.
export function triagePr(p: CockpitPr): Triage {
  if (p.mergeable === "CONFLICTING" || p.rollup === "failure") return "failing";
  if (p.rollup === "pending") return "inflight";
  return "ready";
}

// Flatten repos into one list, grouped by urgency, most recent first per group.
export function flattenCockpit(repos: CockpitRepo[]): CockpitItem[] {
  const items: CockpitItem[] = [];
  for (const r of repos) {
    for (const p of r.prs) items.push({ kind: "pr", group: triagePr(p), repo: r.name, slug: r.slug, pr: p, ts: Date.parse(p.updatedAt ?? "") || 0 });
    for (const i of r.issues) items.push({ kind: "issue", group: "issues", repo: r.name, slug: r.slug, issue: i, ts: Date.parse(i.createdAt ?? "") || 0 });
  }
  const rank = (g: Group) => GROUP_ORDER.indexOf(g);
  return items.sort((a, b) => rank(a.group) - rank(b.group) || b.ts - a.ts);
}

// Repo-first view: group items by repo (alphabetical, so the list is stable to
// navigate), keeping urgency order within each repo. Also tallies per-group
// counts so a collapsed repo header can still say what's inside.
export type RepoGroup = { slug: string; repo: string; items: CockpitItem[]; counts: Record<Group, number> };

export function groupByRepo(items: CockpitItem[]): RepoGroup[] {
  const bySlug = new Map<string, RepoGroup>();
  for (const it of items) {
    let g = bySlug.get(it.slug);
    if (!g) {
      g = { slug: it.slug, repo: it.repo, items: [], counts: { ready: 0, failing: 0, inflight: 0, issues: 0 } };
      bySlug.set(it.slug, g);
    }
    g.items.push(it);
    g.counts[it.group]++;
  }
  // items arrive urgency-sorted from flattenCockpit; a stable filter preserves
  // that order inside each group.
  return [...bySlug.values()].sort((a, b) => a.repo.localeCompare(b.repo));
}

export type CockpitFilter = { q: string; repo: string; kind: "all" | "prs" | "issues" };

export function filterItems(items: CockpitItem[], f: CockpitFilter): CockpitItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((it) => {
    if (f.repo && it.slug !== f.repo) return false;
    if (f.kind === "prs" && it.kind !== "pr") return false;
    if (f.kind === "issues" && it.kind !== "issue") return false;
    if (!q) return true;
    const t = it.kind === "pr" ? it.pr : it.issue;
    return `${it.repo} ${it.slug} #${t.number} ${t.title} ${t.author}`.toLowerCase().includes(q);
  });
}

export function formatAge(iso: string | undefined, now: number = Date.now()): string {
  const t = Date.parse(iso ?? "");
  if (!iso || Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// CI detail view: failures first (they're why you opened it), then running,
// then passing; alphabetical within a group so re-renders don't shuffle rows.
const RUN_RANK: Record<CheckRun["status"], number> = { failed: 0, pending: 1, passed: 2 };
export function sortCheckRuns(runs: CheckRun[]): CheckRun[] {
  return [...runs].sort((a, b) => RUN_RANK[a.status] - RUN_RANK[b.status] || a.name.localeCompare(b.name));
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ageDays(iso: string | undefined, now: number = Date.now()): number {
  const t = Date.parse(iso ?? "");
  if (!iso || Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}
