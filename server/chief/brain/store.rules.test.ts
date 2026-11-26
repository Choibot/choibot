import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onChain, readJsonl } from "../files.js";
import { RULE_TEXT_MAX, RuleError, RuleStore, foldRules, normalizeRuleText, type RuleEvent } from "./store.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chief-rules-"));
  file = join(dir, "rules.jsonl");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ID = "r_8f3k2";
const add: RuleEvent = {
  ev: "add", id: ID, at: 1, text: "The user merges PRs; never offer to merge.",
  scope: { area: "*", audience: "all" }, kind: "correction",
  source: { origin: "user-line", itemId: "q7k2m9x1a", agentId: "a1", prUrl: "https://github.com/o/r/pull/1", via: "queue-tab" },
  confidence: 0.6, state: "candidate",
};
// The §6.1 example lines, with concrete values.
const example: RuleEvent[] = [
  add,
  { ev: "confirm", id: ID, at: 2, by: "user", via: "telegram", confidence: 0.9 },
  { ev: "edit", id: ID, at: 3, by: "user", text: "The user merges PRs; never offer to merge or rebase.",
    scope: { area: "github", audience: "workers" } },
  { ev: "hit", id: ID, at: 4, itemId: "q1" },
  { ev: "strike", id: ID, at: 5, itemId: "q2" },
  { ev: "retire", id: ID, at: 6, by: "user", why: "no longer true" },
];

// The fold path: the lines as they sit in rules.jsonl, read back with readJsonl.
async function foldFile(content: string) {
  writeFileSync(file, content);
  return foldRules(await readJsonl<RuleEvent>(file));
}
const jsonl = (events: RuleEvent[]) => events.map((e) => JSON.stringify(e) + "\n").join("");

describe("normalizeRuleText (spec §6.1 duplicates)", () => {
  it("trims, collapses whitespace, lower-cases and drops a trailing . or !", () => {
    expect(normalizeRuleText("  The user merges   PRs!  ")).toBe("the user merges prs");
    expect(normalizeRuleText("The user merges PRs.")).toBe("the user merges prs");
    expect(normalizeRuleText("Never\tmerge \n PRs !!.")).toBe("never merge prs");
  });

  it("caps rule text at 200 chars", () => {
    expect(RULE_TEXT_MAX).toBe(200);
  });

  it("is linear on a long run of trailing marks", () => {
    const t0 = performance.now();
    expect(normalizeRuleText("!".repeat(100_000) + "x")).toBe("!".repeat(100_000) + "x");
    expect(normalizeRuleText("x" + " !.".repeat(50_000))).toBe("x");
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe("foldRules (spec §6.1, §5.6 check 4)", () => {
  it("folds the §6.1 example to one active rule until the retire line, then retired", async () => {
    const before = await foldFile(jsonl(example.slice(0, 5)));
    expect([...before.keys()]).toEqual([ID]);
    expect(before.get(ID)).toEqual({
      id: ID, text: "The user merges PRs; never offer to merge or rebase.",
      scope: { area: "github", audience: "workers" }, kind: "correction", source: add.source,
      state: "active", confidence: 0.9, hits: 1, strikes: 1, createdAt: 1,
      latestConfirm: { seq: 1, at: 2, via: "telegram" }, latestEditSeq: 2,
    });

    const after = await foldFile(jsonl(example));
    expect(after.size).toBe(1);
    expect(after.get(ID)).toMatchObject({ state: "retired", hits: 1, strikes: 1, confidence: 0.9 });
  });

  it("an edit after the confirm has a higher seq than the confirm", () => {
    const r = foldRules([
      add,
      { ev: "confirm", id: ID, at: 10, by: "user", via: "tab", confidence: 0.9 },
      { ev: "edit", id: ID, at: 11, by: "user", confidence: 0.95 },
    ]).get(ID)!;
    expect(r.latestEditSeq).toBeGreaterThan(r.latestConfirm!.seq);
    expect(r.confidence).toBe(0.95);
  });

  it("uses append order, not at: edit then confirm with one at leaves the confirm newer", () => {
    const r = foldRules([
      add,
      { ev: "edit", id: ID, at: 7, by: "user", text: "Edited text" },
      { ev: "confirm", id: ID, at: 7, by: "user", via: "cli", confidence: 0.9 },
    ]).get(ID)!;
    expect(r.latestConfirm).toEqual({ seq: 2, at: 7, via: "cli" });
    expect(r.latestEditSeq).toBe(1);
    expect(r.latestConfirm!.seq).toBeGreaterThan(r.latestEditSeq!);
    expect(r.text).toBe("Edited text");
    expect(r.state).toBe("active");
  });

  it("a confirm resets strikes to 0 and keeps hits", () => {
    const r = foldRules([
      add,
      { ev: "hit", id: ID, at: 2, itemId: "q1" },
      { ev: "strike", id: ID, at: 3, itemId: "q2" },
      { ev: "strike", id: ID, at: 4, itemId: "q3" },
    ]).get(ID)!;
    expect(r.strikes).toBe(2);
    const confirmed = foldRules([
      add,
      { ev: "hit", id: ID, at: 2, itemId: "q1" },
      { ev: "strike", id: ID, at: 3, itemId: "q2" },
      { ev: "strike", id: ID, at: 4, itemId: "q3" },
      { ev: "confirm", id: ID, at: 5, by: "user", via: "telegram", confidence: 0.92 },
    ]).get(ID)!;
    expect(confirmed).toMatchObject({ strikes: 0, hits: 1, confidence: 0.92, state: "active" });
  });

  it("ignores events for an unknown id", () => {
    const rules = foldRules([
      add,
      { ev: "confirm", id: "r_zzzzz", at: 2, by: "user", via: "tab", confidence: 0.9 },
      { ev: "edit", id: "r_zzzzz", at: 3, by: "user", text: "x" },
      { ev: "hit", id: "r_zzzzz", at: 4, itemId: "q1" },
      { ev: "strike", id: "r_zzzzz", at: 5, itemId: "q2" },
      { ev: "retire", id: "r_zzzzz", at: 6, by: "distill", why: "x" },
    ]);
    expect([...rules.keys()]).toEqual([ID]);
    expect(rules.get(ID)).toEqual(foldRules([add]).get(ID));
  });

  it("Review Focus 2: a torn last line folds the earlier lines only", async () => {
    const rules = await foldFile(jsonl(example.slice(0, 2)) + '{"ev":"add","id":"r_');
    expect([...rules.keys()]).toEqual([ID]);
    expect(rules.get(ID)).toMatchObject({ state: "active", latestConfirm: { seq: 1, at: 2, via: "telegram" } });
  });

  it("Review Focus 2: an add on the line after a torn line still folds", async () => {
    const next: RuleEvent = { ...add, id: "r_00002", at: 3, text: "Next rule" };
    const rules = await foldFile(jsonl(example.slice(0, 2)) + '{"ev":"add","id":"r_\n' + jsonl([next]));
    expect([...rules.keys()]).toEqual([ID, "r_00002"]);
    expect(rules.get("r_00002")).toMatchObject({ text: "Next rule", state: "candidate", createdAt: 3 });
  });

  it("a retired rule stays retired: a later confirm does not bring it back", () => {
    const r = foldRules([...example, { ev: "confirm", id: ID, at: 7, by: "user", via: "telegram", confidence: 0.9 }]).get(ID)!;
    expect(r.state).toBe("retired");
    expect(r.latestConfirm).toEqual({ seq: 1, at: 2, via: "telegram" });
  });

  it("a second add for a known id is ignored", () => {
    const r = foldRules([add, { ...add, at: 9, text: "Other text", state: "active" }]).get(ID)!;
    expect(r).toMatchObject({ text: add.text, state: "candidate", createdAt: 1 });
  });

  it("skips a parsable line that is not an event object", async () => {
    const rules = await foldFile('null\n42\n"x"\n{"ev":"add"}\n' + jsonl([add]));
    expect([...rules.keys()]).toEqual([ID]);
  });

  it("drops events whose required fields have the wrong type", () => {
    const bad = [
      { ...add, id: "r_bad01", text: 42 },
      { ...add, id: "r_bad02", scope: null },
      { ...add, id: "r_bad03", scope: { audience: "all" } },
      { ...add, id: "r_bad04", source: "user-line" },
      { ...add, id: "r_bad05", kind: "rumor" },
      { ...add, id: "r_bad06", state: "retired" },
      { ...add, id: "r_bad07", confidence: "high" },
      { ...add, id: "r_bad08", at: "1" },
      { ...add, id: undefined },
      { ...add, ev: "zap" },
      { ev: "confirm", id: ID, at: 2, by: "user", via: "email", confidence: 0.9 },
      { ev: "confirm", id: ID, at: 3, by: "user", via: "tab", confidence: "0.9" },
      { ev: "edit", id: ID, at: 4, by: "user", text: 7 },
      { ev: "edit", id: ID, at: 5, by: "user", scope: "github" },
      { ev: "hit", id: ID, at: 6 },
      { ev: "strike", id: ID, at: 7, itemId: 3 },
      { ev: "retire", id: ID, at: 8, by: "cron", why: "x" },
    ] as unknown as RuleEvent[];
    const rules = foldRules([add, ...bad]);
    expect([...rules.keys()]).toEqual([ID]);
    expect(rules.get(ID)).toEqual(foldRules([add]).get(ID));
  });
});

describe("RuleStore writes (spec §6.1)", () => {
  let rf: string;
  beforeEach(() => { rf = join(dir, "brain", "rules.jsonl"); });
  const base = { scope: { area: "*", audience: "all" }, kind: "preference", source: { origin: "panel" } } as const;
  const lines = () => readFileSync(rf, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RuleEvent);
  const store = (o: { now?: () => number; newId?: () => string } = {}) => new RuleStore(rf, { now: () => 1000, ...o });

  it("a candidate add writes one add line with confidence 0.6", async () => {
    const s = store();
    const { rule, duplicate } = await s.add({ ...base, text: "Prefer small PRs.", state: "candidate" });
    expect(duplicate).toBe(false);
    expect(lines()).toEqual([{ ev: "add", id: rule.id, at: 1000, text: "Prefer small PRs.", ...base,
      confidence: 0.6, state: "candidate" }]);
    expect(rule).toMatchObject({ state: "candidate", confidence: 0.6, hits: 0, strikes: 0, createdAt: 1000 });
    expect(await s.get(rule.id)).toEqual(rule);
  });

  it("an active add writes add then confirm (via cli, confidence 0.9); via defaults to tab", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "Use pnpm.", state: "active", via: "cli" });
    expect(lines()).toEqual([
      { ev: "add", id: rule.id, at: 1000, text: "Use pnpm.", ...base, confidence: 0.9, state: "active" },
      { ev: "confirm", id: rule.id, at: 1000, by: "user", via: "cli", confidence: 0.9 },
    ]);
    expect(rule).toMatchObject({ state: "active", confidence: 0.9, latestConfirm: { seq: 1, at: 1000, via: "cli" } });
    const tab = await s.add({ ...base, text: "Use vitest.", state: "active" });
    expect(tab.rule.latestConfirm?.via).toBe("tab");
    expect((await s.active()).map((r) => r.id)).toEqual([rule.id, tab.rule.id]);
  });

  it("a duplicate add (normalized) returns the existing rule and writes nothing", async () => {
    const s = store();
    const first = await s.add({ ...base, text: "the user merges prs", state: "candidate" });
    const before = readFileSync(rf, "utf8");
    const again = await s.add({ ...base, text: "The user merges PRs.", state: "active" });
    expect(again).toEqual({ rule: first.rule, duplicate: true });
    expect(readFileSync(rf, "utf8")).toBe(before);
    expect((await s.findDuplicate("  THE user merges   PRs! "))?.id).toBe(first.rule.id);
    expect(await s.findDuplicate("   ")).toBeNull();
  });

  it("a duplicate of a retired rule is allowed and makes a new rule", async () => {
    const s = store();
    const first = await s.add({ ...base, text: "Squash merges.", state: "active" });
    await s.retire(first.rule.id, { by: "user", why: "changed my mind" });
    expect(await s.findDuplicate("Squash merges.")).toBeNull();
    const again = await s.add({ ...base, text: "squash merges", state: "candidate" });
    expect(again.duplicate).toBe(false);
    expect(again.rule.id).not.toBe(first.rule.id);
    expect((await s.all()).map((r) => [r.id, r.state])).toEqual([[first.rule.id, "retired"], [again.rule.id, "candidate"]]);
  });

  it("redacts a secret on add and on update", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "token sk-abcdefghijklmnop", state: "candidate" });
    expect(rule.text).toBe("token [redacted]");
    expect(lines()[0]).toMatchObject({ ev: "add", text: "token [redacted]" });
    const edited = await s.update(rule.id, { text: "x sk-abcdefghijklmnop" });
    expect(edited.text).toBe("x [redacted]");
    expect(lines()[1]).toEqual({ ev: "edit", id: rule.id, at: 1000, by: "user", text: "x [redacted]" });
    expect(readFileSync(rf, "utf8")).not.toContain("sk-abcdefghijklmnop");
  });

  it("stores a 250-char text cut to 200 chars", async () => {
    const text = "ab cd".repeat(50);
    expect(text.length).toBe(250);
    const { rule } = await store().add({ ...base, text, state: "candidate" });
    expect(rule.text).toBe(text.slice(0, RULE_TEXT_MAX));
    expect(lines()[0]).toMatchObject({ text: text.slice(0, 200) });
  });

  it("never stores a lone high surrogate at the end (an emoji at the cut, a torn one in the input)", async () => {
    const s = store();
    const head = "ab ".repeat(67).slice(0, RULE_TEXT_MAX - 1);
    const cut = await s.add({ ...base, text: head + "😀 tail", state: "candidate" });
    expect(cut.rule.text).toBe(head);
    const torn = await s.add({ ...base, text: "Prefer pnpm \uD83D  ", state: "candidate" });
    expect(torn.rule.text).toBe("Prefer pnpm");
    const edited = await s.update(torn.rule.id, { text: "Prefer yarn \uD83D" });
    expect(edited.text).toBe("Prefer yarn");
    expect(lines().map((l) => (l as { text?: string }).text).filter(Boolean)).toEqual([head, "Prefer pnpm", "Prefer yarn"]);
  });

  it("cuts an unbounded text before any normalize or regex", async () => {
    const s = store();
    const huge = "x " + "! ".repeat(500_000);
    const t0 = performance.now();
    expect(await s.findDuplicate(huge)).toBeNull();
    const { rule } = await s.add({ ...base, text: huge, state: "candidate" });
    expect(await s.findDuplicate(huge)).toEqual(rule);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(rule.text).toBe(huge.slice(0, RULE_TEXT_MAX).trimEnd());
    // A run with no whitespace longer than the redaction window is never
    // stored (it may hide a secret, spec §6.2), so it is blank.
    await expect(s.add({ ...base, text: "x" + "!".repeat(1_000_000), state: "candidate" })).rejects.toMatchObject({ code: 400 });
  });

  it("rejects blank text on add and on update and writes nothing", async () => {
    const s = store();
    await expect(s.add({ ...base, text: " \n\t ", state: "candidate" })).rejects.toMatchObject({ code: 400 });
    await expect(s.add({ ...base, text: "", state: "active" })).rejects.toBeInstanceOf(RuleError);
    expect(() => statSync(rf)).toThrow();
    const { rule } = await s.add({ ...base, text: "Keep it.", state: "candidate" });
    await expect(s.update(rule.id, { text: "   " })).rejects.toMatchObject({ code: 400 });
    expect(lines()).toHaveLength(1);
  });

  it("update with confirm writes edit then confirm with one at", async () => {
    let t = 0;
    const s = store({ now: () => ++t });
    const { rule } = await s.add({ ...base, text: "Old text.", state: "candidate" });
    const r = await s.update(rule.id, { text: "New text.", confirm: true, via: "cli" });
    const [, edit, confirm] = lines();
    expect(edit).toEqual({ ev: "edit", id: rule.id, at: 2, by: "user", text: "New text." });
    expect(confirm).toEqual({ ev: "confirm", id: rule.id, at: 2, by: "user", via: "cli", confidence: 0.9 });
    expect(r).toMatchObject({ text: "New text.", state: "active", latestEditSeq: 1, latestConfirm: { seq: 2, at: 2, via: "cli" } });
  });

  it("update with only confirm writes one confirm line and no edit", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "Only confirm.", state: "candidate" });
    const r = await s.update(rule.id, { confirm: true });
    expect(lines().map((l) => l.ev)).toEqual(["add", "confirm"]);
    expect(r).toMatchObject({ state: "active", latestConfirm: { via: "tab" } });
    expect(r.latestEditSeq).toBeUndefined();
  });

  it("two concurrent adds of the same text make one rule", async () => {
    const s = store();
    const [a, b] = await Promise.all([
      s.add({ ...base, text: "One rule.", state: "candidate" }),
      s.add({ ...base, text: "one rule", state: "active" }),
    ]);
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(b.rule.id).toBe(a.rule.id);
    expect(lines()).toHaveLength(1);
  });

  it("confirm called inside an onChain(\"chief-tg:rules\") callback completes", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "Confirm me.", state: "candidate" });
    const r = await onChain("chief-tg:rules", () => s.confirm(rule.id, { via: "telegram" }));
    expect(r).toMatchObject({ state: "active", confidence: 0.9, latestConfirm: { via: "telegram" } });
  });

  it("confirm and update refuse a retired rule and write nothing; retire twice writes one line", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "Retire me.", state: "candidate" });
    const retired = await s.retire(rule.id, { by: "distill", why: "stale" });
    expect(retired.state).toBe("retired");
    const before = readFileSync(rf, "utf8");
    await expect(s.confirm(rule.id, { via: "tab" })).rejects.toMatchObject({ code: 409 });
    await expect(s.update(rule.id, { text: "Back." })).rejects.toMatchObject({ code: 409 });
    await expect(s.update(rule.id, { confirm: true })).rejects.toBeInstanceOf(RuleError);
    expect(await s.retire(rule.id, { by: "user", why: "again" })).toEqual(retired);
    expect(readFileSync(rf, "utf8")).toBe(before);
  });

  it("update, confirm and retire reject an unknown id with 404", async () => {
    const s = store();
    await expect(s.update("r_zzzzz", { text: "x" })).rejects.toMatchObject({ code: 404 });
    await expect(s.confirm("r_zzzzz", { via: "tab" })).rejects.toMatchObject({ code: 404 });
    await expect(s.retire("r_zzzzz", { by: "user", why: "x" })).rejects.toMatchObject({ code: 404 });
    expect(() => statSync(rf)).toThrow();
  });

  it("hit and strike append a line; a retired rule gets none", async () => {
    const s = store();
    const { rule } = await s.add({ ...base, text: "Count me.", state: "active" });
    await s.hit(rule.id, "q1");
    await s.strike(rule.id, "q2");
    expect(lines().slice(2)).toEqual([
      { ev: "hit", id: rule.id, at: 1000, itemId: "q1" },
      { ev: "strike", id: rule.id, at: 1000, itemId: "q2" },
    ]);
    expect(await s.get(rule.id)).toMatchObject({ hits: 1, strikes: 1 });
    await s.retire(rule.id, { by: "user", why: "x" });
    await s.hit(rule.id, "q3");
    await s.strike("r_zzzzz", "q4");
    expect(lines()).toHaveLength(5);
  });

  it("rejects a confidence outside 0..1", async () => {
    const s = store();
    await expect(s.add({ ...base, text: "Sure.", state: "candidate", confidence: 2 })).rejects.toMatchObject({ code: 400 });
    const { rule } = await s.add({ ...base, text: "Sure.", state: "candidate" });
    await expect(s.confirm(rule.id, { via: "tab", confidence: Number.NaN })).rejects.toMatchObject({ code: 400 });
    expect(lines()).toHaveLength(1);
  });

  it("generated ids match r_ + 5 base36 chars", async () => {
    const s = store();
    for (let n = 0; n < 20; n++) {
      const { rule } = await s.add({ ...base, text: `Rule number ${n}.`, state: "candidate" });
      expect(rule.id).toMatch(/^r_[0-9a-z]{5}$/);
    }
    expect(new Set((await s.all()).map((r) => r.id)).size).toBe(20);
  });

  it("a colliding generated id is drawn again", async () => {
    const ids = ["r_aaaaa", "r_aaaaa", "r_bbbbb"];
    const s = store({ newId: () => ids.shift()! });
    expect((await s.add({ ...base, text: "First.", state: "candidate" })).rule.id).toBe("r_aaaaa");
    expect((await s.add({ ...base, text: "Second.", state: "candidate" })).rule.id).toBe("r_bbbbb");
  });

  it("the first add creates brain/ with mode 0700 and the file with mode 0600", async () => {
    await store().add({ ...base, text: "First rule.", state: "candidate" });
    expect(statSync(dirname(rf)).mode & 0o777).toBe(0o700);
    expect(statSync(rf).mode & 0o777).toBe(0o600);
  });

  it("mtimeMs is 0 without a file and the file mtime after a write", async () => {
    const s = store();
    expect(await s.mtimeMs()).toBe(0);
    await s.add({ ...base, text: "Touch.", state: "candidate" });
    expect(await s.mtimeMs()).toBe(statSync(rf).mtimeMs);
  });

  it("Review Focus 2: an add after a torn last line starts a new line and folds", async () => {
    mkdirSync(dirname(rf), { recursive: true });
    writeFileSync(rf, jsonl([add]) + '{"ev":"add","id":"r_');
    const s = store();
    const { rule, duplicate } = await s.add({ ...base, text: "After the crash.", state: "active" });
    expect(duplicate).toBe(false);
    const raw = readFileSync(rf, "utf8").split("\n");
    expect(raw[1]).toBe('{"ev":"add","id":"r_');
    expect((await s.all()).map((r) => r.id)).toEqual([ID, rule.id]);
    expect(await s.get(rule.id)).toMatchObject({ text: "After the crash.", state: "active" });
    expect(foldRules(await readJsonl<RuleEvent>(rf)).get(rule.id)).toEqual(rule);
  });

  it("a malformed add line does not break dedup or a later add", async () => {
    mkdirSync(dirname(rf), { recursive: true });
    writeFileSync(rf, JSON.stringify({ ...add, id: "r_bad01", text: 42 }) + "\n" + JSON.stringify({ ev: "add", id: "r_bad02" }) + "\n");
    const s = store();
    expect(await s.findDuplicate("Normal rule.")).toBeNull();
    const { rule, duplicate } = await s.add({ ...base, text: "Normal rule.", state: "candidate" });
    expect(duplicate).toBe(false);
    expect((await s.all()).map((r) => r.id)).toEqual([rule.id]);
  });
});
