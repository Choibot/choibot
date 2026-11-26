// Task 2b-6: AutoAnswer.apply — the master's `answer --auto` (spec §5.6
// checks 1–10 and "On success", §15; overview decisions 31, 39, 40, 57).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../../agents/store.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import type { ConfirmVia, RuleScope } from "../brain/store.js";
import { readJsonl } from "../files.js";
import { chiefTunables } from "../paths.js";
import { get, harness, lines, patch, raw, reset, type Harness } from "./actions.fixture.js";
import { AUTO_HOLD_MS, AUTO_PER_HOUR, AuditLog, AutoAnswer, type AuditEntry } from "./auto.js";
import type { AuthMode } from "./eligibility.js";
import { formatAnswerLine } from "./lines.js";
import type { NewItem } from "./store.js";
import type { QueueItem } from "./types.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "chief-auto-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const NOW = 50_000_000;
const HOUR = 3_600_000;
const UNDO_MS = 600_000;
const MASTER: Caller = { level: "master", agentHeaders: true, agentId: FLEET_MASTER_ID, kind: "fleet-master" };
const WORKER: Caller = { level: "agent", agentHeaders: true, agentId: "a1", kind: "worker" };
const LEAD: Caller = { level: "lead", agentHeaders: true, agentId: "lead-1", kind: "lead" };
const USER: Caller = { level: "user", agentHeaders: false, device: "phone" };

const base = (agentId: string, createdBy: NewItem["createdBy"]["kind"] = "worker") => ({
  agentId, createdBy: { agentId, kind: createdBy }, repo: "app-shop", area: "app-shop", title: "Pick", body: "b", blocking: true,
});
const choice = (agentId = "a1", by?: NewItem["createdBy"]["kind"]): NewItem => ({ ...base(agentId, by), kind: "choice",
  choice: { options: [{ key: "A", label: "Hand-rolled" }, { key: "B", label: "Registry-driven" }] } });
const question = (agentId = "a1"): NewItem => ({ ...base(agentId), kind: "question" });
const prItem = (): NewItem => ({ ...base("a1"), kind: "pr", pr: { url: "https://github.com/o/app-shop/pull/7", number: 7 } });
const previewItem = (): NewItem => ({ ...base("a1"), kind: "preview", preview: { images: ["/m/1.png"] } });
const record = (id: string, kind?: string): AgentRecord => ({
  id, label: id, repo: "/r", worktree: "/w", branch: "b", baseBranch: "main",
  sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...(kind ? { kind: kind as AgentRecord["kind"] } : {}),
});
const RECS = [record("a1"), record("a2"), record(FLEET_MASTER_ID, "fleet-master"), record("lead-1", "lead"), record("agent-9", "lead")];

// An active rule; its latest confirm comes from `via` (tab = a direct USER add only).
async function addRule(h: Harness, text: string, via: ConfirmVia = "telegram", scope?: RuleScope): Promise<string> {
  const { rule } = await h.rules.add({ text, state: "active", kind: "decision", source: { origin: "panel" },
    scope: scope ?? { area: "app-shop", repo: "app-shop", audience: "all" } });
  if (via !== "tab") await h.rules.confirm(rule.id, { via });
  return rule.id;
}

let clock = NOW;
async function setup(o: { mode?: AuthMode; threshold?: number; recs?: AgentRecord[]; onAutoThrows?: boolean } = {}) {
  clock = NOW;
  const h = harness(root, () => clock);
  const map = new Map((o.recs ?? RECS).map((r) => [r.id, r]));
  const auditFile = join(root, "audit", "auto.jsonl");
  const audit = new AuditLog(auditFile);
  const autos: QueueItem[] = [];
  let mode: AuthMode = o.mode ?? "weak";
  const auto = new AutoAnswer({
    store: h.store, rules: h.rules, agents: { load: async (id) => map.get(id) ?? null }, audit, deliverer: h.kicker,
    mode: () => mode, threshold: o.threshold ?? 0.85, undoMs: UNDO_MS,
    onAuto: (item) => {
      h.steps.push({ what: "onAuto", held: -1 });
      autos.push(item);
      if (o.onAutoThrows) throw new Error("telegram down");
    },
    now: () => clock, log: h.log,
  });
  const tg = await addRule(h, "prefer the registry");
  reset(h);
  return { ...h, auto, audit, auditFile, autos, tg, setMode: (m: AuthMode) => { mode = m; } };
}
type F = Awaited<ReturnType<typeof setup>>;

const body = (f: F, o: Record<string, unknown> = {}) => ({ value: "B", auto: true, ruleIds: [f.tg], confidence: 0.9, ...o });
const auditLines = (f: F) => readJsonl<AuditEntry>(f.auditFile);
const auditEntry = (o: Partial<AuditEntry> = {}): AuditEntry => ({ at: NOW - 60_000, itemId: "q00000000", agentId: "a1", kind: "choice",
  value: "A", ruleIds: ["r_aaaaa"], confidence: 0.9, undoUntil: NOW, event: "auto", delivered: true, ...o });

// The item file did not change and no hub event, kick, onAuto or audit line followed.
async function nothingWritten(f: F, id: string, before: string): Promise<void> {
  expect(raw(f, id)).toBe(before);
  expect(f.changes).toEqual([]);
  expect(f.kicks).toEqual([]);
  expect(f.autos).toEqual([]);
  expect(existsSync(f.auditFile)).toBe(false);
}

describe("AutoAnswer.apply: check 1 (caller)", () => {
  it.each([["worker", WORKER], ["lead", LEAD], ["user", USER]] as const)("a %s caller → 403, nothing written", async (_n, caller) => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f), caller);
    expect(r.code).toBe(403);
    await nothingWritten(f, id, before);
  });
});

describe("AutoAnswer.apply: open, value and body checks", () => {
  it("a missing item → 404", async () => {
    const f = await setup();
    expect(await f.auto.apply("q00000000", body(f), MASTER)).toEqual({ code: 404, body: { error: "not found" } });
  });

  it("an answered item (the user was first) → 409 with the item; answer, recommend and audit unchanged", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, status: "answered", answerSeq: 1,
      recommend: { value: "A", why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 1 },
      answer: { value: "A", by: "user", via: "tab", at: NOW - 5 }, delivery: { msgId: `${id}-1`, state: "pending", attempts: 0 } }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r).toEqual({ code: 409, body: { error: "item is not open", item: await get(f, id) } });
    await nothingWritten(f, id, before);
  });

  it.each(["withdrawn", "snoozed", "auto", "undone"] as const)("a %s item → 409, nothing written", async (status) => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, status }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r.code).toBe(409);
    expect(r.code !== 200 && r.body.error).toBe("item is not open");
    await nothingWritten(f, id, before);
  });

  it("a choice value G → 400; reply on a choice → 400 (an auto value is an option key)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    const before = raw(f, id);
    reset(f);
    expect((await f.auto.apply(id, body(f, { value: "G" }), MASTER)).code).toBe(400);
    expect((await f.auto.apply(id, body(f, { value: "reply", text: "other thing" }), MASTER)).code).toBe(400);
    await nothingWritten(f, id, before);
  });

  it("the first three steps on a fleet-master item, in order: answered + value G → 409 (open first); open + value G → 400 (the value before check 9)", async () => {
    const f = await setup();
    const { id: answered } = await f.store.add(choice(FLEET_MASTER_ID, "fleet-master"));
    await patch(f, answered, (it) => ({ ...it, status: "answered", answerSeq: 1,
      answer: { value: "A", by: "user", via: "tab", at: NOW - 5 }, delivery: { msgId: `${answered}-1`, state: "pending", attempts: 0 } }));
    const before = raw(f, answered);
    expect(await f.auto.apply(answered, body(f, { value: "G" }), MASTER))
      .toEqual({ code: 409, body: { error: "item is not open", item: await get(f, answered) } });
    await nothingWritten(f, answered, before);
    const { id: open } = await f.store.add({ ...choice(FLEET_MASTER_ID, "fleet-master"), title: "Open" });
    const openBefore = raw(f, open);
    reset(f);
    expect(await f.auto.apply(open, body(f, { value: "G" }), MASTER))
      .toEqual({ code: 400, body: { error: "value must be an option key or reply" } });
    await nothingWritten(f, open, openBefore);
  });

  it("a question {value: B} without text → 400; reply without text → 400", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    await patch(f, id, (it) => ({ ...it, recommend: { value: "Use the registry.", why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 1 } }));
    const before = raw(f, id);
    expect((await f.auto.apply(id, body(f, { value: "B" }), MASTER)).code).toBe(400);
    expect((await f.auto.apply(id, body(f, { value: "reply" }), MASTER)).code).toBe(400);
    await nothingWritten(f, id, before);
  });

  it.each([
    ["no auto flag", { auto: undefined }], ["auto false", { auto: false }], ["no ruleIds", { ruleIds: [] }],
    ["six ruleIds", { ruleIds: ["r_aaaaa", "r_bbbbb", "r_ccccc", "r_ddddd", "r_eeeee", "r_fffff"] }],
    ["a bad rule id", { ruleIds: ["nope"] }], ["confidence 1.5", { confidence: 1.5 }], ["confidence -0.1", { confidence: -0.1 }],
    ["confidence as a string", { confidence: "0.9" }], ["no confidence", { confidence: undefined }],
  ])("a bad body (%s) → 400, nothing written", async (_n, o) => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    const before = raw(f, id);
    reset(f);
    expect((await f.auto.apply(id, body(f, o), MASTER)).code).toBe(400);
    await nothingWritten(f, id, before);
  });

  it("a body that is not an object → 400", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    expect((await f.auto.apply(id, "B", MASTER)).code).toBe(400);
    expect((await f.auto.apply(id, null, MASTER)).code).toBe(400);
  });
});

describe("AutoAnswer.apply: check 9 (the user answers a master's or a lead's item)", () => {
  it.each([
    ["fleet-master", () => choice(FLEET_MASTER_ID, "fleet-master")],
    ["a lead- id", () => choice("lead-1", "lead")],
    ["a lead record without the lead- prefix", () => choice("agent-9")],
    ["a lead that created the item for itself (record says worker)", () => choice("a2", "lead")],
    ["an agent whose record does not load (missing or torn)", () => choice("a-gone")],
    ["cron-master with no record", () => choice("cron-master")],
  ])("an item of %s → downgraded, nothing written", async (_n, mk) => {
    const f = await setup();
    const { id } = await f.store.add(mk());
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    expect(r.code === 200 && r.item).toEqual(await get(f, id));
    expect((await get(f, id)).recommend).toBeUndefined();
    await nothingWritten(f, id, before);
    expect(f.logs.some((l) => l.includes(id) && l.includes("the user answers this item"))).toBe(true);
  });

  it("runs before the others: a fleet-master choice citing a tab-confirmed rule in weak mode → no recommend", async () => {
    const f = await setup();
    const tab = await addRule(f, "tab rule", "tab");
    const { id } = await f.store.add(choice(FLEET_MASTER_ID, "fleet-master"));
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f, { ruleIds: [tab] }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    await nothingWritten(f, id, before);
  });

  it("runs before the others: a fleet-master question without recommend → no recommend", async () => {
    const f = await setup();
    const { id } = await f.store.add({ ...question(FLEET_MASTER_ID), createdBy: { agentId: FLEET_MASTER_ID, kind: "fleet-master" } });
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "Use the registry." }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    await nothingWritten(f, id, before);
  });

  // Task 3-9: a real lead record (id lead-<area>, an area), on the item it made for itself.
  it("a real lead's own item (lead-app-shop, area app-shop) → downgraded, nothing written", async () => {
    const f = await setup({ recs: [...RECS, { ...record("lead-app-shop", "lead"), area: "app-shop" }] });
    const { id } = await f.store.add(choice("lead-app-shop", "lead"));
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    await nothingWritten(f, id, before);
  });

  it("a lead record's choice with a failing check 5 → still no recommend", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice("agent-9"));
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f, { confidence: 0.1 }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    await nothingWritten(f, id, before);
  });
});

describe("AutoAnswer.apply: downgrades (checks 2–8, 10)", () => {
  it.each([["pr", prItem], ["preview", previewItem]] as const)("a %s item → downgraded (check 2), nothing written", async (_k, mk) => {
    const f = await setup();
    const { id } = await f.store.add(mk());
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f, { value: "approve" }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "pr and preview items are never auto-answered" });
    await nothingWritten(f, id, before);
  });

  it("a question without recommend → downgraded (check 3), nothing written", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    const before = raw(f, id);
    reset(f);
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "Use the registry." }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "a question needs a recommendation first" });
    await nothingWritten(f, id, before);
  });

  it("a choice without recommend: the downgrade writes recommend {value, why, known ruleIds, by, at} (check 7)", async () => {
    const f = await setup();
    const tab = await addRule(f, "tab rule", "tab");
    const { id } = await f.store.add(choice());
    reset(f);
    const r = await f.auto.apply(id, body(f, { ruleIds: [f.tg, tab] }), MASTER);
    const reason = `rule ${tab} was not confirmed on Telegram`;
    expect(r).toMatchObject({ code: 200, downgraded: reason });
    const item = await get(f, id);
    expect(item.recommend).toEqual({ value: "B", why: `auto refused: ${reason}`, ruleIds: [f.tg, tab], by: FLEET_MASTER_ID, at: NOW });
    expect(item).toMatchObject({ status: "open", answerSeq: 0 });
    expect(item.answer).toBeUndefined();
    expect(item.delivery).toBeUndefined();
    expect(r.code === 200 && r.item).toEqual(item);
    expect(f.kicks).toEqual([]);
    expect(f.autos).toEqual([]);
    expect(existsSync(f.auditFile)).toBe(false);
    expect(await lines(f)).toEqual([]);
    expect(f.logs.some((l) => l.includes(id) && l.includes(reason))).toBe(true);
  });

  it("a choice with a recommend (value B, as the auto) and a failing check → recommend byte-identical, downgraded set (decision 57)", async () => {
    const f = await setup();
    const tab = await addRule(f, "tab rule", "tab");
    const { id } = await f.store.add(choice());
    // The same value as the auto: another value fails decision 58 first.
    await patch(f, id, (it) => ({ ...it, recommend: { value: "B", why: "older", ruleIds: [tab], by: FLEET_MASTER_ID, at: 3 } }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f, { ruleIds: [tab] }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: `rule ${tab} was not confirmed on Telegram` });
    expect((await get(f, id)).recommend).toEqual({ value: "B", why: "older", ruleIds: [tab], by: FLEET_MASTER_ID, at: 3 });
    await nothingWritten(f, id, before);
  });

  it("request confidence 0.84 → downgraded (check 5)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    const r = await f.auto.apply(id, body(f, { confidence: 0.84 }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "request confidence < 0.85" });
    expect((await get(f, id)).status).toBe("open");
  });

  it("Review Focus 5: CHIEF_AUTO_THRESHOLD=abc behaves as 0.85 — a 0.5 request is downgraded", async () => {
    const threshold = chiefTunables({ CHIEF_AUTO_THRESHOLD: "abc" }).autoThreshold;
    const f = await setup({ threshold });
    const { id } = await f.store.add(choice());
    const r = await f.auto.apply(id, body(f, { confidence: 0.5 }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "request confidence < 0.85" });
    expect((await get(f, id)).status).toBe("open");
  });

  it.each([0, Number.NaN, 1.5])("a threshold of %s (out of (0, 1]) fails closed: even confidence 1 is downgraded", async (threshold) => {
    const f = await setup({ threshold });
    const { id } = await f.store.add(choice());
    const r = await f.auto.apply(id, body(f, { confidence: 1 }), MASTER);
    expect(r.code === 200 && r.downgraded).toMatch(/^request confidence < /);
    expect((await get(f, id)).status).toBe("open");
  });

  it("the 21st auto answer in an hour → downgraded (check 6); older and other events do not count", async () => {
    const f = await setup();
    for (let n = 0; n < AUTO_PER_HOUR - 1; n++) await f.audit.append(auditEntry({ at: NOW - HOUR + 1 + n }));
    await f.audit.append(auditEntry({ at: NOW - HOUR - 1 }));
    await f.audit.append(auditEntry({ event: "undone", at: NOW - 10 }));
    await f.audit.append(auditEntry({ event: "superseded", at: NOW - 10 }));
    const a = await f.store.add(choice());
    const b = await f.store.add({ ...choice(), title: "Second" });
    const first = await f.auto.apply(a.id, body(f), MASTER);
    expect(first).toMatchObject({ code: 200, item: { status: "auto" } });
    expect(first.code === 200 && first.downgraded).toBeUndefined();
    const second = await f.auto.apply(b.id, body(f), MASTER);
    expect(second).toMatchObject({ code: 200, downgraded: `breaker: ${AUTO_PER_HOUR} auto answers in the last hour` });
    expect((await get(f, b.id)).status).toBe("open");
    expect((await auditLines(f)).filter((e) => e.event === "auto")).toHaveLength(AUTO_PER_HOUR + 1);
    // The window rolls: an hour later the oldest lines leave it.
    clock = NOW + 30;
    const c = await f.store.add({ ...choice(), title: "Third" });
    expect(await f.auto.apply(c.id, body(f), MASTER)).toMatchObject({ code: 200, item: { status: "auto" } });
  });

  it("the breaker holds for two concurrent auto answers on two items: only one takes the 20th place", async () => {
    const f = await setup();
    for (let n = 0; n < AUTO_PER_HOUR - 1; n++) await f.audit.append(auditEntry({ at: NOW - 1_000 }));
    const a = await f.store.add(choice());
    const b = await f.store.add({ ...choice(), title: "Second" });
    const [ra, rb] = await Promise.all([f.auto.apply(a.id, body(f), MASTER), f.auto.apply(b.id, body(f), MASTER)]);
    const statuses = [(await get(f, a.id)).status, (await get(f, b.id)).status].sort();
    expect(statuses).toEqual(["auto", "open"]);
    expect([ra, rb].filter((r) => r.code === 200 && r.downgraded === `breaker: ${AUTO_PER_HOUR} auto answers in the last hour`)).toHaveLength(1);
    const loser = [await get(f, a.id), await get(f, b.id)].find((i) => i.status === "open")!;
    expect(loser.recommend?.why).toBe(`auto refused: breaker: ${AUTO_PER_HOUR} auto answers in the last hour`);
    expect((await auditLines(f)).filter((e) => e.event === "auto")).toHaveLength(AUTO_PER_HOUR);
    expect(f.autos).toHaveLength(1);
  });

  it("an item with a by: master answer in history → downgraded (check 8)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, answerSeq: 1, history: [{ value: "A", by: "master", via: "cli", at: 5, ruleIds: [f.tg], confidence: 0.9 }] }));
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "the item was auto-answered before" });
    const item = await get(f, id);
    expect(item.status).toBe("open");
    // An undone auto item can be recommended again (the downgrade's recommend).
    expect(item.recommend).toMatchObject({ value: "B", why: "auto refused: the item was auto-answered before" });
  });

  it("a user answer in history does not block", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, answerSeq: 1, history: [{ value: "A", by: "user", via: "tab", at: 5 }] }));
    expect(await f.auto.apply(id, body(f), MASTER)).toMatchObject({ code: 200, item: { status: "auto", answerSeq: 2 } });
  });

  it("check 10: a rule scoped to another area → downgraded", async () => {
    const f = await setup();
    const idx = await addRule(f, "indexer rule", "telegram", { area: "indexer", audience: "all" });
    const { id } = await f.store.add(choice());
    const r = await f.auto.apply(id, body(f, { ruleIds: [idx] }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: `rule ${idx} scope does not match` });
    expect((await get(f, id)).status).toBe("open");
  });

  it("an unknown rule id r_zzzzz → downgraded 'rule r_zzzzz does not exist'; the new recommend.ruleIds omits it", async () => {
    const f = await setup();
    const a = await f.store.add(choice());
    const r = await f.auto.apply(a.id, body(f, { ruleIds: [f.tg, "r_zzzzz"] }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "rule r_zzzzz does not exist" });
    expect((await get(f, a.id)).recommend).toMatchObject({ value: "B", ruleIds: [f.tg] });
    const b = await f.store.add({ ...choice(), title: "Second" });
    await f.auto.apply(b.id, body(f, { ruleIds: ["r_zzzzz"] }), MASTER);
    expect((await get(f, b.id)).recommend).toMatchObject({ value: "B", why: "auto refused: rule r_zzzzz does not exist", ruleIds: [] });
  });

  it("every cited rule is checked, in the cited order: the first failure wins", async () => {
    const f = await setup();
    const tab = await addRule(f, "tab rule", "tab");
    const idx = await addRule(f, "indexer rule", "telegram", { area: "indexer" });
    const { id } = await f.store.add(choice());
    const r = await f.auto.apply(id, body(f, { ruleIds: [f.tg, idx, tab] }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: `rule ${idx} scope does not match` });
  });

  it("log mode → downgraded, even with a Telegram-confirmed rule", async () => {
    const f = await setup({ mode: "log" });
    const { id } = await f.store.add(choice());
    expect(await f.auto.apply(id, body(f), MASTER)).toMatchObject({ code: 200, downgraded: "log mode: auto-answer off" });
    expect((await get(f, id)).status).toBe("open");
  });

  it("log mode is checked before the per-rule loop: with an unknown cited rule the reason is still log mode", async () => {
    const f = await setup({ mode: "log" });
    const { id } = await f.store.add(choice());
    expect(await f.auto.apply(id, body(f, { ruleIds: ["r_zzzzz"] }), MASTER)).toMatchObject({ code: 200, downgraded: "log mode: auto-answer off" });
    expect((await get(f, id)).status).toBe("open");
  });

  it("a question with recommend 'Use the registry.' and a failing check 5 keeps exactly that recommend (decision 40)", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    await patch(f, id, (it) => ({ ...it, recommend: { value: "Use the registry.", why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 2 } }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "Use the registry.", confidence: 0.6 }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: "request confidence < 0.85" });
    expect((await get(f, id)).recommend).toEqual({ value: "Use the registry.", why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 2 });
    await nothingWritten(f, id, before);
    expect(f.logs.some((l) => l.includes(id) && l.includes("request confidence < 0.85"))).toBe(true);
  });
});

describe("AutoAnswer.apply: an auto answer never differs from the shown recommendation (decision 58)", () => {
  const DIFFERS = "differs from the shown recommendation";
  const rec = (f: F, value: string) => ({ value, why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 2 });

  it("a choice with recommend A and an otherwise eligible auto B → downgraded; recommend stays A, nothing written", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "A") }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: DIFFERS });
    const item = await get(f, id);
    expect(r.code === 200 && r.item).toEqual(item);
    expect(item.recommend).toEqual(rec(f, "A"));
    expect(item).toMatchObject({ status: "open", answerSeq: 0 });
    expect(item.answer).toBeUndefined();
    expect(item.delivery).toBeUndefined();
    await nothingWritten(f, id, before);
    expect(await lines(f)).toEqual([]);
    expect(f.logs.some((l) => l.includes(id) && l.includes(DIFFERS))).toBe(true);
  });

  it("a question with recommend 'Ship it.' and auto text 'ship it later' → downgraded; recommend kept, nothing written", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "Ship it.") }));
    const before = raw(f, id);
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "ship it later" }), MASTER);
    expect(r).toMatchObject({ code: 200, downgraded: DIFFERS });
    expect((await get(f, id)).recommend).toEqual(rec(f, "Ship it."));
    await nothingWritten(f, id, before);
  });

  it("a question whose auto text normalizes to the recommend ('  ship   IT. ' for 'Ship it.') → auto", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "Ship it.") }));
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "  ship   IT. " }), MASTER);
    expect(r.code === 200 && r.downgraded).toBeUndefined();
    expect(await get(f, id)).toMatchObject({ status: "auto", answer: { value: "reply", text: "  ship   IT. ", by: "master" } });
    expect(await auditLines(f)).toHaveLength(1);
  });

  it("a choice whose auto value equals the recommend → auto", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "B") }));
    const r = await f.auto.apply(id, body(f), MASTER);
    expect(r.code === 200 && r.downgraded).toBeUndefined();
    expect(await get(f, id)).toMatchObject({ status: "auto", answer: { value: "B", by: "master" }, recommend: rec(f, "B") });
    expect(f.kicks).toEqual([id]);
  });

  it("hardened auth mode does not lift it", async () => {
    const f = await setup({ mode: "hardened" });
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "A") }));
    const before = raw(f, id);
    expect(await f.auto.apply(id, body(f), MASTER)).toMatchObject({ code: 200, downgraded: DIFFERS });
    await nothingWritten(f, id, before);
  });

  it("runs after the kind checks and before log mode and the per-rule checks", async () => {
    const f = await setup({ mode: "log" });
    const { id } = await f.store.add(choice());
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "A") }));
    expect(await f.auto.apply(id, body(f, { ruleIds: ["r_zzzzz"] }), MASTER)).toMatchObject({ code: 200, downgraded: DIFFERS });
    const { id: pr } = await f.store.add(prItem());
    await patch(f, pr, (it) => ({ ...it, recommend: rec(f, "changes") }));
    expect(await f.auto.apply(pr, body(f, { value: "approve" }), MASTER))
      .toMatchObject({ code: 200, downgraded: "pr and preview items are never auto-answered" });
  });

  it("check 9 still runs first: a fleet-master choice with recommend A and auto B → the user answers this item", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice(FLEET_MASTER_ID, "fleet-master"));
    await patch(f, id, (it) => ({ ...it, recommend: rec(f, "A") }));
    const before = raw(f, id);
    expect(await f.auto.apply(id, body(f), MASTER)).toMatchObject({ code: 200, downgraded: "the user answers this item" });
    await nothingWritten(f, id, before);
  });
});

describe("AutoAnswer.apply: success", () => {
  it("happy path: status auto, held 60 s, one audit line, onAuto after the lock, no decision line", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    reset(f);
    const r = await f.auto.apply(id, body(f, { text: "per\nthe rule" }), MASTER);
    expect(r.code === 200 && r.downgraded).toBeUndefined();
    const item = await get(f, id);
    expect(r.code === 200 && r.item).toEqual(item);
    expect(item).toMatchObject({
      status: "auto", answerSeq: 1,
      answer: { value: "B", text: "per\nthe rule", by: "master", via: "cli", at: NOW, ruleIds: [f.tg], confidence: 0.9 },
      delivery: { msgId: `${id}-1`, state: "held", deliverAfter: NOW + AUTO_HOLD_MS, attempts: 0 },
    });
    expect(AUTO_HOLD_MS).toBe(60_000);
    expect(item.recommend).toBeUndefined();
    expect(await auditLines(f)).toEqual([{ at: NOW, itemId: id, agentId: "a1", kind: "choice", value: "B", ruleIds: [f.tg],
      confidence: 0.9, undoUntil: NOW + UNDO_MS, event: "auto", delivered: false }]);
    expect(await lines(f)).toEqual([]);
    expect(f.autos).toEqual([item]);
    expect(f.kicks).toEqual([id]);
    // The write runs under the item lock; kick and onAuto after it.
    expect(f.steps).toEqual([{ what: "write", held: 1 }, { what: `kick ${id}`, held: 0 }, { what: "onAuto", held: -1 }]);
    // The delivered line is marked auto and stays one flat line.
    expect(formatAnswerLine(item, item.answer!)).toBe(`[queue ${id}] auto (rule ${f.tg}): choice: B (Registry-driven) — per the rule`);
  });

  it("the line of a plain choice reads [queue <id>] auto (rule r_…): choice: B (Registry-driven)", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    const item = (await f.auto.apply(id, body(f), MASTER)).code === 200 ? await get(f, id) : undefined;
    expect(formatAnswerLine(item!, item!.answer!)).toMatch(/^\[queue q[0-9a-z]{8}\] auto \(rule r_[0-9a-z]{5}\): choice: B \(Registry-driven\)$/);
  });

  it("a question with a recommend is auto-answered with the master's text", async () => {
    const f = await setup();
    const { id } = await f.store.add(question());
    await patch(f, id, (it) => ({ ...it, recommend: { value: "Use the registry.", why: "w", ruleIds: [f.tg], by: FLEET_MASTER_ID, at: 2 } }));
    const r = await f.auto.apply(id, body(f, { value: "reply", text: "Use the registry." }), MASTER);
    expect(r).toMatchObject({ code: 200, item: { status: "auto", answer: { value: "reply", text: "Use the registry.", by: "master" } } });
    const item = await get(f, id);
    expect(formatAnswerLine(item, item.answer!)).toBe(`[queue ${id}] auto (rule ${f.tg}): question: Use the registry.`);
  });

  it("hardened mode: a tab-confirmed rule qualifies", async () => {
    const f = await setup({ mode: "hardened" });
    const tab = await addRule(f, "tab rule", "tab");
    const { id } = await f.store.add(choice());
    expect(await f.auto.apply(id, body(f, { ruleIds: [tab] }), MASTER)).toMatchObject({ code: 200, item: { status: "auto" } });
  });

  it("duplicate cited ids are cited once", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await f.auto.apply(id, body(f, { ruleIds: [f.tg, f.tg] }), MASTER);
    expect((await get(f, id)).answer!.ruleIds).toEqual([f.tg]);
    expect((await auditLines(f))[0]!.ruleIds).toEqual([f.tg]);
  });

  it("an onAuto that throws is logged; the auto answer stands", async () => {
    const f = await setup({ onAutoThrows: true });
    const { id } = await f.store.add(choice());
    expect(await f.auto.apply(id, body(f), MASTER)).toMatchObject({ code: 200, item: { status: "auto" } });
    expect(f.logs.some((l) => l.includes(id) && l.includes("telegram down"))).toBe(true);
    expect((await get(f, id)).status).toBe("auto");
  });

  it("a second --auto on the auto item → 409 item is not open", async () => {
    const f = await setup();
    const { id } = await f.store.add(choice());
    await f.auto.apply(id, body(f), MASTER);
    const r = await f.auto.apply(id, body(f, { value: "A" }), MASTER);
    expect(r).toMatchObject({ code: 409, body: { error: "item is not open" } });
    expect((await auditLines(f))).toHaveLength(1);
  });
});
