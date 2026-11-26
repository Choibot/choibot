import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listRepos, listBranches, ensureBaseBranch, defaultBranch, normalizeCloneUrl, cloneArgv } from "./repos.js";

const run = promisify(execFile);
let ws: string;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "ws-"));
  // a git repo on branch "main"
  const repoA = join(ws, "repoA");
  await mkdir(repoA, { recursive: true });
  await run("git", ["-C", repoA, "init", "-q", "-b", "main"]);
  await run("git", ["-C", repoA, "config", "user.email", "t@t"]);
  await run("git", ["-C", repoA, "config", "user.name", "t"]);
  await writeFile(join(repoA, "f.txt"), "x");
  await run("git", ["-C", repoA, "add", "-A"]);
  await run("git", ["-C", repoA, "commit", "-q", "-m", "init"]);
  // a plain (non-git) directory — must be excluded
  await mkdir(join(ws, "plainB"), { recursive: true });
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe("listRepos", () => {
  it("lists only git directories with their current branch, excluding non-repos", async () => {
    const repos = await listRepos(ws);
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ name: "repoA", branch: "main" });
    expect(repos[0].path).toBe(join(ws, "repoA"));
    expect(repos.some((r) => r.name === "plainB")).toBe(false);
  });
  it("returns [] for a missing workspace dir", async () => {
    expect(await listRepos(join(ws, "nope"))).toEqual([]);
  });
});

let remote: string, repo: string;

async function commit(dir: string, file: string, msg: string) {
  await writeFile(join(dir, file), msg);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-q", "-m", msg]);
}

describe("listBranches", () => {
  beforeEach(async () => {
    // A bare "remote" with a branch the local clone won't have checked out.
    const origin = await mkdtemp(join(tmpdir(), "origin-"));
    remote = origin;
    await run("git", ["-C", origin, "init", "-q", "-b", "main", "--bare"]);
    const seed = await mkdtemp(join(tmpdir(), "seed-"));
    await run("git", ["-C", seed, "init", "-q", "-b", "main"]);
    await run("git", ["-C", seed, "config", "user.email", "t@t"]);
    await run("git", ["-C", seed, "config", "user.name", "t"]);
    await commit(seed, "f.txt", "init");
    await run("git", ["-C", seed, "remote", "add", "origin", origin]);
    await run("git", ["-C", seed, "push", "-q", "origin", "main"]);
    await run("git", ["-C", seed, "checkout", "-q", "-b", "feature/remote-only"]);
    await commit(seed, "g.txt", "remote work");
    await run("git", ["-C", seed, "push", "-q", "origin", "feature/remote-only"]);
    await rm(seed, { recursive: true, force: true });

    // The repo under test: clone, so feature/remote-only exists only as origin/*.
    repo = await mkdtemp(join(tmpdir(), "repo-"));
    await run("git", ["clone", "-q", origin, repo]);
    await run("git", ["-C", repo, "config", "user.email", "t@t"]);
    await run("git", ["-C", repo, "config", "user.name", "t"]);
  });
  afterEach(async () => {
    await rm(remote, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it("returns local heads and remote-tracking branches separately", async () => {
    const { local, remote: remotes } = await listBranches(repo);
    expect(local).toContain("main");
    expect(local).not.toContain("feature/remote-only");
    expect(remotes).toContain("origin/feature/remote-only");
    // never include the symbolic origin/HEAD pointer
    expect(remotes.some((b) => b.endsWith("/HEAD"))).toBe(false);
  });
});

describe("ensureBaseBranch", () => {
  beforeEach(async () => {
    // A bare "remote" with a branch the local clone won't have checked out.
    const origin = await mkdtemp(join(tmpdir(), "origin-"));
    remote = origin;
    await run("git", ["-C", origin, "init", "-q", "-b", "main", "--bare"]);
    const seed = await mkdtemp(join(tmpdir(), "seed-"));
    await run("git", ["-C", seed, "init", "-q", "-b", "main"]);
    await run("git", ["-C", seed, "config", "user.email", "t@t"]);
    await run("git", ["-C", seed, "config", "user.name", "t"]);
    await commit(seed, "f.txt", "init");
    await run("git", ["-C", seed, "remote", "add", "origin", origin]);
    await run("git", ["-C", seed, "push", "-q", "origin", "main"]);
    await run("git", ["-C", seed, "checkout", "-q", "-b", "feature/remote-only"]);
    await commit(seed, "g.txt", "remote work");
    await run("git", ["-C", seed, "push", "-q", "origin", "feature/remote-only"]);
    await rm(seed, { recursive: true, force: true });

    // The repo under test: clone, so feature/remote-only exists only as origin/*.
    repo = await mkdtemp(join(tmpdir(), "repo-"));
    await run("git", ["clone", "-q", origin, repo]);
    await run("git", ["-C", repo, "config", "user.email", "t@t"]);
    await run("git", ["-C", repo, "config", "user.name", "t"]);
  });
  afterEach(async () => {
    await rm(remote, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it("returns an existing local branch unchanged", async () => {
    expect(await ensureBaseBranch(repo, "main")).toBe("main");
  });

  it("fast-forwards a base branch that has fallen behind its upstream", async () => {
    // Advance origin/main from a second clone so the repo-under-test's local
    // main is now behind its upstream.
    const other = await mkdtemp(join(tmpdir(), "other-"));
    await run("git", ["clone", "-q", remote, other]);
    await run("git", ["-C", other, "config", "user.email", "t@t"]);
    await run("git", ["-C", other, "config", "user.name", "t"]);
    await commit(other, "f.txt", "upstream advance");
    await run("git", ["-C", other, "push", "-q", "origin", "main"]);
    await rm(other, { recursive: true, force: true });

    expect(await ensureBaseBranch(repo, "main")).toBe("main");
    // local main now points at the new upstream commit (ensureBaseBranch fetched
    // and fast-forwarded), so a worktree forked from it starts on latest.
    const { stdout: head } = await run("git", ["-C", repo, "log", "-1", "--format=%s", "main"]);
    expect(head.trim()).toBe("upstream advance");
    const [a, b] = await Promise.all([
      run("git", ["-C", repo, "rev-parse", "main"]),
      run("git", ["-C", repo, "rev-parse", "origin/main"]),
    ]);
    expect(a.stdout.trim()).toBe(b.stdout.trim());
  });

  it("never rewrites a base branch with local-only commits (diverged)", async () => {
    // Local commit on main that isn't on the remote → main has diverged/advanced.
    await commit(repo, "local.txt", "local only");
    const { stdout: before } = await run("git", ["-C", repo, "rev-parse", "main"]);
    expect(await ensureBaseBranch(repo, "main")).toBe("main");
    const { stdout: after } = await run("git", ["-C", repo, "rev-parse", "main"]);
    expect(after.trim()).toBe(before.trim()); // untouched — local work preserved
  });

  it("materializes a local tracking branch from a remote ref", async () => {
    const name = await ensureBaseBranch(repo, "origin/feature/remote-only");
    expect(name).toBe("feature/remote-only");
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "feature/remote-only"]);
    expect(stdout.trim()).toBe("feature/remote-only");
  });

  it("reuses an existing local branch instead of recreating from remote", async () => {
    await run("git", ["-C", repo, "branch", "feature/remote-only", "origin/feature/remote-only"]);
    expect(await ensureBaseBranch(repo, "origin/feature/remote-only")).toBe("feature/remote-only");
  });

  it("creates a new branch from a local start point", async () => {
    const name = await ensureBaseBranch(repo, "feat/new", "main");
    expect(name).toBe("feat/new");
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "feat/new"]);
    expect(stdout.trim()).toBe("feat/new");
  });

  it("creates a new branch from a remote start point", async () => {
    const name = await ensureBaseBranch(repo, "feat/from-remote", "origin/feature/remote-only");
    expect(name).toBe("feat/from-remote");
    const { stdout } = await run("git", ["-C", repo, "log", "-1", "--format=%s", "feat/from-remote"]);
    expect(stdout.trim()).toBe("remote work");
  });

  it("throws on a collision with an existing local branch", async () => {
    await expect(ensureBaseBranch(repo, "main", "main")).rejects.toThrow(/exists/i);
  });

  it("throws on an invalid branch name", async () => {
    await expect(ensureBaseBranch(repo, "bad..name", "main")).rejects.toThrow(/invalid/i);
  });
});

describe("defaultBranch", () => {
  beforeEach(async () => {
    const origin = await mkdtemp(join(tmpdir(), "origin-"));
    remote = origin;
    await run("git", ["-C", origin, "init", "-q", "-b", "main", "--bare"]);
    const seed = await mkdtemp(join(tmpdir(), "seed-"));
    await run("git", ["-C", seed, "init", "-q", "-b", "main"]);
    await run("git", ["-C", seed, "config", "user.email", "t@t"]);
    await run("git", ["-C", seed, "config", "user.name", "t"]);
    await commit(seed, "f.txt", "init");
    await run("git", ["-C", seed, "remote", "add", "origin", origin]);
    await run("git", ["-C", seed, "push", "-q", "origin", "main"]);
    await rm(seed, { recursive: true, force: true });
    repo = await mkdtemp(join(tmpdir(), "repo-"));
    await run("git", ["clone", "-q", origin, repo]);
    await run("git", ["-C", repo, "config", "user.email", "t@t"]);
    await run("git", ["-C", repo, "config", "user.name", "t"]);
  });
  afterEach(async () => {
    await rm(remote, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it("returns the origin/HEAD branch even when the checkout is elsewhere", async () => {
    await run("git", ["-C", repo, "checkout", "-q", "-b", "feature/parked"]);
    expect(await defaultBranch(repo)).toBe("main");
  });

  it("returns origin/<name> when the default branch only exists remotely", async () => {
    // Rename the local main away so only origin/main remains; origin/HEAD
    // (recorded at clone time) still names main as the default.
    await run("git", ["-C", repo, "checkout", "-q", "-b", "other"]);
    await run("git", ["-C", repo, "branch", "-D", "main"]);
    expect(await defaultBranch(repo)).toBe("origin/main");
  });

  it("falls back to a local main/master when origin/HEAD is unset", async () => {
    const plain = await mkdtemp(join(tmpdir(), "plain-"));
    try {
      await run("git", ["-C", plain, "init", "-q", "-b", "master"]);
      await run("git", ["-C", plain, "config", "user.email", "t@t"]);
      await run("git", ["-C", plain, "config", "user.name", "t"]);
      await commit(plain, "f.txt", "init");
      await run("git", ["-C", plain, "checkout", "-q", "-b", "feature/parked"]);
      expect(await defaultBranch(plain)).toBe("master");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("returns null when nothing resembling a default branch exists", async () => {
    const plain = await mkdtemp(join(tmpdir(), "plain-"));
    try {
      await run("git", ["-C", plain, "init", "-q", "-b", "trunk"]);
      await run("git", ["-C", plain, "config", "user.email", "t@t"]);
      await run("git", ["-C", plain, "config", "user.name", "t"]);
      await commit(plain, "f.txt", "init");
      expect(await defaultBranch(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("normalizeCloneUrl", () => {
  it("rewrites a bare GitHub HTTPS URL to SSH", () => {
    expect(normalizeCloneUrl("https://github.com/example-org/sorrel")).toBe("git@github.com:example-org/sorrel.git");
  });
  it("strips a trailing .git and slash before rewriting", () => {
    expect(normalizeCloneUrl("https://github.com/example-org/sorrel.git")).toBe("git@github.com:example-org/sorrel.git");
    expect(normalizeCloneUrl("  https://github.com/example-org/sorrel/  ")).toBe("git@github.com:example-org/sorrel.git");
  });
  it("leaves a URL with embedded credentials untouched", () => {
    const u = "https://user:token@github.com/example-org/sorrel.git";
    expect(normalizeCloneUrl(u)).toBe(u);
  });
  it("leaves SSH, local paths, and non-github hosts untouched", () => {
    expect(normalizeCloneUrl("git@github.com:example-org/sorrel.git")).toBe("git@github.com:example-org/sorrel.git");
    expect(normalizeCloneUrl("/home/dev/workspace/sorrel")).toBe("/home/dev/workspace/sorrel");
    expect(normalizeCloneUrl("https://gitlab.com/foo/bar")).toBe("https://gitlab.com/foo/bar");
  });
  it("does not rewrite deep GitHub paths (not a clone target)", () => {
    const u = "https://github.com/example-org/sorrel/tree/main";
    expect(normalizeCloneUrl(u)).toBe(u);
  });
});

// Fix round 2, item 3: POST /api/repos clone argv.
describe("cloneArgv", () => {
  const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
  it("not hardened: today's argv for any url", () => {
    for (const env of [{}, { ...HARD, CHIEF_AGENT_UID: undefined }]) {
      for (const u of ["git@github.com:o/r.git", "/local/src", "file:///x", "-x"]) expect(cloneArgv(u, "/w/r", env)).toEqual(["clone", u, "/w/r"]);
    }
  });

  it("hardened: -- before a network url (https://, ssh://, user@host:path)", () => {
    for (const u of ["https://github.com/o/r.git", "ssh://git@host.example/o/r.git", "git@github.com:o/r.git", "me@10.0.0.2:repos/r"]) {
      expect(cloneArgv(u, "/w/r", HARD), u).toEqual(["clone", "--", u, "/w/r"]);
    }
  });

  it("hardened: a local path, file://, ext::, another scheme or a leading - is refused (null)", () => {
    for (const u of ["/local/src", "./src", "../src", "src", "file:///x", "ext::sh -c x", "http://h/r.git", "git://h/r.git",
      "-u x", "--upload-pack=x", "ssh://-oProxyCommand=x/r", "git@-oProxy:r", "-me@host:r", "https://", "https://h/r w"]) {
      expect(cloneArgv(u, "/w/r", HARD), u).toBeNull();
    }
  });
});
