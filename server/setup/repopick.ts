// server/setup/repopick.ts — Pick a repo: the repos of the GitHub login, read with `gh`, and the
// copy of the picked one into the agents' work folder.
//
// Two rules keep the copy safe. The repo comes from the list this server read from GitHub: a
// name the list does not hold is refused, so no free text reaches `gh repo clone`. The target
// folder is built here from the repo name, always one folder right inside the work folder: the
// browser sends no path.
//
// One copy at a time, kept in this process: a page that closes and comes back sees its
// progress. Nothing here runs by itself.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gitOpts, runGit } from "../agents/git.js";
import { deadline } from "../chief/deadline.js";
import { gh } from "../gh/exec.js";
import type { AppRepos, ManageLink } from "../gh/apprepos.js";
import { githubEnv } from "../gh/handoff.js";
import { ghSetupGit } from "../gh/setupgit.js";
import { listRepos } from "../gh/repos.js";

const LIST_TTL_MS = 60_000;
const LIST_MS = 30_000;
const PER_PAGE = 100;
// The list reads this many pages of GitHub at most (500 repos, the ones pushed to last first).
const MAX_PAGES = 5;
export const PAGE_SIZE = 30;
const CLONE_MS = 30 * 60_000;
// From this size on, the page says that the copy takes time.
const BIG_KB = 500_000;
const KEEP_BYTES = 8_192;

// owner/name, as GitHub writes it. Neither part can start with "-".
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
// The fields of a repo the list keeps (one `gh api` page, cut down with --jq).
const JQ = "[.[] | {slug: .full_name, private: .private, archived: .archived, language: .language, pushedAt: .pushed_at, sizeKb: .size, push: (.permissions.push == true)}]";

export type PickRepo = {
  slug: string;
  private: boolean;
  // GitHub lets this login push. False: the row is off, with the reason.
  push: boolean;
  archived: boolean;
  language: string | null;
  pushedAt: string | null;
  sizeKb: number;
};

export type RepoPage = {
  repos: (PickRepo & { here: boolean })[];
  // The ChoiBot GitHub app (switch on): the list holds only the repos that the app reaches.
  // manage: where the person changes them, for each installation; appUrl: the app's page (to
  // install it on more accounts). Absent: the list of the gh login, as before.
  app?: { manage: ManageLink[]; appUrl: string | null };
  // How many repos match the search, and how many GitHub listed in all.
  total: number;
  listed: number;
  more: boolean;
  // GitHub has more repos than the list reads.
  capped: boolean;
};

function clean(row: unknown): PickRepo | null {
  const r = row as Partial<Record<keyof PickRepo, unknown>> | null;
  if (!r || typeof r.slug !== "string" || !SLUG_RE.test(r.slug)) return null;
  return {
    slug: r.slug,
    private: r.private === true,
    push: r.push === true,
    archived: r.archived === true,
    language: typeof r.language === "string" ? r.language.slice(0, 40) : null,
    pushedAt: typeof r.pushedAt === "string" && !Number.isNaN(Date.parse(r.pushedAt)) ? r.pushedAt : null,
    sizeKb: typeof r.sizeKb === "number" && r.sizeKb > 0 ? Math.round(r.sizeKb) : 0,
  };
}

// A repo the user can pick: GitHub lets the login push, and the repo is not archived.
export const pickable = (r: PickRepo): boolean => r.push && !r.archived;

// The repos that match the search, the ones to pick first (in the order of GitHub: pushed to
// last, first), then the ones that are off.
export function searchRepos(all: PickRepo[], q: string): PickRepo[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = all.filter((r) => words.every((w) => r.slug.toLowerCase().includes(w)));
  return [...hit.filter(pickable), ...hit.filter((r) => !pickable(r))];
}

// The folder name for a repo: its name, or "owner-name" when the name alone cannot be used.
export function folderNames(slug: string): string[] {
  const [owner, name] = slug.split("/");
  const plain = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.endsWith(".git") ? [name] : [];
  return [...plain, `${owner}-${name.replace(/^\.+/, "")}`];
}

export type CloneReason = "auth" | "disk" | "network" | "empty" | "exists" | "timeout" | "failed";

export type CloneState =
  | { state: "idle" }
  | { state: "copying"; repo: string; percent: number | null; big: boolean }
  | { state: "done"; repo: string }
  | { state: "failed"; repo: string; reason: CloneReason };

// How far `git clone --progress` is, from what it printed last: 0 to 100, or null.
export function clonePercent(text: string): number | null {
  const last = (re: RegExp): number | null => {
    const all = [...text.matchAll(re)];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const got = last(/Receiving objects:\s+(\d+)%/g);
  if (got === null) return null;
  const deltas = last(/Resolving deltas:\s+(\d+)%/g) ?? 0;
  return Math.min(100, Math.round(got * 0.9 + deltas * 0.1));
}

export function cloneFailure(text: string): CloneReason {
  if (/no space left|disk quota/i.test(text)) return "disk";
  if (/could not read username|authentication failed|permission denied|repository not found|could not read from remote|HTTP 40[134]|not logged in|gh auth login/i.test(text)) return "auth";
  if (/could not resolve host|unable to access|timed out|connection re(fused|set)|early eof|rpc failed|network is unreachable|error connecting/i.test(text)) return "network";
  return "failed";
}

export type RepoPickDeps = {
  workspaceDir: string;
  // The program to run. Default: the `gh` on the PATH of the console.
  bin?: string;
  env?: Record<string, string | undefined>;
  // One page of the repos of the login, as JSON text (`gh api user/repos …`).
  ghPage?: (page: number) => Promise<string>;
  // The ChoiBot GitHub app (switch on): the repos that the app reaches (gh/apprepos.ts), in
  // place of the list of the gh login. appUrl: the app's public page.
  app?: { repos: () => Promise<AppRepos>; appUrl: string | null };
  // The repos in the work folder that have a GitHub address.
  onBox?: () => Promise<{ name: string; slug: string; path: string }[]>;
  now?: () => number;
  cloneMs?: number;
  // A pick ended well (a copy, or a repo that was there already). `name`: the folder of the
  // repo in the work folder. The step list is read again, and the first task uses this repo.
  onDone?: (name: string) => void;
  log?: (s: string) => void;
};

export class RepoPick {
  private kept: { at: number; repos: PickRepo[]; capped: boolean; manage?: ManageLink[] } | null = null;
  private reading: Promise<{ repos: PickRepo[]; capped: boolean; manage?: ManageLink[] }> | null = null;
  private st: CloneState = { state: "idle" };
  private busy = false;

  constructor(private d: RepoPickDeps) {}

  // Forget the list (a new GitHub login).
  forget(): void { this.kept = null; }

  cloneState(): CloneState { return this.st; }

  private ghPage(page: number): Promise<string> {
    if (this.d.ghPage) return this.d.ghPage(page);
    const path = `user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`;
    return deadline(gh(["api", path, "--jq", JQ]), LIST_MS, "the repo list");
  }

  private onBox(): Promise<{ name: string; slug: string; path: string }[]> {
    return this.d.onBox ? this.d.onBox() : listRepos(this.d.workspaceDir);
  }

  // Every repo of the login that GitHub lists, kept for a minute.
  private async all(fresh = false): Promise<{ repos: PickRepo[]; capped: boolean; manage?: ManageLink[] }> {
    const now = (this.d.now ?? Date.now)();
    if (!fresh && this.kept && now - this.kept.at < LIST_TTL_MS) return this.kept;
    const app = this.d.app;
    if (app) {
      this.reading ??= app.repos().then((r) => {
        this.kept = { at: (this.d.now ?? Date.now)(), repos: r.repos, capped: r.capped, manage: r.manage };
        return this.kept;
      }).finally(() => { this.reading = null; });
      return this.reading;
    }
    this.reading ??= (async () => {
      const repos: PickRepo[] = [];
      let capped = false;
      for (let page = 1; ; page++) {
        const rows = JSON.parse(await this.ghPage(page)) as unknown;
        if (!Array.isArray(rows)) throw new Error("the repo list is not a list");
        for (const row of rows) { const r = clean(row); if (r) repos.push(r); }
        if (rows.length < PER_PAGE) break;
        if (page === MAX_PAGES) { capped = true; break; }
      }
      this.kept = { at: (this.d.now ?? Date.now)(), repos, capped };
      return this.kept;
    })().finally(() => { this.reading = null; });
    return this.reading;
  }

  async page(o: { q?: string; page?: number; fresh?: boolean } = {}): Promise<RepoPage> {
    const { repos, capped, manage } = await this.all(o.fresh);
    const here = new Set((await this.onBox().catch(() => [])).map((r) => r.slug.toLowerCase()));
    const hit = searchRepos(repos, (o.q ?? "").slice(0, 100));
    const from = Math.max(0, Math.floor(o.page ?? 0)) * PAGE_SIZE;
    return {
      repos: hit.slice(from, from + PAGE_SIZE).map((r) => ({ ...r, here: here.has(r.slug.toLowerCase()) })),
      total: hit.length, listed: repos.length, more: from + PAGE_SIZE < hit.length, capped,
      ...(this.d.app ? { app: { manage: manage ?? [], appUrl: this.d.app.appUrl } } : {}),
    };
  }

  // Starts the copy of a repo of the list. The answer is the state right after the start; the
  // copy goes on in the background. "refused": the repo is not one the user can pick.
  async clone(slug: string): Promise<CloneState | { state: "refused"; why: "unknown" | "no-push" | "busy" }> {
    if (this.busy) return { state: "refused", why: "busy" };
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { state: "refused", why: "unknown" };
    const repo = (await this.all()).repos.find((r) => r.slug === slug);
    if (!repo) return { state: "refused", why: "unknown" };
    if (!pickable(repo)) return { state: "refused", why: "no-push" };
    if (this.busy) return { state: "refused", why: "busy" };

    const root = resolve(this.d.workspaceDir);
    // The repo is in the work folder already: nothing to copy.
    const here = (await this.onBox().catch(() => [])).find((r) => r.slug.toLowerCase() === slug.toLowerCase());
    if (here) return this.finish({ state: "done", repo: slug }, here.name);
    const dest = folderNames(slug).map((n) => join(root, n)).find((p) => !existsSync(p));
    if (!dest || dirname(dest) !== root) return this.finish({ state: "failed", repo: slug, reason: "exists" });

    this.busy = true;
    this.st = { state: "copying", repo: slug, percent: null, big: repo.sizeKb >= BIG_KB };
    this.log(`copy of ${slug} started`);
    void this.run(slug, dest)
      .then(async (end) => {
        // GitHub refused the copy: git may not use the GitHub login yet. The console does what a
        // person did by hand before (it makes git use the login, as after "Connect GitHub"), and
        // copies one more time. No command on the server.
        if (end.state !== "failed" || end.reason !== "auth") return end;
        this.log(`copy of ${slug} refused: git gets the GitHub login, then one more try`);
        await this.setupGit();
        this.st = { state: "copying", repo: slug, percent: null, big: repo.sizeKb >= BIG_KB };
        return this.run(slug, dest);
      })
      .then((end) => { this.busy = false; this.finish(end, basename(dest)); });
    return this.st;
  }

  private finish(end: CloneState, name = ""): CloneState {
    this.st = end;
    if (end.state === "done") { this.log(`${end.repo} is in the work folder`); this.d.onDone?.(name); }
    if (end.state === "failed") this.log(`copy of ${end.repo} failed: ${end.reason}`);
    return end;
  }

  // `gh repo clone` uses the kind of address the GitHub login of the box is set up for (gh
  // manual: `gh repo clone`). --no-upstream: a fork gets no second remote, so the pull requests
  // of the agents go to the picked repo.
  // `gh auth setup-git`: git uses the GitHub login for github.com (the same call as after the
  // code login, setup/ghlogin.ts). A failure changes nothing: the second copy says the result.
  // With the GitHub app switch on and an app token, gh sets up git with that token (gh 2.96 takes
  // GH_TOKEN for `auth setup-git`; with no login and no GH_TOKEN it refuses).
  private async setupGit(): Promise<void> {
    const base = (this.d.env ?? process.env) as NodeJS.ProcessEnv;
    const env = (await githubEnv(base)) ?? base;
    await ghSetupGit({ ...(this.d.bin ? { bin: this.d.bin } : {}), env });
  }

  // With the GitHub app switch on and an app token, the one gh child gets GH_TOKEN (gh/handoff.ts).
  private async run(slug: string, dest: string): Promise<CloneState> {
    const base: NodeJS.ProcessEnv = { ...((this.d.env ?? process.env) as NodeJS.ProcessEnv), NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" };
    const env = (await githubEnv(base)) ?? base;
    return new Promise((done) => {
      const child = spawn(this.d.bin ?? "gh", ["repo", "clone", slug, dest, "--no-upstream", "--", "--progress"], gitOpts(dest, {
        env,
        stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"],
      }));
      let seen = "";
      let late = false;
      const timer = setTimeout(() => { late = true; child.kill("SIGTERM"); }, this.d.cloneMs ?? CLONE_MS);
      timer.unref?.();
      // A start that fails gives "error" and then "close": the first one decides.
      let ended = false;
      const fail = async (reason: CloneReason): Promise<void> => {
        if (ended) return;
        ended = true;
        // The folder did not exist before this copy: what is there now is a part of a copy.
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        done({ state: "failed", repo: slug, reason });
      };
      child.stderr?.on("data", (chunk: Buffer) => {
        seen = (seen + chunk.toString("utf8")).slice(-KEEP_BYTES);
        if (this.st.state === "copying") this.st = { ...this.st, percent: clonePercent(seen) ?? this.st.percent };
      });
      child.on("error", () => { clearTimeout(timer); void fail("failed"); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (late) return void fail("timeout");
        if (code !== 0) return void fail(cloneFailure(seen));
        // A repo with no commit cannot take the work of an agent.
        if (ended) return;
        runGit(dest, ["-C", dest, "rev-parse", "--verify", "-q", "HEAD"], { timeout: 15_000 }, dest)
          .then(() => { ended = true; done({ state: "done", repo: slug }); }, () => fail("empty"));
      });
    });
  }

  // Fixed words and the repo name only: never a line of gh or git.
  private log(what: string): void {
    (this.d.log ?? ((s: string) => console.warn(s)))(`[setup] ${what}`);
  }
}
