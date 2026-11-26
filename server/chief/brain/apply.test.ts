import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, onChain, readJsonl } from "../files.js";
import { chiefPaths, type ChiefPaths } from "../paths.js";
import type { ConsoleEvent } from "../../events.js";
import { brainChainKey } from "./chain.js";
import { applyProposal, discardProposal, listVersions, rollbackBrain } from "./apply.js";
import { RuleStore, type RuleEvent } from "./store.js";

let root: string;
let paths: ChiefPaths;
let rules: RuleStore;
let events: ConsoleEvent[];
let t: number;
const hub = { emitEvent: (e: ConsoleEvent) => { events.push(e); } };
const now = () => t;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chief-apply-"));
  paths = chiefPaths(root);
  await mkdir(paths.brainDir, { recursive: true });
  rules = new RuleStore(paths.rules);
  events = [];
  t = 1000;
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function propose(text: string, retire: { id: string; why: string; text: string }[] = []) {
  await writeFile(paths.proposed, text);
  await writeFile(join(paths.brainDir, "proposal.json"), JSON.stringify({ sha256: sha(text), retire, createdAt: 1 }));
}
const deps = () => ({ paths, rules, hub, now });

describe("applyProposal", () => {
  it("rotates the old brain into versions, installs the proposal, deletes the files, emits brain", async () => {
    await atomicWrite(paths.brain, "old");
    await propose("new");
    t = 2000;
    const r = await applyProposal(deps());
    expect(r).toEqual({ version: "2000" });
    expect(await readFile(paths.brain, "utf8")).toBe("new");
    expect(await readFile(join(paths.versionsDir, "2000.md"), "utf8")).toBe("old");
    expect(existsSync(paths.proposed)).toBe(false);
    expect(existsSync(join(paths.brainDir, "proposal.json"))).toBe(false);
    expect(events).toEqual([{ type: "brain", updatedAt: 2000, proposed: false }]);
  });
  it("works without a current BRAIN.md; no version saved → version null", async () => {
    await propose("new");
    expect(await applyProposal(deps())).toEqual({ version: null });
    expect(await readFile(paths.brain, "utf8")).toBe("new");
    expect(await listVersions(paths)).toEqual([]);
  });
  it("an apply of the text already in BRAIN.md saves no version → version null", async () => {
    await atomicWrite(paths.brain, "a");
    await propose("b"); t = 5000; await applyProposal(deps());
    await propose("b"); t = 6000;
    expect(await applyProposal(deps())).toEqual({ version: null });
    expect(await listVersions(paths)).toEqual(["5000"]);
  });
  it("prunes to 3 versions after four applies", async () => {
    await atomicWrite(paths.brain, "v0");
    for (let i = 1; i <= 4; i++) { t = 1000 * i; await propose(`v${i}`); await applyProposal(deps()); }
    expect(await listVersions(paths)).toEqual(["4000", "3000", "2000"]);
    expect(await readFile(paths.brain, "utf8")).toBe("v4");
  });
  it("bumps the version id when it exists", async () => {
    await atomicWrite(paths.brain, "a");
    await propose("b"); t = 5000; await applyProposal(deps());
    await propose("c"); await applyProposal(deps());
    expect(await listVersions(paths)).toEqual(["5001", "5000"]);
  });
  it("versions dir is mode 0700", async () => {
    await atomicWrite(paths.brain, "a");
    await propose("b");
    await applyProposal(deps());
    const { statSync } = await import("node:fs");
    expect(statSync(paths.versionsDir).mode & 0o777).toBe(0o700);
  });
  it("appends one retire per entry; skips unknown and already retired", async () => {
    const add = async (text: string) => (await rules.add({ text, scope: { area: "*" }, kind: "preference",
      source: { origin: "panel" }, state: "active" })).rule;
    const r1 = await add("Rule one");
    const r2 = await add("Rule two");
    await rules.retire(r2.id, { by: "user", why: "earlier" });
    await propose("new", [
      { id: r1.id, why: "dup", text: "Rule one" },
      { id: r2.id, why: "again", text: "Rule two" },
      { id: "r_zzzzz", why: "gone", text: "?" },
    ]);
    await applyProposal(deps());
    const evs = (await readJsonl<RuleEvent>(paths.rules)).filter((e) => e.ev === "retire");
    expect(evs.map((e) => [e.id, (e as { by: string }).by])).toEqual([[r2.id, "user"], [r1.id, "distill"]]);
    expect(await readFile(paths.brain, "utf8")).toBe("new");
    expect(events).toHaveLength(1);
  });
  it("rejects with no proposal", async () => {
    await expect(applyProposal(deps())).rejects.toThrow("no proposal");
  });
  it("treats half-there files as no proposal", async () => {
    await writeFile(paths.proposed, "x");
    await expect(applyProposal(deps())).rejects.toThrow("no proposal");
    await rm(paths.proposed);
    await writeFile(join(paths.brainDir, "proposal.json"), "{}");
    await expect(applyProposal(deps())).rejects.toThrow("no proposal");
  });
});

describe("discardProposal", () => {
  it("removes the files and emits", async () => {
    await propose("new");
    t = 3000;
    await discardProposal({ paths, hub, now });
    expect(existsSync(paths.proposed)).toBe(false);
    expect(existsSync(join(paths.brainDir, "proposal.json"))).toBe(false);
    expect(events).toEqual([{ type: "brain", updatedAt: 3000, proposed: false }]);
  });
  it("is fine with no proposal", async () => {
    await discardProposal({ paths, hub });
    expect(events).toHaveLength(1);
  });
});

describe("rollbackBrain", () => {
  async function two() {
    await atomicWrite(paths.brain, "v0");
    for (let i = 1; i <= 2; i++) { t = 1000 * i; await propose(`v${i}`); await applyProposal(deps()); }
  }
  it("restores the previous text and keeps the current in versions", async () => {
    await two();
    t = 9000;
    const r = await rollbackBrain(deps());
    expect(r).toEqual({ version: "2000" });
    expect(await readFile(paths.brain, "utf8")).toBe("v1");
    expect(await listVersions(paths)).toEqual(["9000", "1000"]);
    expect(await readFile(join(paths.versionsDir, "9000.md"), "utf8")).toBe("v2");
    expect(events.at(-1)).toEqual({ type: "brain", updatedAt: 9000, proposed: false });
  });
  it("rolls back to a named version", async () => {
    await two();
    t = 9000;
    await rollbackBrain(deps(), "1000");
    expect(await readFile(paths.brain, "utf8")).toBe("v0");
    expect(await listVersions(paths)).toEqual(["9000", "2000"]);
  });
  it("rejects unknown and malformed versions", async () => {
    await two();
    for (const v of ["7", "../x", "1000.md", "", "1e3", "-1"]) await expect(rollbackBrain(deps(), v)).rejects.toThrow("unknown version");
    expect(await readFile(paths.brain, "utf8")).toBe("v2");
  });
  it("rejects with no versions", async () => {
    await expect(rollbackBrain(deps())).rejects.toThrow("unknown version");
  });
  it("keeps the proposal flag in the event when a proposal waits", async () => {
    await two();
    await propose("pending");
    await rollbackBrain(deps());
    expect(events.at(-1)).toMatchObject({ proposed: true });
  });
});

describe("serialization", () => {
  it("concurrent applies do not interleave", async () => {
    await atomicWrite(paths.brain, "v0");
    await propose("p");
    const res = await Promise.allSettled([applyProposal(deps()), applyProposal(deps())]);
    expect(res.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await readdir(paths.versionsDir))).toEqual(["1000.md"]);
  });
});

describe("fix round 1", () => {
  const sj = () => join(paths.brainDir, "proposal.json");
  it("apply with a stale expectSha256 rejects 'changed' and writes nothing", async () => {
    await atomicWrite(paths.brain, "old");
    await propose("new");
    await expect(applyProposal({ ...deps(), expectSha256: "stale" })).rejects.toThrow("changed");
    expect(await readFile(paths.brain, "utf8")).toBe("old");
    expect(existsSync(paths.proposed)).toBe(true);
    expect(await listVersions(paths)).toEqual([]);
    await applyProposal({ ...deps(), expectSha256: sha("new") });
    expect(await readFile(paths.brain, "utf8")).toBe("new");
  });
  it("discard with a stale sha rejects and keeps the proposal", async () => {
    await propose("new");
    await expect(discardProposal({ paths, hub, expectSha256: "stale" })).rejects.toThrow("changed");
    expect(existsSync(paths.proposed)).toBe(true);
    expect(existsSync(sj())).toBe(true);
    expect(events).toHaveLength(0);
  });
  it("a proposal write queued during an apply lands after it", async () => {
    await atomicWrite(paths.brain, "old");
    await propose("new");
    const ap = applyProposal(deps());
    const w = onChain(brainChainKey(paths), async () => {
      await atomicWrite(paths.proposed, "next");
      await atomicWrite(sj(), JSON.stringify({ sha256: sha("next"), retire: [], createdAt: 2 }));
    });
    await Promise.all([ap, w]);
    expect(await readFile(paths.proposed, "utf8")).toBe("next");
    expect(existsSync(sj())).toBe(true);
    expect(await readFile(paths.brain, "utf8")).toBe("new");
  });
  it("re-apply after a crash before the proposal delete is idempotent", async () => {
    const add = async (text: string) => (await rules.add({ text, scope: { area: "*" }, kind: "preference",
      source: { origin: "panel" }, state: "active" })).rule;
    const r1 = await add("Rule one");
    await atomicWrite(paths.brain, "old");
    await propose("new", [{ id: r1.id, why: "dup", text: "Rule one" }]);
    await applyProposal(deps());
    // simulate the crash: the proposal files come back, BRAIN.md is already installed
    await propose("new", [{ id: r1.id, why: "dup", text: "Rule one" }]);
    t = 2000;
    const r = await applyProposal(deps());
    expect(await listVersions(paths)).toEqual(["1000"]);
    expect(r.version).toBeNull();
    expect((await readJsonl<RuleEvent>(paths.rules)).filter((e) => e.ev === "retire")).toHaveLength(1);
    expect(existsSync(paths.proposed)).toBe(false);
  });
  it("version id never goes below the newest when the clock goes back", async () => {
    await atomicWrite(paths.brain, "v0");
    t = 5000; await propose("v1"); await applyProposal(deps());
    t = 100; await propose("v2"); await applyProposal(deps());
    expect(await listVersions(paths)).toEqual(["5001", "5000"]);
    t = 50; await propose("v3"); await applyProposal(deps());
    t = 40; await propose("v4"); await applyProposal(deps());
    expect(await listVersions(paths)).toEqual(["5003", "5002", "5001"]);
    expect(await readFile(join(paths.versionsDir, "5003.md"), "utf8")).toBe("v3");
  });
  it("emits the event even when the retires fail with a non-RuleError", async () => {
    await atomicWrite(paths.brain, "old");
    await propose("new", [{ id: "r_aaaaa", why: "x", text: "x" }]);
    const bad = { retire: () => Promise.reject(new Error("disk")) } as unknown as RuleStore;
    await expect(applyProposal({ ...deps(), rules: bad })).rejects.toThrow("disk");
    expect(await readFile(paths.brain, "utf8")).toBe("new");
    expect(events).toEqual([{ type: "brain", updatedAt: 1000, proposed: false }]);
    expect(existsSync(paths.proposed)).toBe(true);
  });
  it("sorts versions numerically", async () => {
    await mkdir(paths.versionsDir, { recursive: true });
    for (const n of ["999", "1000", "50"]) await writeFile(join(paths.versionsDir, `${n}.md`), n);
    expect(await listVersions(paths)).toEqual(["1000", "999", "50"]);
  });
  it("rollback with no BRAIN.md restores and makes no version of nothing", async () => {
    await mkdir(paths.versionsDir, { recursive: true });
    await writeFile(join(paths.versionsDir, "10.md"), "ten");
    await rollbackBrain(deps());
    expect(await readFile(paths.brain, "utf8")).toBe("ten");
    expect(await listVersions(paths)).toEqual([]);
  });
  it("rollback leaves the proposal files untouched", async () => {
    await mkdir(paths.versionsDir, { recursive: true });
    await writeFile(join(paths.versionsDir, "10.md"), "ten");
    await propose("pending");
    await rollbackBrain(deps());
    expect(await readFile(paths.proposed, "utf8")).toBe("pending");
    expect(existsSync(sj())).toBe(true);
  });
});
