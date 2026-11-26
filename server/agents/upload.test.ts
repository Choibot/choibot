import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readdir, rm, readFile, stat, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveUpload, EXT_BY_TYPE } from "./upload.js";

const run = promisify(execFile);

async function makeRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "wt-"));
  await run("git", ["init", "-b", "main", dir]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("saveUpload", () => {
  let repo: { dir: string; cleanup: () => Promise<void> };
  beforeEach(async () => { repo = await makeRepo(); });

  it("writes the image and returns a worktree-relative path", async () => {
    const rel = await saveUpload(repo.dir, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "png");
    expect(rel).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.png$/);
    const written = await readFile(join(repo.dir, rel));
    expect(written).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await repo.cleanup();
  });

  it("adds .choibot/ to the git exclude, idempotently across uploads", async () => {
    await saveUpload(repo.dir, Buffer.from([1]), "png");
    await saveUpload(repo.dir, Buffer.from([2]), "jpg");
    const exclude = await readFile(join(repo.dir, ".git/info/exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l.trim() === ".choibot/")).toHaveLength(1);
    await repo.cleanup();
  });

  it("saves into a plain (non-git) dir instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plain-"));
    const rel = await saveUpload(dir, Buffer.from([7]), "png");
    expect(await readFile(join(dir, rel))).toEqual(Buffer.from([7]));
    await rm(dir, { recursive: true, force: true });
  });

  it("maps content types to extensions", () => {
    expect(EXT_BY_TYPE["image/png"]).toBe("png");
    expect(EXT_BY_TYPE["image/jpeg"]).toBe("jpg");
    expect(EXT_BY_TYPE["image/gif"]).toBe("gif");
    expect(EXT_BY_TYPE["image/webp"]).toBe("webp");
  });
});

// Ruling 2c-7-a: in a hardened deployment the upload into an agent-writable
// worktree makes .choibot/uploads and the file without following a symlink.
describe("saveUpload, hardened", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  const dirs: string[] = [];
  beforeEach(() => { for (const [k, v] of Object.entries(HARDENED)) vi.stubEnv(k, v); });
  afterEach(async () => {
    vi.unstubAllEnvs();
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });
  async function tmp(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }

  it("a planted .choibot symlink is refused; nothing is written through it", async () => {
    const wt = await tmp("wt-");
    const victim = await tmp("console-");
    await symlink(victim, join(wt, ".choibot"));
    await expect(saveUpload(wt, Buffer.from([1]), "png")).rejects.toThrow(/symlink/);
    expect(await readdir(victim)).toEqual([]);
  });

  it("a planted .choibot/uploads symlink is refused too", async () => {
    const wt = await tmp("wt-");
    const victim = await tmp("console-");
    await mkdir(join(wt, ".choibot"));
    await symlink(victim, join(wt, ".choibot", "uploads"));
    await expect(saveUpload(wt, Buffer.from([1]), "png")).rejects.toThrow(/symlink/);
    expect(await readdir(victim)).toEqual([]);
  });

  it("writes a new file and returns the same worktree-relative path", async () => {
    const wt = await tmp("wt-");
    const rel = await saveUpload(wt, Buffer.from([9]), "png");
    expect(rel).toMatch(/^\.choibot\/uploads\/screenshot-\d+-\d+\.png$/);
    expect(await readFile(join(wt, rel))).toEqual(Buffer.from([9]));
  });
});
