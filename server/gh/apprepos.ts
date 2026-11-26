// server/gh/apprepos.ts — the repos that the ChoiBot GitHub app can reach for the person (PR 2 of
// the GitHub app plan): the picker of the Set-up page lists these, and nothing else of the
// account. GitHub's REST API with the app's user token, from GitHub's docs ("REST API endpoints
// for GitHub App installations", read 2026-11-26):
//   GET /user/installations                              the installations of the app that the
//                                                        person can reach (id, account, html_url,
//                                                        permissions)
//   GET /user/installations/{id}/repositories            the repos of one installation, with the
//                                                        person's own rights under "permissions"
// The token goes in the Authorization header of a request of this process: never in an argv or
// an env, and with no gh in between, so a missing token never falls back to another login.
// A row can be picked only when the person may push AND the installation may write contents.
import type { PickRepo } from "../setup/repopick.js";

export const GITHUB_API = "https://api.github.com";
const PER_PAGE = 100;
// At most this many pages for each installation, and this many installations.
const MAX_PAGES = 5;
const MAX_INSTALLS = 20;
const TIMEOUT_MS = 20_000;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// Where the person changes the repos of one installation (GitHub gives the address).
export type ManageLink = { account: string; url: string };
export type AppRepos = { repos: PickRepo[]; capped: boolean; manage: ManageLink[] };

export type AppReposDeps = {
  token: () => Promise<string | null>;
  api?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class AppReposError extends Error {
  constructor(public why: "not-connected" | "refused" | "no-answer", message: string) { super(message); }
}

async function getJson(d: AppReposDeps, token: string, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${d.api ?? GITHUB_API}${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error",
      signal: AbortSignal.timeout(d.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    throw new AppReposError("no-answer", "GitHub did not answer");
  }
  if (res.status === 401 || res.status === 403) throw new AppReposError("refused", `GitHub refused the key (HTTP ${res.status})`);
  if (!res.ok) throw new AppReposError("no-answer", `GitHub answered HTTP ${res.status}`);
  const v = (await res.json().catch(() => null)) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AppReposError("no-answer", "GitHub gave an answer that is not JSON");
  return v as Record<string, unknown>;
}

// The address to change one installation: GitHub's own settings pages only.
function manageUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.origin === "https://github.com" && /^\/(settings|organizations\/[A-Za-z0-9-]+\/settings)\/installations\/\d+$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}

function row(r: Record<string, unknown>, canWrite: boolean): PickRepo | null {
  if (typeof r.full_name !== "string" || !SLUG_RE.test(r.full_name)) return null;
  const perms = (r.permissions ?? {}) as Record<string, unknown>;
  return {
    slug: r.full_name,
    private: r.private === true,
    push: canWrite && perms.push === true,
    archived: r.archived === true,
    language: typeof r.language === "string" ? r.language.slice(0, 40) : null,
    pushedAt: typeof r.pushed_at === "string" && !Number.isNaN(Date.parse(r.pushed_at)) ? r.pushed_at : null,
    sizeKb: typeof r.size === "number" && r.size > 0 ? Math.round(r.size) : 0,
  };
}

// Every repo of every installation that the person can reach, the ones pushed to last first.
export async function listAppRepos(d: AppReposDeps): Promise<AppRepos> {
  const token = await d.token();
  if (!token) throw new AppReposError("not-connected", "GitHub is not connected");
  const inst = await getJson(d, token, `/user/installations?per_page=${PER_PAGE}`);
  const list = Array.isArray(inst.installations) ? (inst.installations as Record<string, unknown>[]) : [];
  const repos = new Map<string, PickRepo>();
  const manage: ManageLink[] = [];
  let capped = list.length > MAX_INSTALLS;
  for (const i of list.slice(0, MAX_INSTALLS)) {
    if (!Number.isSafeInteger(i.id) || (i.id as number) <= 0) continue;
    const account = (i.account ?? {}) as Record<string, unknown>;
    const login = typeof account.login === "string" && LOGIN_RE.test(account.login) ? account.login : null;
    const url = manageUrl(i.html_url);
    if (login && url) manage.push({ account: login, url });
    // The installation may write contents: a push and a merge need it.
    const canWrite = ((i.permissions ?? {}) as Record<string, unknown>).contents === "write";
    for (let page = 1; ; page++) {
      const p = await getJson(d, token, `/user/installations/${i.id as number}/repositories?per_page=${PER_PAGE}&page=${page}`);
      const rows = Array.isArray(p.repositories) ? (p.repositories as Record<string, unknown>[]) : [];
      for (const r of rows) {
        const x = row(r, canWrite);
        if (x && !repos.has(x.slug.toLowerCase())) repos.set(x.slug.toLowerCase(), x);
      }
      if (rows.length < PER_PAGE) break;
      if (page === MAX_PAGES) { capped = true; break; }
    }
  }
  const sorted = [...repos.values()].sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  return { repos: sorted, capped, manage };
}
