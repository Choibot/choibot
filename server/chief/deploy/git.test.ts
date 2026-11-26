// server/chief/deploy/git.test.ts — the deploy check's git reads on a scratch checkout with a
// scratch origin (spec §5.7): real git, no network.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deployGit, mergedPrs, type DeployGit } from "./git.js";

let root: string;
let origin: string;
let work: string;
let live: string;
let env: NodeJS.ProcessEnv;
let git: DeployGit;

const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env }).trim();

// A PR merged with a merge commit, as GitHub makes it. Returns main's new head.
function mergePr(n: number, title: string, file: string): string {
  g(work, "checkout", "-q", "-b", `pr-${n}`);
  writeFileSync(join(work, file), `${title}\n`);
  g(work, "add", "-A"); g(work, "commit", "-q", "-m", title);
  g(work, "checkout", "-q", "main");
  g(work, "merge", "-q", "--no-ff", `pr-${n}`, "-m", `Merge pull request #${n} from o/pr-${n}`, "-m", title);
  g(work, "push", "-q", "origin", "main");
  return g(work, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-deploy-git-"));
  origin = join(root, "origin.git"); work = join(root, "work"); live = join(root, "live");
  env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } as unknown as NodeJS.ProcessEnv;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  execFileSync("git", ["clone", "-q", origin, work], { env, stdio: "ignore" });
  writeFileSync(join(work, "package.json"), "{}\n");
  g(work, "add", "-A"); g(work, "commit", "-q", "-m", "first"); g(work, "branch", "-M", "main"); g(work, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, live], { env, stdio: "ignore" });
  git = deployGit(live, env);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("deployGit", () => {
  it("sees origin/main move without changing the checkout, and counts one commit per merged PR", async () => {
    const base = await git.head();
    expect(await git.remoteHead()).toBe(base);
    expect(await git.branch()).toBe("main");
    const one = mergePr(5, "feat: five", "five.txt");
    const two = mergePr(6, "fix: six", "six.txt");
    expect(await git.remoteHead()).toBe(two);
    expect(await git.trackedHead()).toBe(base); // not fetched yet
    await git.fetch();
    expect(await git.trackedHead()).toBe(two);
    expect(await git.head()).toBe(base); // the checkout did not move
    expect(await git.count(base, two)).toBe(2);
    expect(await git.count(one, two)).toBe(1);
    expect(await git.count(two, two)).toBe(0);
    expect(await git.isAncestor(base, two)).toBe(true);
    expect(await git.isAncestor(two, base)).toBe(false);
    expect(mergedPrs(await git.commits(base, two, 50))).toEqual([{ number: 6, title: "fix: six" }, { number: 5, title: "feat: five" }]);
  });

  it("names the uncommitted files that the new commits also change", async () => {
    const base = await git.head();
    const next = mergePr(7, "chore: package", "package.json");
    await git.fetch();
    expect(await git.blockedFiles(base, next)).toEqual([]);
    writeFileSync(join(live, "package.json"), '{"local":true}\n');
    writeFileSync(join(live, "notes.txt"), "untracked, not in the way\n");
    expect(await git.blockedFiles(base, next)).toEqual(["package.json"]);
  });

  it("refuses anything that is not a full commit id", async () => {
    await expect(git.count("main", "origin/main")).rejects.toThrow("not a full commit id");
    await expect(git.isAncestor("--help", "HEAD")).rejects.toThrow("not a full commit id");
    await expect(git.commits("HEAD~1", "HEAD", 5)).rejects.toThrow("not a full commit id");
  });

  it("a detached checkout has no branch", async () => {
    g(live, "checkout", "-q", "--detach");
    expect(await git.branch()).toBe("");
  });
});
