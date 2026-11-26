// server/services/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceStore, type ServiceRecord } from "./store.js";

function rec(id: string): ServiceRecord {
  return {
    id, name: "Svc " + id, description: "d",
    command: "/bin/true", args: [], cwd: "/tmp", env: {},
    requiresConfirm: false, confirmMessage: "", autoRestart: false, createdAt: 1,
  };
}

describe("ServiceStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "svc-store-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("saves and loads a record", async () => {
    const s = new ServiceStore(dir);
    await s.save(rec("a"));
    expect((await s.load("a"))?.name).toBe("Svc a");
  });

  it("returns null for a missing record", async () => {
    expect(await new ServiceStore(dir).load("nope")).toBeNull();
  });

  it("lists records sorted by createdAt", async () => {
    const s = new ServiceStore(dir);
    await s.save({ ...rec("a"), createdAt: 2 });
    await s.save({ ...rec("b"), createdAt: 1 });
    expect((await s.list()).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("patches fields", async () => {
    const s = new ServiceStore(dir);
    await s.save(rec("a"));
    await s.patch("a", { autoRestart: true, name: "renamed" });
    const r = await s.load("a");
    expect(r?.autoRestart).toBe(true);
    expect(r?.name).toBe("renamed");
  });

  it("deletes a record", async () => {
    const s = new ServiceStore(dir);
    await s.save(rec("a"));
    await s.delete("a");
    expect(await s.load("a")).toBeNull();
  });
});

// The id becomes a file name, and Fastify decodes %2F in a route param, so an
// id that is not a service id never reaches the file system. The default
// services dir is a sibling of the agents dir: `../.agent-data/fleet-master`
// would otherwise reach an agent record.
describe("ServiceStore malformed ids", () => {
  let root: string;
  let dir: string;
  let s: ServiceStore;
  const planted = (name: string) => join(root, `${name}.json`);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "svc-trav-"));
    dir = join(root, "services");
    s = new ServiceStore(dir);
    await s.save(rec("svc1"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("load('../x') is null and does not read a record planted outside the dir", async () => {
    await writeFile(planted("x"), JSON.stringify(rec("x")));
    expect(await s.load("../x")).toBeNull();
  });

  it("load('x/../svc1') is null although <dir>/svc1.json exists", async () => {
    expect(await s.load("svc1")).not.toBeNull();
    expect(await s.load("x/../svc1")).toBeNull();
  });

  it("save with a malformed id rejects and writes no file outside the dir", async () => {
    await expect(s.save(rec("../evil"))).rejects.toThrow(/invalid service id/);
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
    await s.patch("../x", { name: "pwned" });
    expect(await readFile(planted("x"), "utf8")).toBe(body);
    expect(existsSync(join(dir, "x.json"))).toBe(false);
  });

  it("list() is unchanged: a file whose name is not a service id is still listed, not an error", async () => {
    await writeFile(join(dir, "odd.name.json"), JSON.stringify({ ...rec("odd.name"), createdAt: 2 }));
    expect((await s.list()).map((r) => r.id)).toEqual(["svc1", "odd.name"]);
  });
});
