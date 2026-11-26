import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TG_TEXT_MAX } from "../issues/telegram";
import type { Proposal } from "./brain/distill";
import type { Rule } from "./brain/store";
import { CardIndex, proposalCardText, proposalKeyboard, ruleCardKeyboard, ruleCardText, sha256Hex } from "./cards";

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "r_8f3k2", text: "Never squash merge", scope: { area: "git" }, kind: "preference",
  source: { origin: "user-line" }, state: "candidate", confidence: 0.6, hits: 0, strikes: 0, createdAt: 1, ...over,
});
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  text: "# Brain (2026-11-09)\n## Always\n- x [r_1]", sha256: "a".repeat(64), retire: [], createdAt: 1, ...over,
});
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const buttons = (k: { inline_keyboard: unknown[][] }) => k.inline_keyboard.flat() as Record<string, string>[];

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chief-cards-")); file = join(dir, "cards.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("rule cards", () => {
  it("candidate text and keyboard", () => {
    const r = rule({ scope: { area: "git", repo: "choibot", kind: "pr", audience: "workers" } });
    expect(ruleCardText(r)).toBe('New rule: "Never squash merge"\nScope: git · choibot · pr · workers');
    expect(ruleCardText(rule())).toContain("Scope: git · all");
    const b = buttons(ruleCardKeyboard(rule()));
    expect(b.map((x) => x.callback_data)).toEqual(["q:k:r_8f3k2", "q:d:r_8f3k2"]);
    for (const x of b) expect(Buffer.byteLength(x.callback_data)).toBeLessThan(24);
  });
  it("active rule has Confirm only", () => {
    const r = rule({ state: "active" });
    expect(ruleCardText(r).startsWith('Rule: "')).toBe(true);
    expect(buttons(ruleCardKeyboard(r)).map((x) => x.callback_data)).toEqual(["q:k:r_8f3k2"]);
  });
});

describe("proposal cards", () => {
  it("lists retire lines before the brain, within the limit", () => {
    const t = proposalCardText(proposal({ retire: [{ id: "r_2", why: "stale", text: "Old" }] }));
    expect(t.startsWith("Brain proposal\n")).toBe(true);
    expect(t.indexOf('retire r_2 "Old" — stale')).toBeGreaterThan(0);
    expect(t.indexOf("retire r_2")).toBeLessThan(t.indexOf("# Brain"));
    expect(proposalCardText(proposal({ text: "x".repeat(9000) })).length).toBeLessThanOrEqual(TG_TEXT_MAX);
  });
  it("counts retire lines that do not fit", () => {
    const retire = Array.from({ length: 100 }, (_, i) => ({ id: `r_${i}`, why: "w".repeat(100), text: "t".repeat(100) }));
    const t = proposalCardText(proposal({ retire }));
    expect(t).toMatch(/\+\d+ more to retire/);
    expect(t).toContain("# Brain");
    expect(t.length).toBeLessThanOrEqual(TG_TEXT_MAX);
  });
  it("a retire line is cut to 240 units with … and never splits a surrogate pair", () => {
    // Prefix `retire r_2 "Old" — ` is 19 units; the emoji moves across the cut.
    for (let at = 230; at <= 245; at++) {
      const why = "w".repeat(at - 19) + "😀" + "w".repeat(40);
      const t = proposalCardText(proposal({ retire: [{ id: "r_2", why, text: "Old" }] }));
      const line = t.split("\n").find((l) => l.startsWith("retire r_2"))!;
      expect(LONE.test(line), `emoji at ${at}`).toBe(false);
      expect(line.length).toBeLessThanOrEqual(240);
      expect(line.endsWith("…")).toBe(true);
    }
  });
  it("a clipped card ends with the clipped note, within the limit, no lone surrogate", () => {
    for (const text of ["x".repeat(9000), "😀".repeat(4500), "x".repeat(3871) + "😀".repeat(100)]) {
      const t = proposalCardText(proposal({ text, retire: [{ id: "r_2", why: "stale", text: "Old" }] }));
      expect(t.length).toBeLessThanOrEqual(TG_TEXT_MAX);
      expect(t.endsWith("\n(clipped — open Diff in the console for the full text)")).toBe(true);
      expect(LONE.test(t)).toBe(false);
    }
    expect(proposalCardText(proposal())).not.toContain("clipped");
  });
  it("Diff button only for https", () => {
    const k = buttons(proposalKeyboard("https://c"));
    expect(k.map((x) => x.callback_data ?? x.url)).toEqual(["q:p:brain", "q:q:brain", "https://c/#brain=diff"]);
    expect(buttons(proposalKeyboard("https://c/"))[2].url).toBe("https://c/#brain=diff");
    expect(buttons(proposalKeyboard("http://127.0.0.1:4999"))).toHaveLength(2);
    expect(buttons(proposalKeyboard("not a url"))).toHaveLength(2);
  });
});

describe("CardIndex", () => {
  it("concurrent recordRule keeps both; fresh load finds them", async () => {
    const a = new CardIndex(file);
    await a.load();
    await Promise.all([a.recordRule(1, rule()), a.recordRule(2, rule({ id: "r_other", text: "B" }))]);
    JSON.parse(readFileSync(file, "utf8"));
    const b = new CardIndex(file);
    await b.load();
    expect(b.lookup(1)).toMatchObject({ kind: "rule", ruleId: "r_8f3k2", textSha256: sha256Hex("Never squash merge") });
    expect(b.lookup(2)).toMatchObject({ kind: "rule", ruleId: "r_other" });
  });
  it("records proposals, items and extras", async () => {
    const a = new CardIndex(file);
    await a.load([{ messageId: 7, itemId: "i1" }]);
    await a.recordProposal(3, proposal());
    a.addItem(8, "i2");
    expect(a.lookup(3)).toMatchObject({ kind: "brain", proposalSha256: "a".repeat(64) });
    expect(a.lookup(7)).toMatchObject({ kind: "item", itemId: "i1" });
    expect(a.lookup(8)).toMatchObject({ kind: "item", itemId: "i2" });
    const b = new CardIndex(file);
    await b.load();
    expect(b.lookup(3)?.kind).toBe("brain");
    expect(b.lookup(8)).toBeUndefined();
  });
  it("missing or corrupt file loads empty; bad entries dropped", async () => {
    const a = new CardIndex(file);
    await a.load();
    expect(a.lookup(1)).toBeUndefined();
    writeFileSync(file, "{not json");
    await a.load();
    expect(a.lookup(1)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ "1": { ruleId: 5, at: 1 }, "2": { brain: "h", at: 2 }, "x": { brain: "h", at: 2 }, "3": null }));
    await a.load();
    expect(a.lookup(1)).toBeUndefined();
    expect(a.lookup(2)).toMatchObject({ kind: "brain" });
    expect(a.lookup(3)).toBeUndefined();
  });
});
