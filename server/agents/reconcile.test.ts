// server/agents/reconcile.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorktree } from "./worktree.js";
import { merge, discard, diffPatch } from "./reconcile.js";
import { pushBranch, commitPending } from "./reconcile.js";
import type { AgentRecord } from "./store.js";

const run = promisify(execFile);
let repo: string, root: string;

async function commit(dir: string, file: string, body: string, msg: string) {
  await writeFile(join(dir, file), body);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-q", "-m", msg]);
}
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "repo-")); root = await mkdtemp(join(tmpdir(), "wt-"));
  await run("git", ["-C", repo, "init", "-q", "-b", "main"]);
  await run("git", ["-C", repo, "config", "user.email", "t@t"]);
  await run("git", ["-C", repo, "config", "user.name", "t"]);
  await commit(repo, "a.txt", "base\n", "init");
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });

function rec(branch: string, worktree: string): AgentRecord {
  return { id: "a", label: "L", repo, worktree, branch, baseBranch: "main",
    sessionId: null, hookToken: "t", status: "done", createdAt: 1 };
}

describe("reconcile", () => {
  it("merges a clean agent branch into base", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/clean", root });
    await commit(wt.path, "b.txt", "agent work\n", "agent change");
    const r = await merge(rec("agent/clean", wt.path), "main");
    expect(r.ok).toBe(true);
    const { stdout } = await run("git", ["-C", repo, "log", "--oneline"]);
    expect(stdout).toContain("agent change");
  });
  it("reports a conflict without leaving the base mid-merge", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/conf", root });
    await commit(wt.path, "a.txt", "agent version\n", "agent edits a");
    await commit(repo, "a.txt", "base version\n", "base edits a"); // diverge base
    const r = await merge(rec("agent/conf", wt.path), "main");
    expect(r.ok).toBe(false);
    // base is clean (merge aborted), not mid-conflict
    const { stdout } = await run("git", ["-C", repo, "status", "--porcelain"]);
    expect(stdout.trim()).toBe("");
  });
  it("diffPatch returns a unified patch with committed AND uncommitted edits", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/diff", root });
    await commit(wt.path, "b.txt", "agent work\n", "agent change"); // committed
    await writeFile(join(wt.path, "a.txt"), "base\nuncommitted edit\n"); // dirty, tracked
    const patch = await diffPatch(rec("agent/diff", wt.path));
    // committed new file shows in the patch with an added line
    expect(patch).toContain("b.txt");
    expect(patch).toContain("+agent work");
    // uncommitted edit to a tracked file is included too
    expect(patch).toContain("a.txt");
    expect(patch).toContain("+uncommitted edit");
    expect(patch).toMatch(/^diff --git/m);
  });
  it("merge commits pending edits (excluding .choibot-hooks.json) into base", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/pending", root });
    await commit(wt.path, "b.txt", "agent work\n", "agent change");
    // uncommitted edit to a tracked file + an untracked hook settings file
    await writeFile(join(wt.path, "a.txt"), "base\nuser comment\n");
    await writeFile(join(wt.path, ".choibot-hooks.json"), "{}\n");
    const r = await merge(rec("agent/pending", wt.path), "main");
    expect(r.ok).toBe(true);
    // the user's uncommitted edit landed in base
    const { stdout: aBody } = await run("git", ["-C", repo, "show", "main:a.txt"]);
    expect(aBody).toContain("user comment");
    // .choibot-hooks.json was NOT merged into base
    await expect(run("git", ["-C", repo, "cat-file", "-e", "main:.choibot-hooks.json"])).rejects.toThrow();
  });
  it("discard removes the worktree and branch", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/gone", root });
    await discard(rec("agent/gone", wt.path));
    const { stdout } = await run("git", ["-C", repo, "branch", "--list", "agent/gone"]);
    expect(stdout.trim()).toBe("");
  });
});

describe("pushBranch", () => {
  it("pushes the branch to a bare origin", async () => {
    const bare = await mkdtemp(join(tmpdir(), "origin-"));
    await run("git", ["-C", bare, "init", "-q", "--bare"]);
    await run("git", ["-C", repo, "remote", "add", "origin", bare]);
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/push", root });
    await commit(wt.path, "b.txt", "agent work\n", "agent change");
    await pushBranch(rec("agent/push", wt.path), "agent/push");
    const { stdout } = await run("git", ["-C", bare, "branch", "--list", "agent/push"]);
    expect(stdout).toContain("agent/push");
    await rm(bare, { recursive: true, force: true });
  });

  it("throws GhError(no_github_remote) when origin is missing", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/noremote", root });
    await commit(wt.path, "b.txt", "x\n", "c");
    await expect(pushBranch(rec("agent/noremote", wt.path), "agent/noremote"))
      .rejects.toMatchObject({ kind: "no_github_remote" });
  });

  it("commitPending commits dirty worktree edits", async () => {
    const wt = await createWorktree({ repo, baseBranch: "main", branch: "agent/dirty", root });
    await writeFile(join(wt.path, "c.txt"), "uncommitted\n");
    const r = await commitPending(rec("agent/dirty", wt.path));
    expect(r.ok).toBe(true);
    const { stdout } = await run("git", ["-C", wt.path, "status", "--porcelain"]);
    expect(stdout.trim()).toBe("");
  });
});

describe("commitPending unstages hooks files (worktree without exclude)", () => {
  async function plainWorktree(branch: string): Promise<string> {
    const path = join(root, "plain-" + branch.replace("/", "-"));
    await run("git", ["-C", repo, "worktree", "add", "-b", branch, path, "main"]);
    return path;
  }
  async function inHead(wt: string, p: string): Promise<boolean> {
    try { await run("git", ["-C", wt, "cat-file", "-e", `HEAD:${p}`]); return true; } catch { return false; }
  }
  it("commits the normal edit but neither .choibot-hooks.json nor .choibot/", async () => {
    const wt = await plainWorktree("agent/plain");
    await writeFile(join(wt, "a.txt"), "base\nedit\n");
    await writeFile(join(wt, ".choibot-hooks.json"), "{}\n");
    await mkdir(join(wt, ".choibot"), { recursive: true });
    await writeFile(join(wt, ".choibot/x"), "x");
    expect((await commitPending(rec("agent/plain", wt))).ok).toBe(true);
    expect((await run("git", ["-C", wt, "show", "HEAD:a.txt"])).stdout).toContain("edit");
    expect(await inHead(wt, ".choibot-hooks.json")).toBe(false);
    expect(await inHead(wt, ".choibot/x")).toBe(false);
  });
  it("keeps a force-staged hooks file out of the commit", async () => {
    const wt = await plainWorktree("agent/forced");
    await writeFile(join(wt, "a.txt"), "base\nedit\n");
    await writeFile(join(wt, ".choibot-hooks.json"), "{}\n");
    await run("git", ["-C", wt, "add", "-f", ".choibot-hooks.json"]);
    expect((await commitPending(rec("agent/forced", wt))).ok).toBe(true);
    expect((await run("git", ["-C", wt, "show", "HEAD:a.txt"])).stdout).toContain("edit");
    expect(await inHead(wt, ".choibot-hooks.json")).toBe(false);
  });
});
