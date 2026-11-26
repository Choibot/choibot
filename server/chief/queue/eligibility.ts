// server/chief/queue/eligibility.ts — may a cited rule decide an item on its
// own (spec §5.6 checks 4, 7 and 10; §6.1)? Pure: the Rule is the fold of
// rules.jsonl (brain/store.ts foldRules), where `strikes` restarts at every
// confirm and "newer" is append order (`seq`), never `at`. Every test is
// written so a missing or corrupt field fails closed.
import type { Rule } from "../brain/store.js";
import type { QueueItem } from "./types.js";

// weak: an agent could forge a tab or CLI confirm, so only a Telegram confirm
// counts (check 7). hardened: any active rule. log: auto-answer is off (§3).
export type AuthMode = "weak" | "hardened" | "log";

export const RULE_AUTO_CONFIDENCE = 0.9;
const MAX_STRIKES = 2;

export function authMode(o: { userAuth: "telegram" | "log"; hardened: boolean }): AuthMode {
  if (o.userAuth === "log") return "log";
  return o.hardened ? "hardened" : "weak";
}

export function ruleAutoEligible(rule: Rule, item: QueueItem, mode: AuthMode): { ok: true } | { ok: false; reason: string } {
  const no = (why: string) => ({ ok: false as const, reason: `rule ${rule.id} ${why}` });
  if (mode === "log") return { ok: false, reason: "log mode: auto-answer off" };
  if (rule.state !== "active") return no("is not active");
  if (!(rule.confidence >= RULE_AUTO_CONFIDENCE)) return no(`confidence < ${RULE_AUTO_CONFIDENCE}`);
  if (!(rule.strikes < MAX_STRIKES)) return no(`has ${MAX_STRIKES} strikes since its latest confirm`);
  const confirm = rule.latestConfirm;
  if (!confirm) return no("has no confirm");
  // An edit after the confirm (a forged edit could rewrite text or
  // confidence) demotes the rule until it is confirmed again.
  if (rule.latestEditSeq !== undefined && !(confirm.seq > rule.latestEditSeq)) return no("was edited after its latest confirm");
  // Any mode but hardened needs the Telegram confirm.
  if (mode !== "hardened" && confirm.via !== "telegram") return no("was not confirmed on Telegram");
  const s = rule.scope;
  const scoped = (s.area === "*" || s.area === item.area)
    && (s.repo === undefined || s.repo === item.repo)
    && (s.kind === undefined || s.kind === item.kind);
  if (!scoped) return no("scope does not match");
  return { ok: true };
}
