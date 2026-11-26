// server/chief/brain/capture.test.ts — user lines into the brain (spec §6.2
// sources 1–2, Review Focus 4).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore, type AgentRecord } from "../../agents/store.js";
import { captureUserLine, composerLineOf, type CaptureDeps } from "./capture.js";
import { DecisionLog, RULE_TEXT_MAX, RuleStore, type Rule } from "./store.js";

const PR = "https://github.com/acme/choibot/pull/7";

let dir: string;
let decisions: DecisionLog;
let rules: RuleStore;
let cards: Rule[];
let logs: string[];
let deps: CaptureDeps;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-capture-"));
  decisions = new DecisionLog(join(dir, "decisions.jsonl"));
  rules = new RuleStore(join(dir, "rules.jsonl"));
  cards = [];
  logs = [];
  deps = { decisions, rules, onCandidate: async (r) => { cards.push(r); }, log: (s) => logs.push(s) };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const strip = <T extends { at: number }>(l: T): Omit<T, "at"> => {
  const { at: _at, ...rest } = l;
  return rest;
};

describe("captureUserLine: the decision line", () => {
  it("appends one user line with via, ids and the text, correction null", async () => {
    expect(await captureUserLine(deps, { text: "use pnpm here", via: "composer", agentId: "a1", prUrl: PR, repo: "choibot" }))
      .toEqual({});
    const lines = await decisions.read();
    expect(lines.map(strip)).toEqual([
      { by: "user", correction: null, via: "composer", agentId: "a1", prUrl: PR, repo: "choibot", text: "use pnpm here" },
    ]);
    expect(await rules.all()).toEqual([]);
    expect(cards).toEqual([]);
  });

  it("writes no undefined keys for absent ids", async () => {
    await captureUserLine(deps, { text: "hello", via: "issue-telegram" });
    expect(Object.keys((await decisions.read())[0]!).sort()).toEqual(["at", "by", "correction", "text", "via"]);
  });

  it("a line that only contains rule: later is not a rule line", async () => {
    await captureUserLine(deps, { text: "please add a rule: always run tests", via: "composer" });
    expect(await rules.all()).toEqual([]);
    expect(await decisions.read()).toHaveLength(1);
  });
});

describe("captureUserLine: the rule: prefix", () => {
  it("creates a user-line candidate from the rest of the line and calls onCandidate", async () => {
    const r = await captureUserLine(deps, { text: "rule: always run tests", via: "composer", agentId: "a1", prUrl: PR, repo: "choibot" });
    expect(r).toEqual({});
    const all = await rules.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      text: "always run tests", state: "candidate", confidence: 0.6, kind: "preference",
      scope: { area: "*", audience: "all" },
      source: { origin: "user-line", via: "composer", agentId: "a1", prUrl: PR },
    });
    expect(Object.keys(all[0]!.source).sort()).toEqual(["agentId", "origin", "prUrl", "via"]);
    await vi.waitFor(() => expect(cards.map((c) => c.id)).toEqual([all[0]!.id]));
    // The decision line keeps the whole line, prefix included.
    expect((await decisions.read()).map((l) => l.text)).toEqual(["rule: always run tests"]);
  });

  it("matches the prefix case-insensitively after leading space", async () => {
    await captureUserLine(deps, { text: "  RULE:   Use pnpm, never npm  ", via: "master-tab", agentId: "fleet-master" });
    const all = await rules.all();
    expect(all.map((x) => x.text)).toEqual(["Use pnpm, never npm"]);
    expect(all[0]!.source).toEqual({ origin: "user-line", via: "master-tab", agentId: "fleet-master" });
  });

  it("takes only the rest of the first line", async () => {
    await captureUserLine(deps, { text: "rule: always run tests\n\nnow fix the footer", via: "composer" });
    expect((await rules.all()).map((x) => x.text)).toEqual(["always run tests"]);
    expect((await decisions.read())[0]!.text).toBe("rule: always run tests\n\nnow fix the footer");
  });

  it("cuts the rule text to 200 chars", async () => {
    await captureUserLine(deps, { text: `rule: ${"word ".repeat(80)}`, via: "composer" });
    const t = (await rules.all())[0]!.text;
    expect(t.length).toBeLessThanOrEqual(RULE_TEXT_MAX);
    expect(t.startsWith("word word")).toBe(true);
  });

  it("redacts a secret that straddles the 200-char cut (no cut before the redaction)", async () => {
    // A 60-char token from offset 180: a cut at 200 first would keep 20 chars
    // that no pattern matches.
    const secret = "A1b2C3d4E5".repeat(6);
    await captureUserLine(deps, { text: `rule: ${"ab ".repeat(60)}${secret}`, via: "composer" });
    const t = (await rules.all())[0]!.text;
    expect(t).not.toContain("A1b2C3d4E5");
    expect(t.endsWith("[redacted]")).toBe(true);
  });

  it("Review Focus 4: rule: with nothing after it creates no candidate and still logs the line", async () => {
    for (const text of ["rule:", "rule:    ", "Rule: .", "rule:\nalways run tests"]) {
      expect(await captureUserLine(deps, { text, via: "composer" })).toEqual({});
    }
    expect(await rules.all()).toEqual([]);
    expect(cards).toEqual([]);
    expect(await decisions.read()).toHaveLength(4);
    expect(logs).toEqual([]);
  });

  it("a duplicate answers the hint and calls onCandidate once", async () => {
    await captureUserLine(deps, { text: "rule: always run tests", via: "composer" });
    const [first] = await rules.all();
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const r = await captureUserLine(deps, { text: "rule:  Always run  tests.", via: "master-tab" });
    expect(r).toEqual({ hint: `Already a rule (${first!.id}).` });
    expect(await rules.all()).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 10));
    expect(cards).toHaveLength(1);
    expect(await decisions.read()).toHaveLength(2);
  });

  it("does not wait for an onCandidate that never resolves", async () => {
    deps.onCandidate = () => new Promise<void>(() => {});
    expect(await captureUserLine(deps, { text: "rule: always run tests", via: "composer" })).toEqual({});
    expect(await rules.all()).toHaveLength(1);
  });

  it("logs an onCandidate that rejects or throws", async () => {
    deps.onCandidate = async () => { throw new Error("tg down"); };
    await captureUserLine(deps, { text: "rule: one", via: "composer" });
    deps.onCandidate = () => { throw new Error("tg sync"); };
    await captureUserLine(deps, { text: "rule: two", via: "composer" });
    await vi.waitFor(() => expect(logs).toHaveLength(2));
    expect(logs.join("\n")).toContain("tg down");
    expect(logs.join("\n")).toContain("tg sync");
    expect(await rules.all()).toHaveLength(2);
  });

  it("works without onCandidate", async () => {
    delete deps.onCandidate;
    expect(await captureUserLine(deps, { text: "rule: always run tests", via: "composer" })).toEqual({});
    expect(await rules.all()).toHaveLength(1);
  });
});

describe("captureUserLine: best effort", () => {
  it("a throwing decisions.append is logged and the candidate is still created", async () => {
    vi.spyOn(decisions, "append").mockRejectedValue(new Error("disk full"));
    expect(await captureUserLine(deps, { text: "rule: always run tests", via: "composer" })).toEqual({});
    expect(logs.join("\n")).toContain("disk full");
    expect(await rules.all()).toHaveLength(1);
  });

  it("a throwing rules.add is logged and never rejects", async () => {
    vi.spyOn(rules, "add").mockRejectedValue(new Error("rules broken"));
    expect(await captureUserLine(deps, { text: "rule: always run tests", via: "composer" })).toEqual({});
    expect(logs.join("\n")).toContain("rules broken");
    expect(await decisions.read()).toHaveLength(1);
  });

  it("logs with console.warn when no log is given", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete deps.log;
    vi.spyOn(decisions, "append").mockRejectedValue(new Error("disk full"));
    await captureUserLine(deps, { text: "hello", via: "composer" });
    expect(String(warn.mock.calls[0]?.[0])).toContain("disk full");
    warn.mockRestore();
  });
});

describe("composerLineOf", () => {
  const rec = (id: string, o: Partial<AgentRecord> = {}): AgentRecord => ({
    id, label: id, repo: "/ws/choibot", worktree: "/w", branch: "agent/x", baseBranch: "main",
    sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...o,
  });

  it("reads via, prUrl and repo from the record", async () => {
    const agents = new SessionStore(join(dir, "agents"));
    await agents.save(rec("worker-1", { prUrl: PR }));
    await agents.save(rec("worker-2"));
    await agents.save(rec("fleet-master", { kind: "fleet-master", repo: "" }));
    await agents.save(rec("issue-1", { kind: "issue", repo: "/ws/app-shop" }));
    expect(await composerLineOf(agents, "worker-1")).toEqual({ via: "composer", repo: "choibot", prUrl: PR });
    expect(await composerLineOf(agents, "worker-2")).toEqual({ via: "composer", repo: "choibot" });
    expect(await composerLineOf(agents, "fleet-master")).toEqual({ via: "master-tab", repo: "workspace" });
    expect(await composerLineOf(agents, "issue-1")).toEqual({ via: "composer", repo: "app-shop" });
    expect(await composerLineOf(agents, "gone")).toEqual({ via: "composer" });
    expect(existsSync(join(dir, "decisions.jsonl"))).toBe(false);
  });
});
