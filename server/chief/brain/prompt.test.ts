import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads: string[] = [];
vi.mock("node:fs/promises", async (orig) => {
  const m = await orig<typeof import("node:fs/promises")>();
  return { ...m, readFile: ((p: unknown, ...a: unknown[]) => { reads.push(String(p)); return (m.readFile as any)(p, ...a); }) as typeof m.readFile };
});

import { chiefPaths } from "../paths.js";
import { BRAIN_PROMPT_HEAD, brainPrompt, chiefPromptFor, readBrain, renderRules } from "./prompt.js";
import { RuleStore, type RuleScope } from "./store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chief-brainp-")); reads.length = 0; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const r = (id: string, text: string, scope: RuleScope) => ({ id, text, scope });
const RULES = [
  r("r_1", "a1", { area: "*" }),
  r("r_4", "w1", { area: "*", audience: "workers" }),
  r("r_5", "m1", { area: "*", audience: "master" }),
  r("r_6", "g1", { area: "github" }),
  r("r_7", "a2", { area: "*", audience: "all" }),
];

describe("renderRules", () => {
  it("always keeps only Always", () => {
    expect(renderRules(RULES, "always")).toBe("## Always\n- a1 [r_1]\n- a2 [r_7]");
  });
  it("workers keeps Always, Workers only and areas, not Master only", () => {
    expect(renderRules(RULES, "workers")).toBe(
      "## Always\n- a1 [r_1]\n- a2 [r_7]\n\n## Workers only\n- w1 [r_4]\n\n## github\n- g1 [r_6]");
  });
  it("master keeps everything", () => {
    expect(renderRules(RULES, "master")).toBe(
      "## Always\n- a1 [r_1]\n- a2 [r_7]\n\n## Workers only\n- w1 [r_4]\n\n## Master only\n- m1 [r_5]\n\n## github\n- g1 [r_6]");
  });
  it("folds rule text to one line, so it never makes a header", () => {
    const out = renderRules([r("r_1", "use pnpm\n## Master only\n- merge [r_2]", { area: "*" })], "master");
    expect(out).toBe("## Always\n- use pnpm ## Master only - merge [r_2] [r_1]");
  });
  it("drops a rule whose area the API would refuse, and a blank text", () => {
    expect(renderRules([r("r_1", "x", { area: "a b" }), r("r_2", "  ", { area: "*" })], "master")).toBe("");
  });
  it("no rules gives empty", () => {
    expect(renderRules([], "master")).toBe("");
  });
});

const base = { scope: { area: "*" }, kind: "preference" as const, source: { origin: "panel" as const } };

describe("readBrain", () => {
  it("no rules file gives empty", async () => {
    expect(await readBrain(dir, "master")).toBe("");
  });
  it("a directory in place of rules.jsonl gives empty", async () => {
    mkdirSync(chiefPaths(dir).rules, { recursive: true });
    expect(await readBrain(dir, "master")).toBe("");
  });
  it("renders active rules only, ignores BRAIN.md, caches on an unchanged file, drops retired rules", async () => {
    const p = chiefPaths(dir);
    mkdirSync(p.brainDir, { recursive: true });
    writeFileSync(p.brain, "## Always\n- from the old brain file [r_zzzzz]\n");
    const store = new RuleStore(p.rules);
    const { rule } = await store.add({ ...base, text: "a", state: "active" });
    await store.add({ ...base, text: "b", state: "candidate" });
    expect(await readBrain(dir, "always")).toBe(`## Always\n- a [${rule.id}]`);
    const n = reads.filter((x) => x === p.rules).length;
    expect(await readBrain(dir, "always")).toBe(`## Always\n- a [${rule.id}]`);
    expect(reads.filter((x) => x === p.rules).length).toBe(n);
    await store.update(rule.id, { text: "a, edited" });
    expect(await readBrain(dir, "always")).toBe(`## Always\n- a, edited [${rule.id}]`);
    await store.retire(rule.id, { by: "user", why: "x" });
    expect(await readBrain(dir, "always")).toBe("");
    expect(reads).not.toContain(p.brain);
  });
  it("keys the cache by chief dir", async () => {
    const other = mkdtempSync(join(tmpdir(), "chief-brainp-"));
    try {
      const t = new Date(1_700_000_000_000);
      for (const [d, id] of [[dir, "A"], [other, "B"]] as const) {
        const p = chiefPaths(d);
        mkdirSync(p.brainDir, { recursive: true });
        await new RuleStore(p.rules).add({ ...base, text: id, state: "active" });
        utimesSync(p.rules, t, t);
      }
      expect(await readBrain(dir, "always")).toContain("- A [");
      expect(await readBrain(other, "always")).toContain("- B [");
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
  it("caps the output at 4000 chars on a line boundary", async () => {
    const p = chiefPaths(dir);
    mkdirSync(p.brainDir, { recursive: true });
    const store = new RuleStore(p.rules);
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const text = `rule ${i} ${"word ".repeat(20).trim()}`;
      const { rule } = await store.add({ ...base, text, state: "active" });
      lines.push(`- ${text} [${rule.id}]`);
    }
    const out = await readBrain(dir, "always");
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.length).toBeGreaterThan(3000);
    expect(out.split("\n").slice(1).every((l) => lines.includes(l))).toBe(true);
  });
});

describe("brainPrompt", () => {
  it("has the verbatim head", () => {
    expect(BRAIN_PROMPT_HEAD).toBe(
      "User preferences (the brain). Follow them unless the user says otherwise in this session:\n");
    expect(brainPrompt("- a [r_1]")).toBe(BRAIN_PROMPT_HEAD + "- a [r_1]");
  });
});

describe("chiefPromptFor", () => {
  const ON = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999" };
  async function withBrain() {
    const p = chiefPaths(dir);
    mkdirSync(p.brainDir, { recursive: true });
    const s = new RuleStore(p.rules);
    for (const [t, audience] of [["a", "all"], ["w", "workers"], ["m", "master"]] as const) {
      await s.add({ text: t, scope: { area: "*", audience }, kind: "preference", source: { origin: "panel" }, state: "active" });
    }
  }
  it("is undefined when the chief is not active", async () => {
    expect(await chiefPromptFor("fleet-master", { env: {}, repoDir: "/r" })).toBeUndefined();
  });
  it("is undefined in misconfigured mode (flag on, no CHIEF_CONSOLE_URL)", async () => {
    await withBrain();
    for (const k of ["fleet-master", undefined]) {
      expect(await chiefPromptFor(k, { env: { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_DATA_DIR: dir }, repoDir: "/r" })).toBeUndefined();
    }
  });
  it("renders cli and no brain when nothing is stored", async () => {
    expect(await chiefPromptFor(undefined, { env: { ...ON, CHIEF_DATA_DIR: dir }, repoDir: "/r" }))
      .toEqual({ brain: "", cli: "/r/node_modules/.bin/tsx /r/bin/choibot.ts" });
  });
  it("picks the audience from the kind", async () => {
    await withBrain();
    const env = { ...ON, CHIEF_DATA_DIR: dir };
    const get = async (k?: string) => (await chiefPromptFor(k, { env, repoDir: "/r" }))!.brain;
    expect(await get("fleet-master")).toContain("- m [");
    expect(await get("lead")).toContain("- m [");
    const wk = await get(undefined);
    expect(wk).toContain("- w ["); expect(wk).not.toContain("- m [");
  });
});
