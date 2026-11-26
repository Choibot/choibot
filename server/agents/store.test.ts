// server/agents/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, isMasterKind, isPersistentKind, type AgentRecord } from "./store.js";

function rec(id: string): AgentRecord {
  return {
    id, label: "General", repo: "/r", worktree: "/w",
    branch: "agent/abc12345", baseBranch: "main",
    sessionId: null, hookToken: "tok", status: "running", createdAt: 1,
  };
}

describe("SessionStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "store-")); });

  it("saves and loads a record", async () => {
    const s = new SessionStore(dir);
    await s.save(rec("a"));
    expect((await s.load("a"))?.label).toBe("General");
    await rm(dir, { recursive: true, force: true });
  });

  it("lists records sorted by createdAt", async () => {
    const s = new SessionStore(dir);
    await s.save({ ...rec("a"), createdAt: 2 });
    await s.save({ ...rec("b"), createdAt: 1 });
    expect((await s.list()).map((r) => r.id)).toEqual(["b", "a"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("patches fields", async () => {
    const s = new SessionStore(dir);
    await s.save(rec("a"));
    await s.patch("a", { status: "done", sessionId: "sess-9" });
    const r = await s.load("a");
    expect(r?.status).toBe("done");
    expect(r?.sessionId).toBe("sess-9");
    await rm(dir, { recursive: true, force: true });
  });

  it("persists prUrl/prNumber via patch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-"));
    const store = new SessionStore(dir);
    await store.save({
      id: "a", label: "L", repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
      sessionId: null, hookToken: "t", status: "done", createdAt: 1,
    });
    await store.patch("a", { prUrl: "https://github.com/o/r/pull/7", prNumber: 7 });
    const rec = await store.load("a");
    expect(rec?.prNumber).toBe(7);
    expect(rec?.prUrl).toBe("https://github.com/o/r/pull/7");
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a legacy claudeSessionId as sessionId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-legacy-"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "old.json"), JSON.stringify({
      id: "old", label: "l", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
      claudeSessionId: "sess-legacy", hookToken: "t", status: "idle", createdAt: 1,
    }));
    const rec = await new SessionStore(dir).load("old");
    expect(rec?.sessionId).toBe("sess-legacy");
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults a record with no runtime to claude", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-rt-"));
    const store = new SessionStore(dir);
    await store.save({
      id: "a", label: "l", repo: "", worktree: "/w", branch: "", baseBranch: "",
      sessionId: null, hookToken: "t", status: "idle", createdAt: 1,
    });
    expect((await store.load("a"))?.runtime).toBe("claude");
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips an explicit codex runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "store-cx-"));
    const store = new SessionStore(dir);
    await store.save({
      id: "b", label: "l", repo: "", worktree: "/w", branch: "", baseBranch: "",
      sessionId: null, hookToken: "t", status: "idle", createdAt: 1, runtime: "codex",
    });
    expect((await store.load("b"))?.runtime).toBe("codex");
    await rm(dir, { recursive: true, force: true });
  });
});

// "Agent gone" decisions (queue Deliverer, scanner) read exists(), never
// load() === null: a reader can see a half-written record (decision 37).
describe("SessionStore.exists", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "store-exists-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("is true for a saved record and false for a missing file", async () => {
    const s = new SessionStore(dir);
    await s.save(rec("a"));
    expect(await s.exists("a")).toBe(true);
    expect(await s.exists("b")).toBe(false);
    await s.delete("a");
    expect(await s.exists("a")).toBe(false);
  });

  it("is true for a half-written record that load() reads as null", async () => {
    await writeFile(join(dir, "a.json"), "{\"id\":");
    const s = new SessionStore(dir);
    expect(await s.load("a")).toBeNull();
    expect(await s.exists("a")).toBe(true);
  });

  it("is false when the store dir does not exist yet", async () => {
    expect(await new SessionStore(join(dir, "nope")).exists("a")).toBe(false);
  });

  it("is true on a stat error other than ENOENT (ENOTDIR)", async () => {
    const notDir = join(dir, "file");
    await writeFile(notDir, "x");
    expect(await new SessionStore(notDir).exists("a")).toBe(true);
  });

  it("is false for an id that is not an agent id, and never stats outside the dir", async () => {
    const root = join(dir, "root");
    const s = new SessionStore(join(root, "sessions"));
    await mkdir(join(root, "sessions"), { recursive: true });
    await writeFile(join(root, "x.json"), JSON.stringify(rec("x")));
    expect(await s.exists("../x")).toBe(false);
  });
});

// The id becomes a file name, and Fastify decodes %2F in a route param, so an
// id that is not an agent id never reaches the file system (also flag off).
describe("SessionStore malformed ids", () => {
  let root: string;
  let dir: string;
  let s: SessionStore;
  const planted = (name: string) => join(root, `${name}.json`);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "store-trav-"));
    dir = join(root, "sessions");
    s = new SessionStore(dir);
    await s.save(rec("fleet-master"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("load('../x') is null and does not read a record planted outside the dir", async () => {
    await writeFile(planted("x"), JSON.stringify(rec("x")));
    expect(await s.load("../x")).toBeNull();
  });

  it("load('x/../fleet-master') is null although <dir>/fleet-master.json exists", async () => {
    expect(await s.load("fleet-master")).not.toBeNull();
    expect(await s.load("x/../fleet-master")).toBeNull();
  });

  it("save with a malformed id rejects and writes no file outside the dir", async () => {
    await expect(s.save(rec("../evil"))).rejects.toThrow(/invalid agent id/);
    expect(existsSync(planted("evil"))).toBe(false);
  });

  it("delete('../evil') leaves a planted file outside the dir in place", async () => {
    await writeFile(planted("evil"), "{}");
    await s.delete("../evil");
    expect(existsSync(planted("evil"))).toBe(true);
  });

  it("patch('../x') neither reads nor rewrites a record planted outside the dir", async () => {
    // Its own id points back at itself, so a read-then-save would overwrite it.
    const body = JSON.stringify(rec("../x"));
    await writeFile(planted("x"), body);
    await s.patch("../x", { status: "done" });
    expect(await readFile(planted("x"), "utf8")).toBe(body);
    expect(existsSync(join(dir, "x.json"))).toBe(false);
  });

  it("list() is unchanged: a file whose name is not an agent id is still listed, not an error", async () => {
    await writeFile(join(dir, "odd.name.json"), JSON.stringify({ ...rec("odd.name"), createdAt: 2 }));
    expect((await s.list()).map((r) => r.id)).toEqual(["fleet-master", "odd.name"]);
  });
});

describe("isMasterKind", () => {
  it("is true for the fleet master only (the cron master is retired)", () => {
    expect(isMasterKind("cron-master")).toBe(false);
    expect(isMasterKind("fleet-master")).toBe(true);
    expect(isMasterKind("issue")).toBe(false);
    expect(isMasterKind(undefined)).toBe(false);
  });
});

describe("isPersistentKind", () => {
  it("is true for the fleet master and a lead only", () => {
    expect(isPersistentKind("fleet-master")).toBe(true);
    expect(isPersistentKind("cron-master")).toBe(false);
    expect(isPersistentKind("lead")).toBe(true);
    expect(isPersistentKind("issue")).toBe(false);
    expect(isPersistentKind(undefined)).toBe(false);
  });
});
