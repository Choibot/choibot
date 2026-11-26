// server/gh/appused.ts — the GitHub repos that the agents of this console used in the last days
// (PR 3 of the GitHub app plan). Settings shows them with the ChoiBot app switch on, so that the
// person chooses the same repos for the app on GitHub before the console works through it.
//
// From what the console itself records:
//   - each agent record that lives now (running, idle), or that started, closed or moved in the
//     window: its repo;
//   - each Recurring task that is on: its folder;
//   - each ticket of the Queue made in the window: its pull request's repo, else its repo.
// Only repos with a GitHub address count. A gh call that an agent with basic protection makes by
// hand to another repo is not in this list: the console does not see it.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cronPaths, readJsonSafe, resolveCronDataDir, type CronJobSpec } from "../../bin/lib/cronspec.js";
import type { AgentRecord } from "../agents/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import type { Repo } from "./repos.js";
import { prSlug } from "./status.js";

export const USED_DAYS = 14;
const DAY_MS = 86_400_000;

export type UsedSource = "agents" | "recurring" | "tickets";
export type UsedRepo = { slug: string; name: string | null; lastAt: number; from: UsedSource[] };

export type UsedInput = {
  agents: Pick<AgentRecord, "repo" | "status" | "createdAt" | "closedAt" | "movedAt">[];
  // The Recurring tasks: the folder each one runs in, and whether it is on.
  recurring: { workdir?: string; enabled: boolean }[];
  tickets: Pick<QueueItem, "repo" | "createdAt" | "pr">[];
  // The repos of the work folder that have a GitHub address.
  workspace: Repo[];
  now: number;
  days?: number;
};

const SOURCES: UsedSource[] = ["agents", "recurring", "tickets"];

export function usedRepos(d: UsedInput): UsedRepo[] {
  const from = d.now - (d.days ?? USED_DAYS) * DAY_MS;
  const byPath = new Map(d.workspace.map((r) => [resolve(r.path), r]));
  const byName = new Map(d.workspace.map((r) => [r.name, r]));
  const bySlug = new Map(d.workspace.map((r) => [r.slug.toLowerCase(), r]));
  const out = new Map<string, UsedRepo>();
  const add = (slug: string, at: number, src: UsedSource) => {
    const key = slug.toLowerCase();
    const known = bySlug.get(key);
    const cur = out.get(key) ?? { slug: known?.slug ?? slug, name: known?.name ?? null, lastAt: at, from: [] };
    cur.lastAt = Math.max(cur.lastAt, at);
    if (!cur.from.includes(src)) cur.from.push(src);
    out.set(key, cur);
  };

  for (const a of d.agents) {
    if (!a.repo) continue;
    const repo = byPath.get(resolve(a.repo));
    if (!repo) continue;
    const alive = a.status === "running" || a.status === "idle";
    const at = alive ? d.now : Math.max(a.createdAt ?? 0, a.closedAt ?? 0, a.movedAt ?? 0);
    if (at >= from) add(repo.slug, at, "agents");
  }
  for (const j of d.recurring) {
    if (!j.enabled || !j.workdir) continue;
    const repo = byPath.get(resolve(j.workdir));
    if (repo) add(repo.slug, d.now, "recurring");
  }
  for (const t of d.tickets) {
    if (!(t.createdAt >= from)) continue;
    const slug = (t.pr && "url" in t.pr ? prSlug(t.pr.url) : null) ?? byName.get(t.repo)?.slug ?? null;
    if (slug) add(slug, t.createdAt, "tickets");
  }
  return [...out.values()]
    .map((r) => ({ ...r, from: SOURCES.filter((s) => r.from.includes(s)) }))
    .sort((a, b) => b.lastAt - a.lastAt || a.slug.localeCompare(b.slug));
}

// The specs of the Recurring tasks (bin/lib/cronspec.ts), read only. A file that is not one is skipped.
export async function readRecurring(dataDir = resolveCronDataDir()): Promise<{ workdir?: string; enabled: boolean }[]> {
  const { jobsDir } = cronPaths(dataDir);
  let names: string[] = [];
  try { names = (await readdir(jobsDir)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const specs = await Promise.all(names.map((n) => readJsonSafe<CronJobSpec>(join(jobsDir, n))));
  return specs.flatMap((s) => (s && typeof s === "object"
    ? [{ ...(typeof s.workdir === "string" ? { workdir: s.workdir } : {}), enabled: s.enabled === true }] : []));
}
