// server/settings/github.ts — the GitHub part of the Settings page: the login `gh` uses on this
// box, whether it can read each repo the GitHub section lists, and the API rate limit left.
// Read only: no login flow. Every error text is scrubbed of anything shaped like a token.
import type { AppTokenView } from "../gh/appapi.js";
import type { Repo } from "../gh/repos.js";

export type GhRun = (args: string[]) => Promise<string>;

export type RepoAccess = { name: string; slug: string; read: boolean; push: boolean | null; error?: string };
export type GitHubStatus = {
  // null: gh is not logged in or cannot run (then `error` says why).
  login: string | null;
  error?: string;
  rate: { limit: number; remaining: number; reset: number } | null;
  repos: RepoAccess[];
  checkedAt: number;
  // The ChoiBot GitHub app switch is on: the state of its key. Then the login is the app's only
  // (never another login of gh), and the repos come from the app (GET /api/github/app/repos).
  app?: { key: AppTokenView };
};

// GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_) and Authorization lines.
export function scrubGh(text: string): string {
  return text
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "<token>")
    .replace(/(authorization:\s*)(\S+\s+)?\S+/gi, "$1<token>")
    .trim()
    .slice(0, 300);
}

const errText = (e: unknown): string => {
  const err = e as { code?: string; message?: string };
  if (err?.code === "ENOENT" || /spawn gh ENOENT/.test(err?.message ?? "")) return "gh is not installed on your server";
  return scrubGh(err?.message ?? String(e));
};

const notLoggedIn = (t: string): boolean => /not logged in|gh auth login|authentication required|no oauth token|bad credentials|HTTP 401/i.test(t);

// Repos read in parallel, a few at a time (the box may list many).
async function eachLimited<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export const MAX_REPOS = 30;

export async function githubStatus(d: {
  gh: GhRun; repos: () => Promise<Repo[]>; now?: () => number;
  app?: () => Promise<AppTokenView>;
}): Promise<GitHubStatus> {
  const checkedAt = (d.now ?? Date.now)();
  if (d.app) {
    const key = await d.app();
    if (key.state !== "ok") return { login: null, error: "ChoiBot is not connected", rate: null, repos: [], checkedAt, app: { key } };
    // gh gets the app's key (gh/handoff.ts); the per-repo reads are the app's list.
    const s = await githubStatus({ gh: d.gh, repos: async () => [], now: d.now });
    return { ...s, app: { key } };
  }
  let login: string | null = null;
  try {
    const u = JSON.parse(await d.gh(["api", "user"])) as { login?: unknown };
    login = typeof u.login === "string" && u.login ? u.login : null;
    if (!login) return { login: null, error: "gh answered with no login", rate: null, repos: [], checkedAt };
  } catch (e) {
    const t = errText(e);
    return { login: null, error: notLoggedIn(t) ? "gh is not logged in" : t, rate: null, repos: [], checkedAt };
  }
  let rate: GitHubStatus["rate"] = null;
  try {
    const r = JSON.parse(await d.gh(["api", "rate_limit"])) as { resources?: { core?: { limit?: number; remaining?: number; reset?: number } } };
    const c = r.resources?.core;
    if (c && typeof c.limit === "number" && typeof c.remaining === "number") rate = { limit: c.limit, remaining: c.remaining, reset: c.reset ?? 0 };
  } catch { /* the rate line says "unknown" */ }
  const list = (await d.repos().catch(() => [])).slice(0, MAX_REPOS);
  const repos = await eachLimited(list, 4, async (r): Promise<RepoAccess> => {
    try {
      const j = JSON.parse(await d.gh(["api", `repos/${r.slug}`])) as { permissions?: { pull?: boolean; push?: boolean } };
      return { name: r.name, slug: r.slug, read: j.permissions?.pull ?? true, push: j.permissions?.push ?? null };
    } catch (e) {
      const t = errText(e);
      return { name: r.name, slug: r.slug, read: false, push: null, error: /HTTP 404|not found/i.test(t) ? "not found, or no access" : t };
    }
  });
  return { login, rate, repos, checkedAt };
}
