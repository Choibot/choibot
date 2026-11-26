// server/agents/worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createWorktree, removeWorktree, worktreeChangedFiles, parseNumstat, worktreeGitState, discardFileInWorktree, validBranchName, plainRefName, hardenedRefRefusal, worktreeHeadBranch, worktreeHeadLabel } from "./worktree.js";

const run = promisify(execFile);
let repo: string, root: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "repo-"));
  root = await mkdtemp(join(tmpdir(), "wt-"));
  await run("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await run("git", ["-C", repo, "config", "user.email", "t@t"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await writeFile(join(repo, "f.txt"), "hello");
  await run("git", ["-C", repo, "add", "-A"]);
  await run("git", ["-C", repo, "commit", "-q", "-m", "init"]);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("forking from the latest remote state", () => {
  // A clone whose origin then moves forward — the local base goes stale.
  async function cloneWithStaleBase(): Promise<{ clone: string; remoteTip: string; cleanup: () => Promise<void> }> {
    const clone = await mkdtemp(join(tmpdir(), "clone-"));
    await rm(clone, { recursive: true, force: true });
    await run("git", ["clone", "-q", repo, clone]);
    await run("git", ["-C", clone, "config", "user.email", "t@t"]);
    await run("git", ["-C", clone, "config", "user.name", "t"]);
    // origin moves on after the clone
    await writeFile(join(repo, "newer.txt"), "merged upstream");
    await run("git", ["-C", repo, "add", "-A"]);
    await run("git", ["-C", repo, "commit", "-q", "-m", "merged PR on origin"]);
    const { stdout } = await run("git", ["-C", repo, "rev-parse", "main"]);
    await run("git", ["-C", clone, "fetch", "-q", "origin"]); // the api flow fetches before createWorktree
    return { clone, remoteTip: stdout.trim(), cleanup: () => rm(clone, { recursive: true, force: true }) };
  }

  it("a new agent branch forks from origin when the local base fell behind", async () => {
    const { clone, remoteTip, cleanup } = await cloneWithStaleBase();
    const wt = await createWorktree({ repo: clone, baseBranch: "main", branch: "agent/stale1", root });
    const { stdout } = await run("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(remoteTip);
    await cleanup();
  });

  it("a new agent branch forks from origin when the local base has DIVERGED (remote has merged PRs the local copy lacks)", async () => {
    const { clone, remoteTip, cleanup } = await cloneWithStaleBase();
    // local-only commit → local main and origin/main have diverged
    await writeFile(join(clone, "local.txt"), "local only");
    await run("git", ["-C", clone, "add", "-A"]);
    await run("git", ["-C", clone, "commit", "-q", "-m", "stale local-only commit"]);
    const wt = await createWorktree({ repo: clone, baseBranch: "main", branch: "agent/diverged1", root });
    const { stdout } = await run("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(remoteTip);
    await cleanup();
  });

  it("keeps the local base as start point when it is strictly ahead of origin", async () => {
    const clone = await mkdtemp(join(tmpdir(), "clone-"));
    await rm(clone, { recursive: true, force: true });
    await run("git", ["clone", "-q", repo, clone]);
    await run("git", ["-C", clone, "config", "user.email", "t@t"]);
    await run("git", ["-C", clone, "config", "user.name", "t"]);
    await writeFile(join(clone, "ahead.txt"), "unpushed work");
    await run("git", ["-C", clone, "add", "-A"]);
    await run("git", ["-C", clone, "commit", "-q", "-m", "local ahead"]);
    const { stdout: localTip } = await run("git", ["-C", clone, "rev-parse", "main"]);
    const wt = await createWorktree({ repo: clone, baseBranch: "main", branch: "agent/ahead1", root });
    const { stdout } = await run("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    expect(stdout.trim()).toBe(localTip.trim());
    await rm(clone, { recursive: true, force: true });
  });

  it("no remote at all: forks from the local base as before", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/noremote1", root });
    expect(await worktreeHeadBranch(wt.path)).toBe("agent/noremote1");
    await removeWorktree(repo, wt.path);
  });
});

describe("branch naming", () => {
  it("validBranchName accepts real names and rejects junk", () => {
    expect(validBranchName("feat/add-login")).toBe("feat/add-login");
    expect(validBranchName("  fix/bug-1  ")).toBe("fix/bug-1");
    expect(validBranchName("")).toBeNull();
    expect(validBranchName("-bad")).toBeNull();
    expect(validBranchName("bad/")).toBeNull();
    expect(validBranchName("a..b")).toBeNull();
    expect(validBranchName("has space")).toBeNull();
    expect(validBranchName("has~tilde")).toBeNull();
    expect(validBranchName("ref@{0}")).toBeNull();
  });

  // Final review C1: `branch: Created from <start>` ignores GIT_REFLOG_ACTION.
  const HARD = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:1", CHIEF_AGENT_UID: "1001" };

  it("plainRefName takes only [A-Za-z0-9._/-], never a leading -", () => {
    for (const ok of ["main", "feat/add-login", "origin/release-1.2", "a_b.c", "x"]) expect(plainRefName(ok), ok).toBe(true);
    for (const bad of [
      "", "-x", "--force", "x$(touch${IFS}pwned)", "a;b", "a|b", "a&b", "a`b`", "a b", " main", "{x}",
      "é", "a\nb", "a'b", "a\"b", "a>b", "a<b", "a!b", "a#b", "a%b", "a+b", "a=b", "a,b",
    ]) expect(plainRefName(bad), JSON.stringify(bad)).toBe(false);
  });

  it("hardenedRefRefusal, hardened: the first bad field gets a 400 text; absent or empty fields pass", () => {
    expect(hardenedRefRefusal({ branch: "evil", baseBranch: "x$(id)" }, HARD)).toMatch(/^invalid baseBranch: /);
    expect(hardenedRefRefusal({ createFrom: "-x" }, HARD)).toMatch(/^invalid createFrom: /);
    expect(hardenedRefRefusal({ branch: 5 }, HARD)).toMatch(/^invalid branch: /);
    expect(hardenedRefRefusal({ branch: undefined, baseBranch: "", createFrom: null }, HARD)).toBeNull();
    expect(hardenedRefRefusal({ branch: "feat/x", baseBranch: "origin/main", createFrom: "main" }, HARD)).toBeNull();
  });

  it("hardenedRefRefusal, not hardened (flag off, misconfigured, no CHIEF_AGENT_UID): never refuses", () => {
    expect(hardenedRefRefusal({ baseBranch: "x$(id)", branch: 5 }, {})).toBeNull();
    expect(hardenedRefRefusal({ baseBranch: "x$(id)" }, { ...HARD, CHIEF_AGENT_UID: undefined })).toBeNull();
    expect(hardenedRefRefusal({ baseBranch: "x$(id)" }, { ...HARD, CHIEF_ENABLED: undefined })).toBeNull();
    expect(hardenedRefRefusal({ baseBranch: "x$(id)" }, { ...HARD, CHIEF_CONSOLE_URL: undefined })).toBeNull();
  });

  it("creates a worktree on a user-named branch forked from the base", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "feat/login", root, dirName: "feat-login-abc123" });
    expect(await worktreeHeadBranch(wt.path)).toBe("feat/login");
    expect(wt.path.endsWith("feat-login-abc123")).toBe(true); // dir uses dirName, not the slashy branch
    await removeWorktree(repo, wt.path);
  });

  it("reuses an existing branch instead of forking a new one", async () => {
    // pre-create the branch in the repo with its own commit
    await run("git", ["-C", repo, "branch", "feature/x", "main"]);
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "feature/x", root, dirName: "feature-x-1" });
    expect(await worktreeHeadBranch(wt.path)).toBe("feature/x");
    await removeWorktree(repo, wt.path);
  });

  it("worktreeHeadBranch returns null on a detached HEAD", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/det-1", root });
    const { stdout: sha } = await run("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    await run("git", ["-C", wt.path, "checkout", "-q", "--detach", sha.trim()]);
    expect(await worktreeHeadBranch(wt.path)).toBeNull();
    await removeWorktree(repo, wt.path);
  });

  it("worktreeHeadLabel names the branch, or 'detached @sha' off-branch", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/lbl-1", root });
    expect(await worktreeHeadLabel(wt.path)).toBe("agent/lbl-1");
    const { stdout: sha } = await run("git", ["-C", wt.path, "rev-parse", "HEAD"]);
    await run("git", ["-C", wt.path, "checkout", "-q", "--detach", sha.trim()]);
    expect(await worktreeHeadLabel(wt.path)).toMatch(/^detached @[0-9a-f]+$/);
    await removeWorktree(repo, wt.path);
  });
});

describe("worktree manager", () => {
  it("creates an isolated worktree on a new branch, then removes it", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/x-123", root });
    // worktree has the repo content on the new branch
    const { stdout: br } = await run("git", ["-C", wt.path, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(br.trim()).toBe("agent/x-123");
    // listed as a worktree of the repo
    const { stdout: list } = await run("git", ["-C", repo, "worktree", "list"]);
    expect(list).toContain(wt.path);
    await removeWorktree(repo, wt.path);
    const { stdout: list2 } = await run("git", ["-C", repo, "worktree", "list"]);
    expect(list2).not.toContain(wt.path);
  });

  it("excludes .choibot/ so shared docs never dirty git status", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/choibot-x", root });
    await mkdir(join(wt.path, ".choibot"), { recursive: true });
    await writeFile(join(wt.path, ".choibot", "docs.json"), "[]");
    const { stdout } = await run("git", ["-C", wt.path, "status", "--porcelain"]);
    expect(stdout).not.toContain(".choibot");
  });

  it("lists changed files (committed + uncommitted + untracked), excluding hooks", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/y-1", root });
    await run("git", ["-C", wt.path, "config", "user.email", "t@t"]);
    await run("git", ["-C", wt.path, "config", "user.name", "t"]);
    // committed modification of a tracked file
    await writeFile(join(wt.path, "f.txt"), "hello world");
    await run("git", ["-C", wt.path, "commit", "-qam", "edit"]);
    // committed new file
    await writeFile(join(wt.path, "added.txt"), "new");
    await run("git", ["-C", wt.path, "add", "-A"]);
    await run("git", ["-C", wt.path, "commit", "-qm", "add"]);
    // uncommitted untracked files: one real, one the excluded hooks file
    await writeFile(join(wt.path, "scratch.txt"), "wip");
    await writeFile(join(wt.path, ".choibot-hooks.json"), "{}");

    // uncommitted edit to a tracked file
    await writeFile(join(wt.path, "f.txt"), "hello world!!!");

    const files = await worktreeChangedFiles(wt.path, "main");
    const byRel = Object.fromEntries(files.map((f) => [f.rel, f.status]));
    const stateByRel = Object.fromEntries(files.map((f) => [f.rel, f.state]));
    expect(byRel["f.txt"]).toBe("modified");
    expect(byRel["added.txt"]).toBe("added");
    expect(byRel["scratch.txt"]).toBe("untracked");
    expect(byRel[".choibot-hooks.json"]).toBeUndefined();
    // commit-state: f.txt now has a working-tree edit (uncommitted), added.txt is
    // committed-only, scratch.txt is a brand-new untracked file.
    expect(stateByRel["f.txt"]).toBe("uncommitted");
    expect(stateByRel["added.txt"]).toBe("committed");
    expect(stateByRel["scratch.txt"]).toBe("untracked");
    // absolute path is the worktree-joined rel
    const scratch = files.find((f) => f.rel === "scratch.txt")!;
    expect(scratch.path).toBe(join(wt.path, "scratch.txt"));
    await removeWorktree(repo, wt.path);
  });

  it("gives each changed file its +/- line counts against the fork point", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/y-2", root });
    await run("git", ["-C", wt.path, "config", "user.email", "t@t"]);
    await run("git", ["-C", wt.path, "config", "user.name", "t"]);
    await writeFile(join(wt.path, "added.txt"), "a\nb\nc\n");
    await run("git", ["-C", wt.path, "add", "-A"]);
    await run("git", ["-C", wt.path, "commit", "-qm", "add"]);
    await writeFile(join(wt.path, "f.txt"), "one\ntwo\n"); // "hello" → two lines
    await writeFile(join(wt.path, "scratch.txt"), "x\ny");
    await writeFile(join(wt.path, "blob.bin"), Buffer.from([1, 0, 2]));

    const files = await worktreeChangedFiles(wt.path, "main");
    const by = Object.fromEntries(files.map((f) => [f.rel, [f.add, f.del]]));
    expect(by["added.txt"]).toEqual([3, 0]);
    expect(by["f.txt"]).toEqual([2, 1]);
    expect(by["scratch.txt"]).toEqual([2, 0]);
    expect(by["blob.bin"]).toEqual([undefined, undefined]);
    await removeWorktree(repo, wt.path);
  });

  it("never reads through a symlink an agent made: a symlinked new file gets no line count", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/y-3", root });
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "a\nb\nc\nd\n");
    await symlink(outside, join(wt.path, "link.txt"));
    await writeFile(join(wt.path, "plain.txt"), "x\ny\n");

    const files = await worktreeChangedFiles(wt.path, "main");
    const by = Object.fromEntries(files.map((f) => [f.rel, [f.add, f.del]]));
    expect(by["link.txt"]).toEqual([undefined, undefined]);
    expect(by["plain.txt"]).toEqual([2, 0]);
    await removeWorktree(repo, wt.path);
  });

  it("parses -z numstat records, renames and binaries", () => {
    const out = "3\t1\tsrc/a.ts\0" + "2\t0\t\0old/b.ts\0new/b.ts\0" + "-\t-\timg.png\0";
    const m = parseNumstat(out);
    expect(m.get("src/a.ts")).toEqual({ add: 3, del: 1 });
    expect(m.get("new/b.ts")).toEqual({ add: 2, del: 0 });
    expect(m.has("old/b.ts")).toBe(false);
    expect(m.has("img.png")).toBe(false);
  });

  it("discards a single file: restores tracked edits, removes new files", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/z-1", root });
    await run("git", ["-C", wt.path, "config", "user.email", "t@t"]);
    await run("git", ["-C", wt.path, "config", "user.name", "t"]);
    // committed change to a base file + a committed new file + an untracked file
    await writeFile(join(wt.path, "f.txt"), "changed");
    await writeFile(join(wt.path, "added.txt"), "new");
    await run("git", ["-C", wt.path, "add", "-A"]);
    await run("git", ["-C", wt.path, "commit", "-qm", "work"]);
    await writeFile(join(wt.path, "scratch.txt"), "wip");

    // base file → reverted to fork-point content, drops out of the change set
    await discardFileInWorktree(wt.path, "main", "f.txt");
    expect(await readFile(join(wt.path, "f.txt"), "utf8")).toBe("hello");
    // committed-new file → removed
    await discardFileInWorktree(wt.path, "main", "added.txt");
    expect(existsSync(join(wt.path, "added.txt"))).toBe(false);
    // untracked file → removed
    await discardFileInWorktree(wt.path, "main", "scratch.txt");
    expect(existsSync(join(wt.path, "scratch.txt"))).toBe(false);

    const left = await worktreeChangedFiles(wt.path, "main");
    expect(left.map((f) => f.rel)).toEqual([]);
    await removeWorktree(repo, wt.path);
  });

  it("rejects path traversal and the internal hook file", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/z-2", root });
    await expect(discardFileInWorktree(wt.path, "main", "../escape")).rejects.toThrow();
    await expect(discardFileInWorktree(wt.path, "main", ".choibot-hooks.json")).rejects.toThrow();
    await removeWorktree(repo, wt.path);
  });

  it("returns [] on git error (non-repo path)", async () => {
    expect(await worktreeChangedFiles(root, "main")).toEqual([]);
  });
});

describe("worktreeGitState", () => {
  async function wtConfig(p: string) {
    await run("git", ["-C", p, "config", "user.email", "t@t"]);
    await run("git", ["-C", p, "config", "user.name", "t"]);
  }

  it("reports the live HEAD, ahead/behind base, and dirty/untracked counts (hooks excluded)", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/a-1", root });
    await wtConfig(wt.path);
    // one commit ahead of base
    await writeFile(join(wt.path, "foo.txt"), "one");
    await run("git", ["-C", wt.path, "add", "-A"]);
    await run("git", ["-C", wt.path, "commit", "-qm", "ahead"]);
    // unstaged edit to a tracked file
    await writeFile(join(wt.path, "f.txt"), "changed");
    // a staged new file
    await writeFile(join(wt.path, "staged.txt"), "s");
    await run("git", ["-C", wt.path, "add", "staged.txt"]);
    // untracked files: one real, one the excluded hooks file
    await writeFile(join(wt.path, "untracked.txt"), "u");
    await writeFile(join(wt.path, ".choibot-hooks.json"), "{}");

    const st = await worktreeGitState(wt.path, "agent/a-1", "main");
    expect(st.error).toBe(false);
    expect(st.head).toBe("agent/a-1");
    expect(st.detached).toBe(false);
    expect(st.onTracked).toBe(true);
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(0);
    expect(st.staged).toBe(1);
    expect(st.unstaged).toBe(1);
    expect(st.untracked).toBe(1); // hooks file excluded
    await removeWorktree(repo, wt.path);
  });

  it("flags drift when the worktree HEAD is a different branch than the agent's tracked branch", async () => {
    // a pre-existing branch the agent did not create
    await run("git", ["-C", repo, "branch", "feature", "main"]);
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/b-1", root });
    await wtConfig(wt.path);
    // the agent (or a subagent) checks out an unrelated branch inside the worktree
    await run("git", ["-C", wt.path, "checkout", "-q", "feature"]);

    const st = await worktreeGitState(wt.path, "agent/b-1", "main");
    expect(st.head).toBe("feature");
    expect(st.onTracked).toBe(false);
    await removeWorktree(repo, wt.path);
  });

  it("surfaces stashed work", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/c-1", root });
    await wtConfig(wt.path);
    await writeFile(join(wt.path, "f.txt"), "wip pivot");
    await run("git", ["-C", wt.path, "stash"]);

    const st = await worktreeGitState(wt.path, "agent/c-1", "main");
    expect(st.stashes.length).toBe(1);
    expect(st.stashes[0].message).toContain("WIP");
    await removeWorktree(repo, wt.path);
  });

  it("returns an error sentinel on a non-repo path", async () => {
    const st = await worktreeGitState(root, "x", "main");
    expect(st.error).toBe(true);
  });
});
