// server/setup/repopick.test.ts — the repo list of the GitHub login and the copy of one repo.
// The list is a fake `gh api` page. The copy runs a fake `gh` (a script in a temp folder) that
// clones a local repo with the real git: no test here reaches GitHub.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloneFailure, clonePercent, folderNames, PAGE_SIZE, RepoPick, searchRepos, type CloneState, type PickRepo } from "./repopick.js";

const row = (slug: string, o: Partial<Record<string, unknown>> = {}) => ({
  slug, private: false, archived: false, language: "TypeScript", pushedAt: "2026-11-19T10:00:00Z", sizeKb: 1200, push: true, ...o,
});
const LIST = [row("acme/shop"), row("acme/api", { language: "Go", private: true }), row("ada-dev/notes"), row("acme/infra", { push: false }), row("acme/old", { archived: true })];

let dir: string, ws: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).toString();

// A source repo with one commit (or none), at <dir>/src/<owner>/<name>.
function source(slug: string, o: { empty?: boolean } = {}): void {
  const p = join(dir, "src", slug);
  mkdirSync(p, { recursive: true });
  git(p, "init", "-q", "-b", "main");
  if (!o.empty) {
    writeFileSync(join(p, "README.md"), "# hi\n");
    git(p, "add", ".");
    git(p, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
  }
}

// The fake gh: `repo clone <slug> <dest> --no-upstream -- --progress` copies <dir>/src/<slug>
// and sets the GitHub address as origin. The file "mode" makes it fail as git does.
function fakeGh(): string {
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env bash
D="${dir}"
echo "$*" >> "$D/calls.log"
[ "$1 $2" = "auth setup-git" ] && { touch "$D/git-uses-the-login"; exit 0; }
[ "$1 $2" = "repo clone" ] || exit 2
case "$(cat "$D/mode" 2>/dev/null)" in
  auth-once) [ -f "$D/git-uses-the-login" ] || { mkdir -p "$4"; echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128; } ;;
  auth) mkdir -p "$4"; echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128 ;;
  disk) mkdir -p "$4/.git"; echo "fatal: write error: No space left on device" >&2; exit 128 ;;
  slow) echo "Receiving objects:  45% (450/1000)" >&2; while [ ! -f "$D/go" ]; do sleep 0.05; done ;;
esac
git clone -q "$D/src/$3" "$4" || exit 1
git -C "$4" remote set-url origin "https://github.com/$3.git"
`);
  chmodSync(bin, 0o755);
  return bin;
}
const calls = (): string[] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);

function pick(o: { list?: unknown[]; pages?: unknown[][]; now?: () => number; logs?: string[]; onDone?: (name: string) => void } = {}) {
  let reads = 0;
  const p = new RepoPick({
    workspaceDir: ws, bin: fakeGh(), env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    ghPage: async (page) => { reads++; return JSON.stringify(o.pages ? (o.pages[page - 1] ?? []) : page === 1 ? (o.list ?? LIST) : []); },
    now: o.now, log: (s) => o.logs?.push(s), onDone: o.onDone,
  });
  return { p, reads: () => reads };
}
const ended = async (p: RepoPick): Promise<CloneState> => {
  const end = Date.now() + 8000;
  while (p.cloneState().state === "copying") { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
  return p.cloneState();
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "setup-repopick-")); ws = join(dir, "ws"); mkdirSync(ws); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the list of the ChoiBot app (switch on)", () => {
  const repo = (o: { slug: string; push?: boolean }): PickRepo => ({
    slug: o.slug, private: true, push: o.push ?? true, archived: false, language: "TypeScript", pushedAt: "2026-11-20T10:00:00Z", sizeKb: 1200,
  });
  const appList = (repos: PickRepo[]) => ({
    repos, capped: false,
    manage: [{ account: "acme", url: "https://github.com/organizations/acme/settings/installations/12" }],
  });
  function appPick(repos: PickRepo[]) {
    let reads = 0;
    let ghReads = 0;
    const p = new RepoPick({
      workspaceDir: ws, bin: fakeGh(), env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      ghPage: async () => { ghReads++; return JSON.stringify(LIST); },
      app: { repos: async () => { reads++; return appList(repos); }, appUrl: "https://github.com/apps/choibot" },
    });
    return { p, reads: () => reads, ghReads: () => ghReads };
  }

  it("lists only the repos that the app reaches, with the links to change them, and never the gh login's list", async () => {
    const { p, reads, ghReads } = appPick([repo({ slug: "acme/shop" }), repo({ slug: "acme/infra", push: false })]);
    const page = await p.page();
    expect(page.repos.map((r) => r.slug)).toEqual(["acme/shop", "acme/infra"]);
    expect(page.app).toEqual({ manage: [{ account: "acme", url: "https://github.com/organizations/acme/settings/installations/12" }], appUrl: "https://github.com/apps/choibot" });
    expect([reads(), ghReads()]).toEqual([1, 0]);
  });

  it("refuses the copy of a repo that the app does not reach, or may not push", async () => {
    const { p } = appPick([repo({ slug: "acme/infra", push: false })]);
    expect(await p.clone("acme/shop")).toEqual({ state: "refused", why: "unknown" });
    expect(await p.clone("acme/infra")).toEqual({ state: "refused", why: "no-push" });
  });

  it("a page of the gh login's list has no app part", async () => {
    expect((await pick().p.page()).app).toBeUndefined();
  });
});

describe("the list", () => {
  it("puts the repos to pick first, the ones that are off after them", async () => {
    const { p } = pick();
    const page = await p.page();
    expect(page.repos.map((r) => r.slug)).toEqual(["acme/shop", "acme/api", "ada-dev/notes", "acme/infra", "acme/old"]);
    expect(page).toMatchObject({ total: 5, listed: 5, more: false, capped: false });
    expect(page.repos[1]).toEqual({ slug: "acme/api", private: true, push: true, archived: false, language: "Go", pushedAt: "2026-11-19T10:00:00Z", sizeKb: 1200, here: false });
    expect(page.repos[3].push).toBe(false);
  });

  it("searches by a part of the name", async () => {
    const { p } = pick();
    expect((await p.page({ q: "ACME sh" })).repos.map((r) => r.slug)).toEqual(["acme/shop"]);
    expect((await p.page({ q: "nothing-like-this" })).total).toBe(0);
    expect(searchRepos(LIST as PickRepo[], "  ").length).toBe(5);
  });

  it("reads GitHub page by page, and gives the list in pages", async () => {
    const full = Array.from({ length: 100 }, (_, n) => row(`acme/r${n}`));
    const { p, reads } = pick({ pages: [full, [row("acme/last")]] });
    const first = await p.page();
    expect(reads()).toBe(2);
    expect(first.repos).toHaveLength(PAGE_SIZE);
    expect(first).toMatchObject({ total: 101, more: true });
    expect((await p.page({ page: 3 })).repos.map((r) => r.slug)).toEqual([...Array.from({ length: 10 }, (_, n) => `acme/r${90 + n}`), "acme/last"]);
    expect(reads()).toBe(2); // kept: a search or a next page does not ask GitHub again
  });

  it("stops after 500 repos and says so", async () => {
    const full = Array.from({ length: 100 }, (_, n) => row(`acme/r${n}`));
    const { p, reads } = pick({ pages: Array.from({ length: 9 }, () => full) });
    expect((await p.page()).capped).toBe(true);
    expect(reads()).toBe(5);
  });

  it("keeps the list for a minute, and reads again on `fresh` or after a new login", async () => {
    let t = 0;
    const { p, reads } = pick({ now: () => t });
    await p.page(); t = 59_000; await p.page();
    expect(reads()).toBe(1);
    t = 61_000; await p.page();
    expect(reads()).toBe(2);
    await p.page({ fresh: true });
    expect(reads()).toBe(3);
    p.forget(); await p.page();
    expect(reads()).toBe(4);
  });

  it("drops a row that is not a repo name of GitHub", async () => {
    const { p } = pick({ list: [row("acme/shop"), row("../../etc"), row("-x/y"), row("acme/a b"), { slug: 5 }, null] });
    expect((await p.page()).repos.map((r) => r.slug)).toEqual(["acme/shop"]);
  });

  it("marks a repo that is in the work folder", async () => {
    source("acme/shop");
    git(dir, "clone", "-q", join(dir, "src/acme/shop"), join(ws, "shop"));
    git(join(ws, "shop"), "remote", "set-url", "origin", "git@github.com:acme/shop.git");
    const { p } = pick();
    expect((await p.page()).repos.filter((r) => r.here).map((r) => r.slug)).toEqual(["acme/shop"]);
  });
});

describe("the copy", () => {
  it("copies a repo of the list into the work folder, under its name", async () => {
    source("acme/shop");
    const done: string[] = [];
    const logs: string[] = [];
    const { p } = pick({ logs, onDone: (name) => { done.push(name); } });
    expect(await p.clone("acme/shop")).toEqual({ state: "copying", repo: "acme/shop", percent: null, big: false });
    expect(await ended(p)).toEqual({ state: "done", repo: "acme/shop" });
    expect(calls()).toEqual([`repo clone acme/shop ${join(ws, "shop")} --no-upstream -- --progress`]);
    expect(readFileSync(join(ws, "shop", "README.md"), "utf8")).toBe("# hi\n");
    // The folder name of the pick goes on: the first task uses this repo.
    expect(done).toEqual(["shop"]);
    expect(logs.join("\n")).toMatch(/acme\/shop is in the work folder/);
  });

  it("refuses a repo that the list does not hold, and a path", async () => {
    source("acme/shop");
    const { p } = pick();
    for (const bad of ["acme/secret", "../../etc/passwd", "/abs/path", "acme/shop/../x", "-o/x", "https://github.com/acme/shop", ""]) {
      expect(await p.clone(bad), bad).toEqual({ state: "refused", why: "unknown" });
    }
    expect(calls()).toEqual([]);
    expect(readdirSync(ws)).toEqual([]);
  });

  it("refuses a repo with no push access, and an archived one", async () => {
    const { p } = pick();
    expect(await p.clone("acme/infra")).toEqual({ state: "refused", why: "no-push" });
    expect(await p.clone("acme/old")).toEqual({ state: "refused", why: "no-push" });
    expect(calls()).toEqual([]);
  });

  it("takes a repo that is in the work folder already, with no copy", async () => {
    source("acme/shop");
    git(dir, "clone", "-q", join(dir, "src/acme/shop"), join(ws, "my-shop"));
    git(join(ws, "my-shop"), "remote", "set-url", "origin", "https://github.com/Acme/Shop.git");
    const done: string[] = [];
    const { p } = pick({ onDone: (name) => { done.push(name); } });
    expect(await p.clone("acme/shop")).toEqual({ state: "done", repo: "acme/shop" });
    expect(calls()).toEqual([]);
    expect(done).toEqual(["my-shop"]);
  });

  it("uses owner-name when a folder with the name is there, and never writes into that folder", async () => {
    source("acme/shop");
    mkdirSync(join(ws, "shop"));
    writeFileSync(join(ws, "shop", "mine.txt"), "keep");
    const done: string[] = [];
    const { p } = pick({ onDone: (name) => { done.push(name); } });
    await p.clone("acme/shop");
    expect(await ended(p)).toEqual({ state: "done", repo: "acme/shop" });
    expect(done).toEqual(["acme-shop"]);
    expect(readdirSync(ws).sort()).toEqual(["acme-shop", "shop"]);
    expect(readdirSync(join(ws, "shop"))).toEqual(["mine.txt"]);
  });

  it("fails with `exists` when both folder names are taken", async () => {
    mkdirSync(join(ws, "shop")); mkdirSync(join(ws, "acme-shop"));
    const { p } = pick();
    expect(await p.clone("acme/shop")).toEqual({ state: "failed", repo: "acme/shop", reason: "exists" });
    expect(calls()).toEqual([]);
  });

  it("says why a copy failed, and leaves no part of it", async () => {
    for (const [mode, reason] of [["auth", "auth"], ["disk", "disk"]] as const) {
      writeFileSync(join(dir, "mode"), mode);
      const { p } = pick();
      await p.clone("acme/shop");
      expect(await ended(p)).toEqual({ state: "failed", repo: "acme/shop", reason });
      expect(readdirSync(ws)).toEqual([]);
    }
  });

  it("a copy that GitHub refuses: the console makes git use the GitHub login and copies one more time, with no command of the user", async () => {
    source("acme/shop");
    writeFileSync(join(dir, "mode"), "auth-once");
    const { p } = pick();
    await p.clone("acme/shop");
    expect(await ended(p)).toEqual({ state: "done", repo: "acme/shop" });
    expect(readdirSync(ws)).toEqual(["shop"]);
    expect(calls().filter((c) => c.startsWith("repo clone"))).toHaveLength(2);
    expect(calls()).toContain("auth setup-git --hostname github.com");
    // A copy that is refused two times ends as "auth", with one more try and no more.
    writeFileSync(join(dir, "mode"), "auth");
    const second = pick();
    await second.p.clone("acme/api");
    expect(await ended(second.p)).toEqual({ state: "failed", repo: "acme/api", reason: "auth" });
    expect(calls().filter((c) => c.startsWith("repo clone acme/api"))).toHaveLength(2);
  });

  it("refuses a repo with no commit, and removes its folder", async () => {
    source("ada-dev/notes", { empty: true });
    const { p } = pick();
    await p.clone("ada-dev/notes");
    expect(await ended(p)).toEqual({ state: "failed", repo: "ada-dev/notes", reason: "empty" });
    expect(readdirSync(ws)).toEqual([]);
  });

  it("shows how far the copy is, and runs one copy at a time", async () => {
    source("acme/shop");
    writeFileSync(join(dir, "mode"), "slow");
    const { p } = pick({ list: [row("acme/shop", { sizeKb: 900_000 }), row("acme/api")] });
    expect(await p.clone("acme/shop")).toMatchObject({ state: "copying", big: true });
    const end = Date.now() + 4000;
    while ((p.cloneState() as { percent?: number | null }).percent == null && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(p.cloneState()).toEqual({ state: "copying", repo: "acme/shop", percent: 41, big: true });
    expect(await p.clone("acme/api")).toEqual({ state: "refused", why: "busy" });
    writeFileSync(join(dir, "go"), "");
    expect((await ended(p)).state).toBe("done");
  });

  it("puts no line of a tool in a state or a log", async () => {
    writeFileSync(join(dir, "mode"), "auth");
    const logs: string[] = [];
    const { p } = pick({ logs });
    await p.clone("acme/shop");
    const out = JSON.stringify(await ended(p)) + logs.join("\n");
    expect(out).not.toMatch(/Username|fatal|terminal prompts/);
    expect(out).not.toContain(dir);
  });
});

describe("the small parts", () => {
  it("folderNames: the name, then owner-name", () => {
    expect(folderNames("acme/shop")).toEqual(["shop", "acme-shop"]);
    expect(folderNames("acme/.github")).toEqual(["acme-github"]);
    expect(folderNames("acme/x.git")).toEqual(["acme-x.git"]);
  });
  it("clonePercent reads the last progress line", () => {
    expect(clonePercent("Cloning into 'x'...\n")).toBeNull();
    expect(clonePercent("Receiving objects:  10% (1/10)\rReceiving objects:  50% (5/10)\r")).toBe(45);
    expect(clonePercent("Receiving objects: 100% (10/10), done.\nResolving deltas:  50% (1/2)\r")).toBe(95);
    expect(clonePercent("Receiving objects: 100% (10/10), done.\nResolving deltas: 100% (2/2), done.\n")).toBe(100);
  });
  it("cloneFailure names the cause", () => {
    expect(cloneFailure("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBe("network");
    expect(cloneFailure("remote: Repository not found.")).toBe("auth");
    expect(cloneFailure("error: unable to write file x: No space left on device")).toBe("disk");
    expect(cloneFailure("boom")).toBe("failed");
  });
});
