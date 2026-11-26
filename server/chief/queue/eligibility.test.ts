// Task 2b-5: rule auto-eligibility (spec §5.6 checks 4, 7, 10; §6.1).
// Rules come from foldRules over rules.jsonl events, so "newer" is append
// order exactly as the store folds it.
import { describe, expect, it } from "vitest";
import { foldRules, type Rule, type RuleEvent, type RuleScope } from "../brain/store.js";
import { authMode, ruleAutoEligible, type AuthMode } from "./eligibility.js";
import type { QueueItem } from "./types.js";

const ID = "r_aaaaa";
const T = 1_000;
const add = (o: { state?: "candidate" | "active"; scope?: RuleScope; confidence?: number } = {}): RuleEvent => ({
  ev: "add", id: ID, at: T, text: "prefer the registry", scope: o.scope ?? { area: "app-shop" }, kind: "decision",
  source: { origin: "panel" }, confidence: o.confidence ?? 0.9, state: o.state ?? "active",
});
const confirm = (via: "tab" | "cli" | "telegram", confidence = 0.9, at = T): RuleEvent =>
  ({ ev: "confirm", id: ID, at, by: "user", via, confidence });
const edit = (o: { text?: string; confidence?: number } = { text: "prefer the registry always" }, at = T): RuleEvent =>
  ({ ev: "edit", id: ID, at, by: "user", ...o });
const strike = (): RuleEvent => ({ ev: "strike", id: ID, at: T, itemId: "q00000000" });
const rule = (...events: RuleEvent[]): Rule => foldRules(events).get(ID)!;
// The usual eligible rule: active, confirmed on Telegram at 0.9.
const telegramRule = (scope?: RuleScope): Rule => rule(add({ scope }), confirm("telegram"));

const item = (o: Partial<QueueItem> = {}): QueueItem => ({
  id: "q7k2m9x1a", kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "app-shop", area: "app-shop",
  title: "t", body: "b", createdAt: T, updatedAt: T, status: "open", blocking: false, history: [], answerSeq: 0,
  choice: { options: [{ key: "A", label: "a" }, { key: "B", label: "b" }] }, ...o,
});
const no = (reason: string) => ({ ok: false, reason });
const OK = { ok: true };
const MODES: AuthMode[] = ["weak", "hardened"];

describe("authMode", () => {
  it("log wins over hardened; then hardened; else weak", () => {
    expect(authMode({ userAuth: "log", hardened: true })).toBe("log");
    expect(authMode({ userAuth: "log", hardened: false })).toBe("log");
    expect(authMode({ userAuth: "telegram", hardened: true })).toBe("hardened");
    expect(authMode({ userAuth: "telegram", hardened: false })).toBe("weak");
  });
});

describe("ruleAutoEligible", () => {
  it("a Telegram-confirmed active rule at 0.9 is eligible in weak and hardened mode", () => {
    for (const mode of MODES) expect(ruleAutoEligible(telegramRule(), item(), mode)).toEqual(OK);
  });

  it("a tab- or CLI-confirmed rule is not eligible in weak mode, eligible in hardened mode (check 7)", () => {
    for (const via of ["tab", "cli"] as const) {
      const r = rule(add(), confirm(via));
      expect(ruleAutoEligible(r, item(), "weak")).toEqual(no(`rule ${ID} was not confirmed on Telegram`));
      expect(ruleAutoEligible(r, item(), "hardened")).toEqual(OK);
    }
  });

  it("weak mode reads the latest confirm only: Telegram then tab → not eligible; tab then Telegram → eligible", () => {
    expect(ruleAutoEligible(rule(add(), confirm("telegram"), confirm("tab")), item(), "weak"))
      .toEqual(no(`rule ${ID} was not confirmed on Telegram`));
    expect(ruleAutoEligible(rule(add(), confirm("tab"), confirm("telegram")), item(), "weak")).toEqual(OK);
  });

  it("log mode: never, whatever the rule", () => {
    expect(ruleAutoEligible(telegramRule(), item(), "log")).toEqual(no("log mode: auto-answer off"));
    expect(ruleAutoEligible(rule(add({ state: "candidate" })), item(), "log")).toEqual(no("log mode: auto-answer off"));
  });

  it("a candidate is not eligible", () => {
    for (const mode of MODES) {
      expect(ruleAutoEligible(rule(add({ state: "candidate", confidence: 0.95 })), item(), mode)).toEqual(no(`rule ${ID} is not active`));
    }
  });

  it("a retired rule is not eligible", () => {
    const r = rule(add(), confirm("telegram"), { ev: "retire", id: ID, at: T, by: "user", why: "old" });
    expect(ruleAutoEligible(r, item(), "hardened")).toEqual(no(`rule ${ID} is not active`));
  });

  it("rule confidence below 0.9 (from the latest confirm or edit) is not eligible", () => {
    expect(ruleAutoEligible(rule(add(), confirm("telegram", 0.89)), item(), "weak")).toEqual(no(`rule ${ID} confidence < 0.9`));
    // An edit lowers it; the confirm after the edit sets it again.
    const lowered = rule(add(), edit({ confidence: 0.5 }), confirm("telegram", 0.85));
    expect(ruleAutoEligible(lowered, item(), "hardened")).toEqual(no(`rule ${ID} confidence < 0.9`));
    expect(ruleAutoEligible(rule(add(), confirm("telegram", 0.95)), item(), "weak")).toEqual(OK);
  });

  it("two strikes since the latest confirm → not eligible; one strike → eligible", () => {
    expect(ruleAutoEligible(rule(add(), confirm("telegram"), strike()), item(), "weak")).toEqual(OK);
    for (const mode of MODES) {
      expect(ruleAutoEligible(rule(add(), confirm("telegram"), strike(), strike()), item(), mode))
        .toEqual(no(`rule ${ID} has 2 strikes since its latest confirm`));
    }
  });

  it("a re-confirm resets the strikes → eligible", () => {
    const r = rule(add(), confirm("telegram"), strike(), strike(), confirm("telegram"));
    expect(ruleAutoEligible(r, item(), "weak")).toEqual(OK);
  });

  it("strikes before the latest confirm do not count, strikes after it do", () => {
    const r = rule(add(), confirm("telegram"), strike(), strike(), confirm("telegram"), strike());
    expect(ruleAutoEligible(r, item(), "weak")).toEqual(OK);
    expect(ruleAutoEligible(rule(add(), confirm("telegram"), strike(), strike(), confirm("telegram"), strike(), strike()), item(), "weak"))
      .toEqual(no(`rule ${ID} has 2 strikes since its latest confirm`));
  });

  it("an active rule with no confirm is not eligible, in weak and hardened mode (ruling P4)", () => {
    for (const mode of MODES) {
      expect(ruleAutoEligible(rule(add({ confidence: 0.95 })), item(), mode)).toEqual(no(`rule ${ID} has no confirm`));
      expect(ruleAutoEligible(rule(add({ confidence: 0.95 }), edit({ text: "x y" })), item(), mode)).toEqual(no(`rule ${ID} has no confirm`));
    }
  });

  it("an edit after the latest confirm → not eligible (check 4), in either mode", () => {
    for (const mode of MODES) {
      // Text only: the confidence stays 0.9, so only the order decides.
      expect(ruleAutoEligible(rule(add(), confirm("telegram"), edit()), item(), mode))
        .toEqual(no(`rule ${ID} was edited after its latest confirm`));
      expect(ruleAutoEligible(rule(add(), confirm("telegram", 0.9, T), edit({ text: "z" }, T - 500)), item(), mode))
        .toEqual(no(`rule ${ID} was edited after its latest confirm`));
    }
  });

  it("edit and confirm written by one request (edit line first, same at) → eligible", () => {
    const r = rule(add(), confirm("tab"), edit({ text: "prefer the registry always", confidence: 0.9 }, 5_000), confirm("telegram", 0.9, 5_000));
    expect(r.latestConfirm).toMatchObject({ at: 5_000, via: "telegram" });
    expect(r.latestEditSeq).toBe(r.latestConfirm!.seq - 1);
    expect(ruleAutoEligible(r, item(), "weak")).toEqual(OK);
  });

  it("newer is append order, not `at`: a confirm line after the edit line is newer even with an older `at`", () => {
    const r = rule(add(), edit({ text: "x" }, 9_000), confirm("telegram", 0.9, 2_000));
    expect(ruleAutoEligible(r, item(), "weak")).toEqual(OK);
  });

  it("scope.area '*' matches any item; an equal area matches", () => {
    expect(ruleAutoEligible(telegramRule({ area: "*" }), item({ area: "indexer", repo: "indexer" }), "weak")).toEqual(OK);
    expect(ruleAutoEligible(telegramRule({ area: "app-shop" }), item(), "weak")).toEqual(OK);
  });

  it("scope.area 'indexer' on an app-shop item → not eligible (check 10)", () => {
    expect(ruleAutoEligible(telegramRule({ area: "indexer" }), item(), "weak")).toEqual(no(`rule ${ID} scope does not match`));
  });

  it("scope.repo, when set, must equal the item repo", () => {
    expect(ruleAutoEligible(telegramRule({ area: "*", repo: "indexer" }), item(), "weak")).toEqual(no(`rule ${ID} scope does not match`));
    expect(ruleAutoEligible(telegramRule({ area: "*", repo: "app-shop" }), item(), "weak")).toEqual(OK);
  });

  it("scope.kind, when set, must equal the item kind", () => {
    expect(ruleAutoEligible(telegramRule({ area: "app-shop", kind: "question" }), item(), "weak")).toEqual(no(`rule ${ID} scope does not match`));
    expect(ruleAutoEligible(telegramRule({ area: "app-shop", kind: "choice" }), item(), "weak")).toEqual(OK);
    expect(ruleAutoEligible(telegramRule({ area: "app-shop", kind: "question" }), item({ kind: "question", choice: undefined }), "weak")).toEqual(OK);
  });

  it("the reasons come in the brief's order", () => {
    // Not active before confidence.
    expect(ruleAutoEligible(rule(add({ state: "candidate", confidence: 0.6 })), item(), "weak")).toEqual(no(`rule ${ID} is not active`));
    // Confidence before strikes.
    expect(ruleAutoEligible(rule(add(), confirm("telegram", 0.5), strike(), strike()), item(), "weak")).toEqual(no(`rule ${ID} confidence < 0.9`));
    // Strikes before the edit order.
    expect(ruleAutoEligible(rule(add(), confirm("telegram"), strike(), strike(), edit()), item(), "weak"))
      .toEqual(no(`rule ${ID} has 2 strikes since its latest confirm`));
    // The edit order before Telegram.
    expect(ruleAutoEligible(rule(add(), confirm("tab"), edit()), item(), "weak")).toEqual(no(`rule ${ID} was edited after its latest confirm`));
    // Telegram before scope.
    expect(ruleAutoEligible(rule(add({ scope: { area: "indexer" } }), confirm("tab")), item(), "weak"))
      .toEqual(no(`rule ${ID} was not confirmed on Telegram`));
  });

  it("fails closed on a corrupt confidence (NaN is never >= 0.9)", () => {
    const r = { ...telegramRule(), confidence: Number.NaN };
    expect(ruleAutoEligible(r, item(), "hardened")).toEqual(no(`rule ${ID} confidence < 0.9`));
  });
});
