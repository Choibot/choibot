import { describe, expect, it } from "vitest";
import {
  DISTILL_MAX_CANDIDATES, DISTILL_MAX_LINES, DISTILL_MAX_RULES, DISTILL_WINDOW_MS, collectInputs, collectInputsWithDrops, validateDistill,
} from "./distill.js";
import { DECISION_TEXT_MAX, type ClassifiedEntry, type DecisionLine, type Rule, type RuleOrigin, type RuleScope } from "./store.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 10, 9, 3, 30, 0);
// Agent text. It must never reach the distiller's stdin.
const MARK = "AGENTTEXT_q7k2m9";

function rule(p: Partial<Rule> & { id: string }): Rule {
  return { text: `rule ${p.id}`, scope: { area: "*" }, kind: "preference", source: { origin: "user-line" },
    state: "active", confidence: 0.9, hits: 0, strikes: 0, createdAt: NOW - DAY, ...p };
}
const user = (at: number, p: Partial<DecisionLine> = {}): DecisionLine =>
  ({ at, via: "composer", by: "user", text: `user line ${at}`, correction: null, ...p });
const master = (at: number, p: Partial<DecisionLine> = {}): DecisionLine =>
  ({ at, via: "master-tab", by: "master", text: `master line ${at}`, correction: null, reason: "master-chat", ...p });
const distilled = (at: number, correction = false): ClassifiedEntry => ({ at, correction, by: "distill", runAt: NOW - DAY });

type Opts = Parameters<typeof collectInputs>[0];
const collect = (o: Partial<Opts>) => collectInputs({ brain: "", rules: [], lines: [], classified: [], now: NOW, ...o });
const ats = (o: Partial<Opts>) => collect(o).decisions.map((d) => d.at);

describe("collectInputs (spec §6.3 step 1)", () => {
  it("constants", () => {
    expect(DISTILL_MAX_LINES).toBe(300);
    expect(DISTILL_WINDOW_MS).toBe(7 * DAY);
  });

  it("passes the applied brain through", () => {
    const brain = "# Brain (2026-11-08)\n\n## Always\n- Use pnpm [r_aaaaa]\n";
    expect(collect({ brain }).brain).toBe(brain);
  });

  it("never sends a by: \"master\" line, not even an unclassified one", () => {
    const lines = [user(NOW - 3 * MIN), master(NOW - 2 * MIN), master(NOW - MIN, { correction: true })];
    const out = collect({ lines });
    expect(out.decisions.map((d) => d.at)).toEqual([NOW - 3 * MIN]);
    expect(JSON.stringify(out)).not.toContain("master line");
  });

  it("sends only by: \"user\" lines (a line with no or another by is out)", () => {
    const lines = [user(NOW - MIN), { ...user(NOW - 2 * MIN), by: undefined }, { ...user(NOW - 3 * MIN), by: "agent" }] as DecisionLine[];
    expect(ats({ lines })).toEqual([NOW - MIN]);
  });

  it("candidates: only state candidate with origin user-line", () => {
    const origins: RuleOrigin[] = ["user-line", "memory", "master", "distill", "panel"];
    const rules = origins.map((origin, i) => rule({ id: `r_cand${i}`, text: `candidate ${origin}`, state: "candidate", source: { origin } }));
    rules.push(rule({ id: "r_act00", text: "active user-line", source: { origin: "user-line" } }));
    rules.push(rule({ id: "r_ret00", text: "retired user-line", state: "retired", source: { origin: "user-line" } }));
    const out = collect({ rules });
    expect(out.candidates).toStrictEqual([{ id: "r_cand0", text: "candidate user-line", scope: { area: "*" }, kind: "preference" }]);
    for (const o of ["memory", "master", "distill", "panel"]) expect(JSON.stringify(out)).not.toContain(`candidate ${o}`);
  });

  it("rules: active only, whatever the origin, as {id, text, scope, kind, hits, strikes}", () => {
    const rules = [
      rule({ id: "r_act01", text: "use pnpm", scope: { area: "choibot", repo: "choibot", kind: "pr", audience: "workers" },
        kind: "correction", hits: 3, strikes: 1, source: { origin: "memory", memoryFile: "/m/feedback.md" },
        latestConfirm: { seq: 2, at: NOW - DAY, via: "tab" }, latestEditSeq: 1 }),
      rule({ id: "r_act02", text: "short replies", source: { origin: "master", agentId: "a1" } }),
      rule({ id: "r_can01", text: "a candidate", state: "candidate" }),
      rule({ id: "r_ret01", text: "a retired rule", state: "retired" }),
    ];
    const out = collect({ rules });
    expect(out.rules).toStrictEqual([
      { id: "r_act01", text: "use pnpm", scope: { area: "choibot", repo: "choibot", kind: "pr", audience: "workers" },
        kind: "correction", hits: 3, strikes: 1 },
      { id: "r_act02", text: "short replies", scope: { area: "*" }, kind: "preference", hits: 0, strikes: 0 },
    ]);
    expect(out.rules[0].scope).not.toBe(rules[0].scope);
  });

  it("lines older than 7 days are out", () => {
    const lines = [user(NOW - 7 * DAY - 1), user(NOW - 7 * DAY), user(NOW - DAY), user(NOW - 30 * DAY, { correction: true })];
    expect(ats({ lines })).toEqual([NOW - DAY, NOW - 7 * DAY]);
  });

  it("copies only the named decision fields", () => {
    const line = user(NOW - MIN, { via: "queue-tab", text: "ship it", correction: false, itemId: "q7k2m9x1a", agentId: "a1",
      repo: "choibot", area: "choibot", prUrl: "https://github.com/o/r/pull/1", value: "approve",
      recommend: { value: "changes", ruleIds: ["r_act01"] }, reason: "differs-from-recommend" });
    const [d] = collect({ lines: [line] }).decisions;
    expect(d).toStrictEqual({ at: NOW - MIN, via: "queue-tab", itemId: "q7k2m9x1a", agentId: "a1", repo: "choibot",
      area: "choibot", value: "approve", text: "ship it", recommend: { value: "changes", ruleIds: ["r_act01"] },
      correction: false, reason: "differs-from-recommend" });
    expect(d.recommend).not.toBe(line.recommend);
    expect(d.recommend!.ruleIds).not.toBe(line.recommend!.ruleIds);
  });

  it("drops ill-typed fields and skips a line with no string text or an unknown via", () => {
    const lines = [
      { ...user(NOW - MIN), itemId: { t: "x" }, repo: 7, recommend: { value: 1, ruleIds: [] }, reason: "made-up", correction: "yes" },
      { ...user(NOW - 2 * MIN), recommend: { value: "approve", ruleIds: ["r_a", 5, "r_ab12c"] } },
      { ...user(NOW - 3 * MIN), text: 42 },
      { ...user(NOW - 4 * MIN), via: "shell" },
    ] as unknown as DecisionLine[];
    expect(collect({ lines }).decisions).toStrictEqual([
      { at: NOW - MIN, via: "composer", text: `user line ${NOW - MIN}`, correction: null, classify: true },
      { at: NOW - 2 * MIN, via: "composer", text: `user line ${NOW - 2 * MIN}`, recommend: { value: "approve", ruleIds: ["r_ab12c"] },
        correction: null, classify: true },
    ]);
  });

  it("with 400 unclassified lines in 7 days: the newest 300, newest first, all classify: true", () => {
    const lines = Array.from({ length: 400 }, (_, i) => user(NOW - (400 - i) * MIN)); // file order: oldest first
    const out = collect({ lines });
    expect(out.decisions).toHaveLength(300);
    expect(out.decisions.map((d) => d.at)).toEqual(Array.from({ length: 300 }, (_, i) => NOW - (i + 1) * MIN));
    expect(out.decisions.every((d) => d.classify === true && d.correction === null)).toBe(true);
  });

  it("a second call with those 300 classified: the other 100 as classify: true first, then classified context", () => {
    const lines = Array.from({ length: 400 }, (_, i) => user(NOW - (400 - i) * MIN));
    const first = collect({ lines });
    const classified = first.decisions.map((d) => distilled(d.at, d.at % (2 * MIN) === 0));
    const out = collect({ lines, classified });
    expect(out.decisions).toHaveLength(300);
    const head = out.decisions.slice(0, 100);
    const tail = out.decisions.slice(100);
    expect(head.map((d) => d.at)).toEqual(Array.from({ length: 100 }, (_, i) => NOW - (301 + i) * MIN));
    expect(head.every((d) => d.classify === true)).toBe(true);
    expect(tail.map((d) => d.at)).toEqual(Array.from({ length: 200 }, (_, i) => NOW - (i + 1) * MIN));
    for (const d of tail) {
      expect(d).not.toHaveProperty("classify");
      expect(d.correction).toBe(d.at % (2 * MIN) === 0); // the classified value, not the raw null
    }
    // A third call: nothing is unclassified any more, so no line has classify.
    const all = [...classified, ...head.map((d) => distilled(d.at))];
    expect(collect({ lines, classified: all }).decisions.some((d) => d.classify)).toBe(false);
  });

  it("a line with a raw boolean correction is context, never classify", () => {
    const lines = [user(NOW - 3 * MIN, { correction: true }), user(NOW - 2 * MIN, { correction: false }), user(NOW - MIN)];
    const out = collect({ lines });
    expect(out.decisions.map((d) => [d.at, d.correction, d.classify])).toEqual([
      [NOW - MIN, null, true], [NOW - 2 * MIN, false, undefined], [NOW - 3 * MIN, true, undefined],
    ]);
  });

  it("a classified entry wins over the raw correction (latest entry per at)", () => {
    const lines = [user(NOW - MIN, { correction: false })];
    const classified: ClassifiedEntry[] = [distilled(NOW - MIN, false), { at: NOW - MIN, correction: true, by: "master-chat" }];
    expect(collect({ lines, classified }).decisions[0]).toMatchObject({ correction: true });
  });

  it("a line named by a master refAt is never classify: true (it is sent as context)", () => {
    const named = user(NOW - 10 * MIN, { via: "master-tab", text: "never offer to merge" });
    const lines = [named, master(NOW - 5 * MIN, { correction: true, refAt: named.at }), user(NOW - MIN)];
    const out = collect({ lines });
    expect(out.decisions.map((d) => [d.at, d.classify])).toEqual([[NOW - MIN, true], [named.at, undefined]]);
    expect(out.decisions[1].correction).toBeNull();
  });

  it("the refAt check sees master lines outside the 7 days and the cap", () => {
    const named = user(NOW - 7 * DAY + MIN, { via: "master-tab" });
    const lines = [named, master(NOW - 7 * DAY - MIN, { refAt: named.at, correction: true })];
    expect(collect({ lines }).decisions.map((d) => d.classify)).toEqual([undefined]);
  });

  it("max caps the lines; unclassified go first even when older", () => {
    const lines = [user(NOW - 5 * MIN), user(NOW - 4 * MIN, { correction: true }), user(NOW - 3 * MIN), user(NOW - 2 * MIN, { correction: false })];
    expect(ats({ lines, max: 3 })).toEqual([NOW - 3 * MIN, NOW - 5 * MIN, NOW - 2 * MIN]);
    expect(ats({ lines, max: 0 })).toEqual([]);
  });

  it("value and recommend.value only in the answer grammar (spec §5.1); ruleIds only rule ids", () => {
    const good = ["approve", "changes", "reply", "A", "B", "F"];
    const badValues = ["G", "a", "AB", "Approve", "approve ", " reply", "approve\nchanges", "", "merge it"];
    const lines = [...good, ...badValues].map((value, i) => user(NOW - (i + 1) * MIN, { value, recommend: { value, ruleIds: [] } }));
    const out = collect({ lines });
    for (const [i, d] of out.decisions.entries()) {
      if (i < good.length) expect([d.value, d.recommend]).toStrictEqual([good[i], { value: good[i], ruleIds: [] }]);
      else { expect(d).not.toHaveProperty("value"); expect(d).not.toHaveProperty("recommend"); }
    }
    const ids = ["r_ab12c", "r_AB12C", "r_ab12", "r_ab12cd", " r_ab12c", "r_ab12c ", "r_ab-2c", "r_00000"];
    const [d] = collect({ lines: [user(NOW - MIN, { recommend: { value: "C", ruleIds: ids } })] }).decisions;
    expect(d.recommend).toStrictEqual({ value: "C", ruleIds: ["r_ab12c", "r_00000"] });
  });

  it("a classified entry with a non-boolean correction is not copied (the raw value stays)", () => {
    const lines = [user(NOW - 2 * MIN, { correction: false }), user(NOW - MIN)];
    const classified = [{ at: NOW - 2 * MIN, correction: "yes", by: "distill" }, { at: NOW - MIN, correction: 1, by: "distill" }] as unknown as ClassifiedEntry[];
    expect(collect({ lines, classified }).decisions.map((d) => [d.at, d.correction])).toEqual([[NOW - MIN, null], [NOW - 2 * MIN, false]]);
  });

  it("cuts text to DECISION_TEXT_MAX and repo and area to 100 chars", () => {
    const long = "x".repeat(DECISION_TEXT_MAX + 200);
    const name = "n".repeat(150);
    const [d] = collect({ lines: [user(NOW - MIN, { text: long, repo: name, area: name })] }).decisions;
    expect(d.text).toBe(long.slice(0, DECISION_TEXT_MAX));
    expect(d.repo).toBe(name.slice(0, 100));
    expect(d.area).toBe(name.slice(0, 100));
    // A cut never splits a surrogate pair.
    const emoji = "a".repeat(DECISION_TEXT_MAX - 1) + "\u{1F600}b";
    expect(collect({ lines: [user(NOW - MIN, { text: emoji })] }).decisions[0].text).toBe("a".repeat(DECISION_TEXT_MAX - 1));
    // A stored text at the limit is sent whole.
    const exact = "y".repeat(DECISION_TEXT_MAX);
    expect(collect({ lines: [user(NOW - MIN, { text: exact })] }).decisions[0].text).toBe(exact);
  });

  it("the validator's quote check reads the same cut text the model was sent", () => {
    const text = "Always use pnpm. " + "filler ".repeat(80) + "Never offer to merge.";
    expect(text.length).toBeGreaterThan(DECISION_TEXT_MAX);
    const line = user(NOW - MIN, { text });
    const input = collect({ lines: [line] });
    expect(input.decisions[0].text).toBe(text.slice(0, DECISION_TEXT_MAX));
    const v = validateDistill({ candidates: [{ text: "Always use pnpm." }, { text: "Never offer to merge." }] }, { input, rules: [] });
    // The sentence the model saw is kept; the one past the cut was never sent, so it is dropped.
    expect(v.candidates).toStrictEqual([{ text: "Always use pnpm.", decisionAt: line.at }]);
    expect(v.droppedCandidates).toBe(1);
  });

  it("the stdin JSON never holds agent text, wherever it is seeded", () => {
    const xScope = { area: "*", note: MARK } as RuleScope;
    const rules: Rule[] = [
      // Active rules are user-confirmed: their text goes in, their source never.
      { ...rule({ id: "r_act01", text: "Use pnpm", scope: xScope,
        source: { origin: "memory", memoryFile: `/m/${MARK}.md`, agentId: MARK, prUrl: MARK, via: MARK, itemId: MARK } }),
        title: MARK } as Rule,
      rule({ id: "r_act02", text: "Short replies", source: { origin: "master", agentId: MARK, via: MARK } }),
      rule({ id: "r_act03", text: "Ask before deploy", source: { origin: "distill", decisionAt: NOW - DAY } }),
      rule({ id: "r_mem01", text: `memory ${MARK}`, state: "candidate", source: { origin: "memory", memoryFile: `/m/${MARK}.md` } }),
      rule({ id: "r_mas01", text: `master ${MARK}`, state: "candidate", source: { origin: "master", agentId: MARK } }),
      rule({ id: "r_dis01", text: `distill ${MARK}`, state: "candidate", source: { origin: "distill", decisionAt: NOW - MIN } }),
      rule({ id: "r_pan01", text: `panel ${MARK}`, state: "candidate", source: { origin: "panel" } }),
      rule({ id: "r_ret01", text: `retired ${MARK}`, state: "retired" }),
      rule({ id: "r_usr01", text: "Never offer to merge", state: "candidate", scope: xScope,
        source: { origin: "user-line", via: MARK, agentId: MARK, itemId: MARK, prUrl: MARK } }),
    ];
    const lines = [
      user(NOW - 9 * MIN, { text: "I merge myself", via: "master-tab" }),
      master(NOW - 8 * MIN, { text: `Never offer to merge ${MARK}`, refAt: NOW - 9 * MIN, correction: true, agentId: MARK, prUrl: MARK }),
      master(NOW - 7 * MIN, { text: `merge PR 12 ${MARK}`, correction: null }),
      { ...user(NOW - 6 * MIN, { text: "approve", value: "approve", prUrl: `https://github.com/o/${MARK}/pull/1`,
        recommend: { value: "approve", ruleIds: ["r_act01"], why: MARK, by: MARK } as DecisionLine["recommend"] }),
        title: MARK, body: MARK, turnEnd: MARK, options: [{ label: MARK }] },
      { ...user(NOW - 5 * MIN, { text: "keep it short", value: MARK, recommend: { value: "approve", ruleIds: ["r_act01", MARK] } }),
        itemId: { title: MARK }, area: [MARK] },
      user(NOW - 10 * MIN, { text: "go ahead", correction: false, value: `approve ${MARK}`, recommend: { value: MARK, ruleIds: ["r_act01"] } }),
      { ...user(NOW - 4 * MIN), by: undefined, text: `no by ${MARK}` },
      { ...user(NOW - 3 * MIN), by: "agent", text: `agent by ${MARK}` },
      { ...user(NOW - 2 * MIN), text: { body: MARK } },
      user(NOW - 8 * DAY, { text: `old ${MARK}`, correction: true }),
    ] as unknown as DecisionLine[];
    const classified = [{ ...distilled(NOW - 6 * MIN), note: MARK }] as unknown as ClassifiedEntry[];
    const brain = "# Brain (2026-11-08)\n\n## Always\n- Use pnpm [r_act01]\n";
    const input = collectInputs({ brain, rules, lines, classified, now: NOW });
    const stdin = JSON.stringify(input);
    expect(stdin).not.toContain(MARK);
    // Not vacuous: the user's own words and the user-confirmed rules are there.
    for (const s of ["I merge myself", "keep it short", "go ahead", "Use pnpm", "Short replies", "Ask before deploy", "Never offer to merge"]) {
      expect(stdin).toContain(s);
    }
    expect(input.rules.map((r) => r.id)).toEqual(["r_act01", "r_act02", "r_act03"]);
    expect(input.candidates.map((c) => c.id)).toEqual(["r_usr01"]);
    expect(input.decisions.map((d) => d.at)).toEqual([NOW - 5 * MIN, NOW - 6 * MIN, NOW - 9 * MIN, NOW - 10 * MIN]);
  });
});

describe("collectInputs caps (rules and candidates)", () => {
  const rid = (i: number) => `r_${String(i).padStart(5, "0")}`;
  const many = (n: number, p: (i: number) => Partial<Rule>) => Array.from({ length: n }, (_, i) => rule({ id: rid(i), ...p(i) }));

  it("constants", () => {
    expect(DISTILL_MAX_RULES).toBe(200);
    expect(DISTILL_MAX_CANDIDATES).toBe(100);
  });

  it("250 active rules: the 200 newest, newest first", () => {
    const rules = many(250, (i) => ({ createdAt: NOW - 1000 * DAY + i * MIN }));   // higher i = newer
    const { input, dropped } = collectInputsWithDrops({ brain: "", rules, lines: [], classified: [], now: NOW });
    expect(input.rules).toHaveLength(200);
    expect(input.rules.map((r) => r.id)).toEqual(Array.from({ length: 200 }, (_, k) => rid(249 - k)));
    expect(dropped).toEqual({ decisions: 0, rules: 50, candidates: 0 });
  });

  it("a rule's age is its latest confirm when it has one, else createdAt; ties by createdAt desc, then id", () => {
    const cf = (at: number) => ({ seq: 1, at, via: "tab" as const });
    const rules = [
      rule({ id: "r_aaaaa", createdAt: NOW - 5 * MIN }),
      rule({ id: "r_bbbbb", createdAt: NOW - 100 * MIN, latestConfirm: cf(NOW - MIN) }),
      rule({ id: "r_ccccc", createdAt: NOW - 3 * MIN, latestConfirm: cf(NOW - 5 * MIN) }),
      rule({ id: "r_ddddd", createdAt: NOW - 5 * MIN }),
    ];
    // bbbbb (confirm -1m); then the -5m group: ccccc (createdAt -3m), then aaaaa before ddddd (id).
    expect(collect({ rules }).rules.map((r) => r.id)).toEqual(["r_bbbbb", "r_ccccc", "r_aaaaa", "r_ddddd"]);
  });

  it("150 user-line candidates: the 100 newest, newest first, ties by id", () => {
    const rules = many(150, (i) => ({ state: "candidate", createdAt: NOW - 1000 * DAY + i * MIN }));
    const { input, dropped } = collectInputsWithDrops({ brain: "", rules, lines: [], classified: [], now: NOW });
    expect(input.candidates.map((c) => c.id)).toEqual(Array.from({ length: 100 }, (_, k) => rid(149 - k)));
    expect(dropped.candidates).toBe(50);
    const tie = [rule({ id: "r_zzzzz", state: "candidate" }), rule({ id: "r_aaaaa", state: "candidate" })];
    expect(collect({ rules: tie }).candidates.map((c) => c.id)).toEqual(["r_aaaaa", "r_zzzzz"]);
  });

  it("non-user-line candidates are excluded before the cap", () => {
    const rules = [
      ...many(100, (i) => ({ state: "candidate", createdAt: NOW - 1000 * DAY + i * MIN })),
      ...Array.from({ length: 20 }, (_, i) => rule({ id: `r_memo${i}`, state: "candidate", source: { origin: "memory" }, createdAt: NOW - i })),
    ];
    const { input, dropped } = collectInputsWithDrops({ brain: "", rules, lines: [], classified: [], now: NOW });
    expect(input.candidates).toHaveLength(100);
    expect(input.candidates.every((c) => c.id.startsWith("r_0"))).toBe(true);
    expect(dropped.candidates).toBe(0);
  });

  it("350 user lines: 300 kept, 50 dropped; nothing cut reports 0/0/0", () => {
    const lines = Array.from({ length: 350 }, (_, i) => user(NOW - (i + 1) * MIN));
    const { input, dropped } = collectInputsWithDrops({ brain: "", rules: [], lines, classified: [], now: NOW });
    expect(input.decisions).toHaveLength(300);
    expect(dropped).toEqual({ decisions: 50, rules: 0, candidates: 0 });
    expect(collectInputsWithDrops({ brain: "", rules: [], lines: lines.slice(0, 3), classified: [], now: NOW }).dropped)
      .toEqual({ decisions: 0, rules: 0, candidates: 0 });
  });

  it("the stdin shape has no dropped field", () => {
    const { input } = collectInputsWithDrops({ brain: "", rules: [], lines: [], classified: [], now: NOW });
    expect(Object.keys(input).sort()).toEqual(["brain", "candidates", "decisions", "rules"]);
  });

  it("the validator still accepts a cited active rule outside the capped 200", () => {
    const rules = many(250, (i) => ({ createdAt: NOW - 1000 * DAY + i * MIN }));
    const input = collect({ rules });
    expect(input.rules.map((r) => r.id)).not.toContain(rid(0));
    const brain = `# Brain (2026-11-09)\n\n## Always\n- Use pnpm, never npm. [${rid(0)}]\n`;
    const v = validateDistill({ brain, retire: [], candidates: [], corrections: [] }, { input, rules });
    expect(v.brain).toMatchObject({ ok: true });
  });
});
