import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { QueueStore } from "../queue/store.js";
import { addItem, type AddDeps } from "../queue/add.js";
import { AreaStore, areaOfOrRepo } from "./areas.js";

let root: string;
let file: string;
let live: Set<string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-areas-"));
  file = join(root, "areas.json");
  live = new Set();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const mk = () => new AreaStore(file, { exists: async (id) => live.has(id) });

describe("AreaStore", () => {
  it("areaOf maps a listed repo to its area, else itself", async () => {
    const s = mk();
    await s.set("app-shop", { repos: ["app-shop", "demo"] });
    expect(await s.areaOf("demo")).toBe("app-shop");
    expect(await s.areaOf("other")).toBe("other");
  });
  it("a missing or torn file reads as {} and areaOf returns the repo", async () => {
    const s = mk();
    expect(await s.read()).toEqual({});
    writeFileSync(file, '{"app-shop": {"repos": ["a"');
    expect(await s.read()).toEqual({});
    expect(await s.areaOf("x")).toBe("x");
    expect(await s.leadFor("app-shop")).toBeUndefined();
  });
  it("two concurrent sets keep both areas", async () => {
    const s = mk();
    await Promise.all([s.set("a", { repos: ["r1"] }), s.set("b", { repos: ["r2"], leadId: "lead-b" })]);
    expect(Object.keys(await s.read()).sort()).toEqual(["a", "b"]);
    expect(await s.leadFor("b")).toBe("lead-b");
  });
  it("a bad area name rejects", async () => {
    const s = mk();
    for (const bad of ["", "A", "-x", "a b", "a".repeat(33), "../x"]) {
      await expect(s.set(bad, { repos: [] })).rejects.toThrow();
    }
    expect(await s.read()).toEqual({});
  });
  it("isLiveLead needs a listed lead id and an existing record", async () => {
    const s = mk();
    await s.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    expect(await s.isLiveLead("lead-app-shop")).toBe(false);
    live.add("lead-app-shop");
    expect(await s.isLiveLead("lead-app-shop")).toBe(true);
    expect(await s.isLiveLead("lead-other")).toBe(false);
    live.delete("lead-app-shop");
    expect(await s.isLiveLead("lead-app-shop")).toBe(false);
  });
});

describe("AreaStore avatar pick", () => {
  it("setAvatar saves a pick for an area that exists; set and setRepos keep it; 0 removes it", async () => {
    const s = mk();
    expect(await s.setAvatar("app-shop", 4)).toBe(false);
    expect(await s.read()).toEqual({});
    await s.set("app-shop", { repos: ["app-shop"] });
    expect(await s.setAvatar("app-shop", 4)).toBe(true);
    await s.set("app-shop", { repos: ["app-shop"], leadId: "lead-app-shop" });
    await s.setRepos("app-shop", ["app-shop", "demo"]);
    expect(await s.read()).toEqual({ "app-shop": { repos: ["app-shop", "demo"], leadId: "lead-app-shop", avatar: 4 } });
    expect(await s.setAvatar("app-shop", 0)).toBe(true);
    expect(await s.read()).toEqual({ "app-shop": { repos: ["app-shop", "demo"], leadId: "lead-app-shop" } });
    expect(await s.setAvatar("../x", 1)).toBe(false);
  });
  it("a bad pick in the file reads as none", async () => {
    writeFileSync(file, JSON.stringify({ a: { repos: [], avatar: 99 }, b: { repos: [], avatar: "3" }, c: { repos: [], avatar: 2 } }));
    expect(await mk().read()).toEqual({ a: { repos: [] }, b: { repos: [] }, c: { repos: [], avatar: 2 } });
  });
});

describe("AreaStore.read validation (Task 3-7)", () => {
  it("drops an entry with a bad area name, a repos that is not a string array, or a bad leadId", async () => {
    writeFileSync(file, JSON.stringify({
      "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop" },
      indexer: { repos: ["indexer"] },
      "Bad Name": { repos: ["x"] },
      "../up": { repos: ["y"] },
      norepos: { leadId: "lead-norepos" },
      mixed: { repos: ["ok", 3] },
      numlead: { repos: ["n"], leadId: 7 },
      other: { repos: ["o"], leadId: "fleet-master" },
      nulled: null,
    }));
    const s = mk();
    expect(await s.read()).toEqual({
      "app-shop": { repos: ["app-shop"], leadId: "lead-app-shop" },
      indexer: { repos: ["indexer"] },
    });
    // A dropped entry maps nothing: its repo is its own area.
    expect(await s.areaOf("x")).toBe("x");
    live.add("fleet-master");
    expect(await s.isLiveLead("fleet-master")).toBe(false);
  });
});

describe("areaOfOrRepo", () => {
  it("maps through areas.json; an unreadable file gives the repo and one log line", async () => {
    const lines: string[] = [];
    await mk().set("app-shop", { repos: ["demo"] });
    expect(await areaOfOrRepo(mk(), (l) => lines.push(l))("demo")).toBe("app-shop");
    expect(lines).toEqual([]);
    rmSync(file);
    mkdirSync(file); // EISDIR on read
    expect(await areaOfOrRepo(mk(), (l) => lines.push(l))("demo")).toBe("demo");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("demo");
  });
});

describe("addItem area", () => {
  const rec = (o: Partial<AgentRecord> = {}): AgentRecord => ({
    id: "a1", label: "x", repo: "/ws/demo", worktree: "/ws/wt", branch: "agent/x", baseBranch: "main",
    sessionId: null, hookToken: "t", status: "running", createdAt: 1, ...o,
  });
  async function run(r: AgentRecord) {
    const areas = mk();
    await areas.set("app-shop", { repos: ["app-shop", "demo"] });
    const store = new QueueStore(join(root, "queue"), { log: () => {} });
    const d: AddDeps = {
      store, agents: { load: async () => r }, workspaceDir: "/ws", agentRoots: [root],
      listRepos: async () => [], prStatus: async () => { throw new Error("no"); }, isAncestor: async () => false,
      areaOf: (repo) => areas.areaOf(repo),
    };
    const { id } = await addItem(d, r.id, { kind: "question", title: "t", body: "b" }, { agentId: r.id, kind: r.kind === "lead" ? "lead" : "worker" });
    return (await store.get(id))!;
  }
  it("a worker item in repo demo gets area app-shop", async () => {
    expect((await run(rec())).area).toBe("app-shop");
  });
  it("a lead's own item gets rec.area", async () => {
    const it = await run(rec({ id: "lead-app-shop", kind: "lead", area: "app-shop", repo: "" }));
    expect(it.area).toBe("app-shop");
  });
});
