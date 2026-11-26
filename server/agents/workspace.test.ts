import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workspaceChangedFiles, workspaceDiff, workspaceDiscardFile } from "./workspace.js";

const run = promisify(execFile);
let ws: string;

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await run("git", ["-C", dir, "init", "-q", "-b", "main"]);
  await run("git", ["-C", dir, "config", "user.email", "t@t"]);
  await run("git", ["-C", dir, "config", "user.name", "t"]);
}
async function commit(dir: string, file: string, content: string) {
  await writeFile(join(dir, file), content);
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-q", "-m", `add ${file}`]);
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "wsroot-"));
  // repoA: committed file f.txt, then a working-tree edit + a new untracked file.
  const a = join(ws, "repoA");
  await initRepo(a);
  await commit(a, "f.txt", "original\n");
  await writeFile(join(a, "f.txt"), "changed\n");
  await writeFile(join(a, "new.txt"), "brand new\n");
  // repoB: clean, plus an unrelated edit so we exercise multiple repos.
  const b = join(ws, "repoB");
  await initRepo(b);
  await commit(b, "g.txt", "g original\n");
  await writeFile(join(b, "g.txt"), "g changed\n");
  // console/agent infra inside a repo (not gitignored) — must be excluded so it
  // doesn't flood the change list.
  await mkdir(join(a, ".agent-worktrees", "agent-x"), { recursive: true });
  await writeFile(join(a, ".agent-worktrees", "agent-x", "w.txt"), "worktree junk\n");
  await mkdir(join(a, ".agents", "skills"), { recursive: true });
  await writeFile(join(a, ".agents", "skills", "s.txt"), "skill cache\n");
  // a plain non-git directory — must be ignored entirely.
  await mkdir(join(ws, "plain"), { recursive: true });
  await writeFile(join(ws, "plain", "z.txt"), "ignored\n");
});
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe("workspaceChangedFiles", () => {
  it("lists per-repo changes namespaced by repo name", async () => {
    const files = await workspaceChangedFiles(ws);
    const byRel = Object.fromEntries(files.map((f) => [f.rel, f]));
    expect(byRel["repoA/f.txt"]).toMatchObject({ status: "modified", state: "uncommitted" });
    expect(byRel["repoA/new.txt"]).toMatchObject({ status: "untracked", state: "untracked" });
    expect(byRel["repoB/g.txt"]).toMatchObject({ status: "modified", state: "uncommitted" });
    // absolute path points into the right repo
    expect(byRel["repoA/f.txt"].path).toBe(join(ws, "repoA", "f.txt"));
    // non-git dir contributes nothing
    expect(files.some((f) => f.rel.startsWith("plain/"))).toBe(false);
    // console/agent infra inside a repo is excluded
    expect(files.some((f) => f.rel.includes("/.agent-worktrees/"))).toBe(false);
    expect(files.some((f) => f.rel.includes("/.agents/"))).toBe(false);
  });
});

describe("workspaceDiff", () => {
  it("emits a unified diff whose paths are repo-namespaced", async () => {
    const diff = await workspaceDiff(ws);
    expect(diff).toContain("a/repoA/f.txt");
    expect(diff).toContain("b/repoA/f.txt");
    expect(diff).toContain("a/repoB/g.txt");
    expect(diff).toContain("+changed");
    // untracked file shows up as a new-file diff
    expect(diff).toContain("repoA/new.txt");
  });
});

describe("workspaceDiscardFile", () => {
  it("reverts a tracked edit back to HEAD", async () => {
    await workspaceDiscardFile(ws, "repoA/f.txt");
    expect(await readFile(join(ws, "repoA", "f.txt"), "utf8")).toBe("original\n");
  });
  it("removes a new untracked file", async () => {
    await workspaceDiscardFile(ws, "repoA/new.txt");
    await expect(access(join(ws, "repoA", "new.txt"))).rejects.toThrow();
  });
  it("rejects a path that escapes its repo", async () => {
    await expect(workspaceDiscardFile(ws, "repoA/../repoB/g.txt")).rejects.toThrow();
  });
  it("rejects an unknown repo", async () => {
    await expect(workspaceDiscardFile(ws, "nope/x.txt")).rejects.toThrow(/unknown repo/i);
  });
});
