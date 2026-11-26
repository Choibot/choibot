// The "Make this a rule?" items (pick A "Quiet rules", 2026-11-19): the suggester's limits and
// its reconcile, the Yes / No / Edit answers, and that only a USER answer makes a rule active.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import { CONSOLE_AGENT_ID } from "../deploy/ticket.js";
import { get, harness, ok, ruleEvents, type Harness } from "../queue/actions.fixture.js";
import { QueueActions, RULE_CHANGED } from "../queue/actions.js";
import { AuditLog, AutoAnswer } from "../queue/auto.js";
import { Deliverer } from "../queue/deliver.js";
import { parseAddInput } from "../queue/schema.js";
import { isAgentItem, type QueueItem } from "../queue/types.js";
import { OPEN_MAX, RuleSuggester, SUGGEST_TITLE, WEEK_MAX } from "./suggest.js";
import type { Rule } from "./store.js";

let root: string;
let clock: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chief-suggest-"));
  clock = 9_000_000_000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const DAY = 24 * 60 * 60_000;
const MASTER: Caller = { level: "master", agentHeaders: true, agentId: FLEET_MASTER_ID, kind: "fleet-master" };
const LEAD: Caller = { level: "lead", agentHeaders: true, agentId: "lead-1", kind: "lead" };
const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };

// The suggester's first run at time 0 (o.firstRun false: it has never run).
function setup(o: { firstRun?: boolean } = {}) {
  const h = harness(root, () => clock);
  if (o.firstRun !== false) {
    mkdirSync(join(root, "brain"), { recursive: true });
    writeFileSync(join(root, "brain", "suggest.json"), JSON.stringify({ since: 0 }));
  }
  let answered = 0;
  const actions = new QueueActions({
    store: h.store, rules: h.rules, decisions: h.decisions, agents: { load: async () => null },
    deliverer: h.kicker, inbox: { cancel: () => "absent" }, audit: h.audit, undoMs: 600_000,
    mergeState: async () => ({ state: "not-merged", detail: "open" }), onRuleAnswered: () => { answered += 1; },
    now: () => clock, log: h.log,
  });
  const suggester = new RuleSuggester({ rules: h.rules, store: h.store, stateFile: join(root, "brain", "suggest.json"), now: () => clock, log: h.log });
  return { ...h, actions, suggester, answered: () => answered };
}
type F = ReturnType<typeof setup>;

async function candidate(h: Harness, text: string, source: Rule["source"] = { origin: "master" }): Promise<string> {
  clock += 1;
  const { rule } = await h.rules.add({ text, state: "candidate", kind: "preference", scope: { area: "*" }, source });
  return rule.id;
}
const suggestions = async (f: F): Promise<QueueItem[]> => (await f.store.list()).filter((i) => i.rule !== undefined);
const open = async (f: F): Promise<QueueItem[]> => (await suggestions(f)).filter((i) => i.status === "open");

describe("RuleSuggester", () => {
  it("makes one choice item per candidate, oldest first, at most OPEN_MAX open", async () => {
    const f = setup();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await candidate(f, `Always run test suite ${n}`));
    await f.suggester.sync();
    const items = await open(f);
    expect(OPEN_MAX).toBe(3);
    // The three oldest (items made in one sync share createdAt, so the list order is not theirs).
    expect(items.map((i) => i.rule!.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(items.find((i) => i.rule!.id === ids[0])).toMatchObject({
      kind: "choice", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
      title: SUGGEST_TITLE, body: "Always run test suite 0\n\nFrom: the fleet master, after your chat.", blocking: false,
      choice: { options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] },
    });
    // A second sync adds nothing: the open limit holds, and no candidate is asked twice.
    await f.suggester.sync();
    expect(await suggestions(f)).toHaveLength(3);
  });

  it("an older candidate waits until the triage keeps it (an edit); a newer one is asked at once", async () => {
    const f = setup({ firstRun: false });
    const old = await candidate(f, "Always squash small PRs");
    clock += 1;
    await f.suggester.sync();   // the first run: its time is the cut
    expect(await suggestions(f)).toEqual([]);
    const fresh = await candidate(f, "Never push to main directly");
    await f.suggester.sync();
    expect((await open(f)).map((i) => i.rule!.id)).toEqual([fresh]);
    await f.rules.update(old, { text: "Always squash small PRs" });
    await f.suggester.sync();
    expect((await open(f)).map((i) => i.rule!.id).sort()).toEqual([fresh, old].sort());
    // A restart keeps the cut.
    const again = new RuleSuggester({ rules: f.rules, store: f.store, stateFile: join(root, "brain", "suggest.json"), now: () => clock + DAY });
    await again.sync();
    expect(await suggestions(f)).toHaveLength(2);
  });

  it("names the source in one line", async () => {
    const f = setup();
    await candidate(f, "Use pnpm for every install", { origin: "user-line", via: "composer" });
    await candidate(f, "Never squash a PR", { origin: "distill", decisionAt: 1 });
    await candidate(f, "Keep a short PR title", { origin: "user-line", via: "queue-tab" });
    await f.suggester.sync();
    expect((await open(f)).map((i) => i.body.split("\n").at(-1)).sort()).toEqual([
      "From: the nightly review of your answers.",
      "From: your answer to a queue item.",
      "From: your line that starts with \"rule:\".",
    ]);
  });

  it("says who the rule is for when it is not every agent", async () => {
    const f = setup();
    clock += 1;
    await f.rules.add({ text: "Never squash a PR", state: "candidate", kind: "correction", scope: { area: "app-shop", repo: "app-shop", kind: "choice", audience: "all" }, source: { origin: "master" } });
    clock += 1;
    await f.rules.add({ text: "Always ask before a deploy", state: "candidate", kind: "preference", scope: { area: "*", audience: "master" }, source: { origin: "master" } });
    await f.suggester.sync();
    expect((await open(f)).map((i) => i.body.split("\n").at(-1)).sort()).toEqual([
      "From: the fleet master, after your chat. For area app-shop only.",
      "From: the fleet master, after your chat. For the master and the leads only.",
    ]);
  });

  it("makes at most WEEK_MAX items in 7 days; the rest wait", async () => {
    const f = setup();
    for (let n = 0; n < 9; n++) await candidate(f, `Always check case number ${n}`);
    let made = 0;
    for (let round = 0; round < 4; round++) {
      await f.suggester.sync();
      for (const i of await open(f)) { ok(await f.actions.answerUser(i.id, { value: "A" }, "tab")); made += 1; }
    }
    expect(WEEK_MAX).toBe(5);
    expect(made).toBe(5);
    clock += 7 * DAY + 1;
    await f.suggester.sync();
    expect(await open(f)).toHaveLength(3);
  });

  it("withdraws an open item whose rule was confirmed or retired elsewhere", async () => {
    const f = setup();
    const a = await candidate(f, "Always write tests first");
    const b = await candidate(f, "Never push to main directly");
    await f.suggester.sync();
    await f.rules.confirm(a, { via: "cli" });
    await f.rules.retire(b, { by: "user", why: "x" });
    await f.suggester.sync();
    const items = await suggestions(f);
    expect(items.map((i) => [i.status, i.lastError])).toEqual([["withdrawn", RULE_CHANGED], ["withdrawn", RULE_CHANGED]]);
    expect((await f.rules.get(a))!.state).toBe("active");
  });

  it("a candidate whose item the user withdrew is retired (dismissed), and never asked again", async () => {
    const f = setup();
    const a = await candidate(f, "Always write tests first");
    await f.suggester.sync();
    const [item] = await open(f);
    ok(await f.actions.withdraw(item!.id, USER));
    await f.suggester.sync();
    expect(await f.rules.get(a)).toMatchObject({ state: "retired" });
    expect((await ruleEvents(f)).at(-1)).toMatchObject({ ev: "retire", by: "user", why: "dismissed in the queue" });
    expect(await suggestions(f)).toHaveLength(1);
  });
});

describe("answering a rule suggestion (USER)", () => {
  async function one(f: F, text = "Always run the test suite"): Promise<{ ruleId: string; itemId: string }> {
    const ruleId = await candidate(f, text);
    await f.suggester.sync();
    const item = (await open(f)).find((i) => i.rule!.id === ruleId)!;
    f.kicks.length = 0;
    return { ruleId, itemId: item.id };
  }

  it("Yes confirms the rule (same strength as the panel's Confirm) and closes the item; no kick, no decision line", async () => {
    const f = setup();
    const { ruleId, itemId } = await one(f);
    const item = ok(await f.actions.answerUser(itemId, { value: "A" }, "telegram"));
    expect(item).toMatchObject({ status: "answered", answer: { value: "A", by: "user", via: "telegram" }, closedAt: clock });
    expect(await f.rules.get(ruleId)).toMatchObject({ state: "active", latestConfirm: { via: "telegram" } });
    expect((await ruleEvents(f)).at(-1)).toMatchObject({ ev: "confirm", id: ruleId, by: "user", via: "telegram" });
    expect(f.kicks).toEqual([]);
    expect(await f.decisions.read()).toEqual([]);
    expect(f.answered()).toBe(1);
    // A closed item takes no undo and no second answer.
    expect((await f.actions.undo(itemId, USER)).code).toBe(409);
    expect((await f.actions.answerUser(itemId, { value: "B" }, "tab")).code).toBe(409);
  });

  it("No retires the rule", async () => {
    const f = setup();
    const { ruleId, itemId } = await one(f);
    ok(await f.actions.answerUser(itemId, { value: "B" }, "tab"));
    expect(await f.rules.get(ruleId)).toMatchObject({ state: "retired" });
  });

  it("a reply (Edit) becomes the rule text, redacted and cut to 200, and confirms it", async () => {
    const f = setup();
    const { ruleId, itemId } = await one(f);
    const text = `Run the tests with pnpm; key sk-abcdefghijklmnopqrstuv${" more".repeat(60)}`;
    ok(await f.actions.answerUser(itemId, { value: "reply", text }, "tab"));
    const r = (await f.rules.get(ruleId))!;
    expect(r.state).toBe("active");
    expect(r.text.length).toBeLessThanOrEqual(200);
    expect(r.text).toMatch(/^Run the tests with pnpm; key \[redacted\]/);
    expect((await f.actions.answerUser((await one(f, "Never skip CI")).itemId, { value: "reply", text: "  " }, "tab")).code).toBe(400);
  });

  it("a rule confirmed elsewhere since: 409, the item closes, nothing is written to the rule", async () => {
    const f = setup();
    const { ruleId, itemId } = await one(f);
    await f.rules.confirm(ruleId, { via: "cli" });
    const before = (await ruleEvents(f)).length;
    const r = await f.actions.answerUser(itemId, { value: "B" }, "tab");
    expect(r.code).toBe(409);
    expect(await get(f, itemId)).toMatchObject({ status: "withdrawn", lastError: RULE_CHANGED });
    expect(await ruleEvents(f)).toHaveLength(before);
    expect((await f.rules.get(ruleId))!.state).toBe("active");
  });
});

describe("only a USER answer makes a suggested rule active", () => {
  it("is not an agent item: the master and a lead cannot recommend on it", async () => {
    const f = setup();
    const ruleId = await candidate(f, "Always run the test suite");
    await f.suggester.sync();
    const [item] = await open(f);
    expect(isAgentItem(item!)).toBe(false);
    for (const caller of [MASTER, LEAD]) {
      const r = await f.actions.recommend(item!.id, { value: "A", why: "x", ruleIds: [ruleId] }, caller);
      expect(r.code).toBeGreaterThanOrEqual(400);
    }
    expect((await get(f, item!.id)).recommend).toBeUndefined();
    expect((await f.rules.get(ruleId))!.state).toBe("candidate");
  });

  it("the master's auto answer is refused and writes nothing", async () => {
    const f = setup();
    const ruleId = await candidate(f, "Always run the test suite");
    const { rule: active } = await f.rules.add({ text: "Prefer yes", state: "active", kind: "decision", scope: { area: "*" }, source: { origin: "panel" } });
    await f.suggester.sync();
    const [item] = await open(f);
    const auto = new AutoAnswer({
      store: f.store, rules: f.rules, agents: { load: async () => null }, audit: new AuditLog(join(root, "audit2.jsonl")),
      deliverer: f.kicker, mode: () => "weak", threshold: 0.5, undoMs: 600_000, onAuto: () => {}, now: () => clock, log: f.log,
    });
    const r = await auto.apply(item!.id, { value: "A", auto: true, ruleIds: [active.id], confidence: 0.99 }, MASTER);
    expect(r.code).toBe(409);
    expect(await get(f, item!.id)).toMatchObject({ status: "open" });
    expect((await f.rules.get(ruleId))!.state).toBe("candidate");
  });

  it("an agent cannot add an item that carries a rule id", () => {
    const v = parseAddInput({ kind: "choice", title: "Make this a rule?", body: "x", rule: { id: "r_abcde" },
      options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] }, { previewEnabled: true });
    expect(v.ok && "rule" in v.value).toBe(false);
  });

  it("the Deliverer's scan never withdraws it as agent-gone", async () => {
    const f = setup();
    await candidate(f, "Always run the test suite");
    await f.suggester.sync();
    const [item] = await open(f);
    const deliverer = new Deliverer({
      store: f.store, agents: { load: async () => null, exists: async () => false },
      composer: { inputInternal: async () => ({ ok: true }) } as never, inbox: { pushConsole: () => { throw new Error("no"); } } as never,
      rules: f.rules, hub: { subscribe: () => () => {} }, now: () => clock, undoMs: 600_000, log: f.log,
    });
    await deliverer.tick();
    expect(await get(f, item!.id)).toMatchObject({ status: "open" });
  });
});
