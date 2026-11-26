import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureChoiBotExcluded } from "./upload.js";

const run = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "excl-"));
  await run("git", ["init", "-b", "main", dir]);
  await run("git", ["-C", dir, "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

async function status(dir: string): Promise<string> {
  return (await run("git", ["-C", dir, "status", "--porcelain", "-uall"])).stdout.trim();
}

async function touchBoth(dir: string): Promise<void> {
  await writeFile(join(dir, ".choibot-hooks.json"), "{}");
  await mkdir(join(dir, ".choibot"), { recursive: true });
  await writeFile(join(dir, ".choibot/x"), "x");
}

describe("ensureChoiBotExcluded", () => {
  it("ignores .choibot/ and .choibot-hooks.json in a repo", async () => {
    const dir = await makeRepo();
    try {
      await ensureChoiBotExcluded(dir);
      await touchBoth(dir);
      expect(await status(dir)).toBe("");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("ignores both in a linked worktree", async () => {
    const dir = await makeRepo();
    const wt = join(await mkdtemp(join(tmpdir(), "excl-wt-")), "w");
    try {
      await run("git", ["-C", dir, "worktree", "add", "-b", "b1", wt]);
      await ensureChoiBotExcluded(wt);
      await touchBoth(wt);
      expect(await status(wt)).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(join(wt, ".."), { recursive: true, force: true });
    }
  });

  it("adds the missing hooks line to an exclude that already has .choibot/, once", async () => {
    const dir = await makeRepo();
    try {
      await appendFile(join(dir, ".git/info/exclude"), ".choibot/\n");
      await ensureChoiBotExcluded(dir);
      await ensureChoiBotExcluded(dir);
      const lines = (await readFile(join(dir, ".git/info/exclude"), "utf8")).split("\n").map((l) => l.trim());
      expect(lines.filter((l) => l === ".choibot/")).toHaveLength(1);
      expect(lines.filter((l) => l === ".choibot-hooks.json")).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
