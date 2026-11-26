// server/chief/queue/auto.ts — the master's `answer --auto` (spec §5.6
// checks 1–10 and "On success", §15; overview decisions 31, 39, 40, 57, 58).
// Only one path answers: every check passed and the breaker took its place.
// Any failed check downgrades: the reason is returned (200 `downgraded`) and
// logged, and only a `choice` with no `recommend` gets one; nothing else is
// ever written by a downgrade.
//
// Locks (overview § Files and locks): everything runs under the item lock;
// rules.jsonl is only read (a read needs no lock); the audit file is a leaf
// on its own chain. `deliverer.kick` and `onAuto` run after the item lock.
import { z } from "zod";
import type { SessionStore } from "../../agents/store.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import { RULE_ID, type Rule, type RuleStore } from "../brain/store.js";
import { appendJsonl, appendJsonlRaw, onChain, readJsonl } from "../files.js";
import { followsRecommend, userAnswersOnly, withAnswer, type ActionResult } from "./actions.js";
import type { Deliverer } from "./deliver.js";
import { ruleAutoEligible, type AuthMode } from "./eligibility.js";
import { BODY_MAX, validateUserAnswer } from "./schema.js";
import type { QueueStore } from "./store.js";
import { isAgentItem, type Answer, type QueueItem, type QueueKind } from "./types.js";

export type AuditEntry = { at: number; itemId: string; agentId: string; kind: QueueKind; value: string; ruleIds: string[];
  confidence: number; undoUntil: number; event: "auto" | "superseded" | "undone"; delivered: boolean };

const HOUR_MS = 3_600_000;
export const AUTO_PER_HOUR = 20, AUTO_HOLD_MS = 60_000;

const isCounted = (e: unknown, event: AuditEntry["event"], since: number): boolean =>
  typeof e === "object" && e !== null && (e as AuditEntry).event === event
  && typeof (e as AuditEntry).at === "number" && (e as AuditEntry).at >= since;

// chief/audit/auto.jsonl, append-only (spec §5.6). A leaf lock: nothing is
// taken while its chain is held.
export class AuditLog {
  constructor(readonly file: string) {}

  append(e: AuditEntry): Promise<void> {
    return appendJsonl(this.file, e);
  }

  // Lines of `event` with `at >= since`; a torn or malformed line counts as none.
  async countSince(event: AuditEntry["event"], since: number): Promise<number> {
    return (await readJsonl<unknown>(this.file)).filter((e) => isCounted(e, event, since)).length;
  }

  // The breaker's commit: count and append in one step on the file's chain,
  // so two auto answers on two items (two item locks) cannot both take the
  // last place. False: `limit` lines of `e.event` since `since` exist, nothing appended.
  appendBelow(e: AuditEntry, limit: number, since: number): Promise<boolean> {
    return onChain(this.file, async () => {
      // countSince takes no chain (a read), so it runs inside this one.
      if ((await this.countSince(e.event, since)) >= limit) return false;
      await appendJsonlRaw(this.file, [e]);
      return true;
    });
  }
}

export type AutoAnswerDeps = {
  store: QueueStore; rules: RuleStore; agents: Pick<SessionStore, "load">; audit: AuditLog;
  deliverer: Pick<Deliverer, "kick">; mode: () => AuthMode; threshold: number; undoMs: number;
  onAuto?: (item: QueueItem) => void; now?: () => number; log?: (s: string) => void;
};

export type AutoResult = ActionResult & { downgraded?: string };

const autoBody = z.object({
  value: z.string(),
  text: z.string().max(BODY_MAX).optional(),
  auto: z.literal(true),
  ruleIds: z.array(z.string().regex(RULE_ID, "must look like r_ab12c")).min(1).max(5),
  confidence: z.number().min(0).max(1),
});
type AutoBody = { value: string; text?: string; ruleIds: string[]; confidence: number };

const USER_ANSWERS = "the user answers this item";
const DIFFERS = "differs from the shown recommendation";
const BREAKER = `breaker: ${AUTO_PER_HOUR} auto answers in the last hour`;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const refuse = (code: 400 | 404 | 409, error: string, item?: QueueItem): AutoResult => ({ code, body: item ? { error, item } : { error } });

// The body, and its value checked per kind as for a user answer; a choice
// takes an option key only (no free text: a refused one becomes `recommend`).
function parseAutoBody(item: QueueItem, body: unknown): { ok: true; value: AutoBody } | { ok: false; error: string } {
  const r = autoBody.safeParse(body);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return { ok: false, error: i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message };
  }
  const v = validateUserAnswer(item, { value: r.data.value, ...(r.data.text !== undefined ? { text: r.data.text } : {}) });
  if (!v.ok) return v;
  if (item.kind === "choice" && v.value === "reply") return { ok: false, error: "value must be an option key" };
  return { ok: true, value: { value: v.value, ...(v.text !== undefined ? { text: v.text } : {}),
    ruleIds: [...new Set(r.data.ruleIds)], confidence: r.data.confidence } };
}

export class AutoAnswer {
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: AutoAnswerDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  async apply(id: string, body: unknown, caller: Caller): Promise<AutoResult> {
    // Check 1.
    if (caller.level !== "master") return { code: 403, body: { error: "only the master can auto-answer" } };
    let answered: QueueItem | undefined;
    const r = await this.d.store.withItem(id, async (): Promise<AutoResult> => {
      const item = await this.d.store.get(id);
      if (!item) return refuse(404, "not found");
      // A late --auto never overwrites the user's answer (decision 31).
      if (item.status !== "open") return refuse(409, "item is not open", item);
      // The console's own deploy ticket: no auto answer, no recommendation, nothing written.
      if (!isAgentItem(item)) return refuse(409, USER_ANSWERS, item);
      const p = parseAutoBody(item, body);
      if (!p.ok) return refuse(400, p.error);
      const b = p.value;
      const at = this.now();
      // Check 9 first: no recommend on such an item, ever (decision 39).
      if (await userAnswersOnly(item, this.d.agents)) return this.refused(item, USER_ANSWERS);
      const rules = new Map((await this.d.rules.all()).map((rule) => [rule.id, rule]));
      const reason = await this.firstFailure(item, b, rules, at);
      if (reason !== null) return this.downgrade(item, b, rules, caller, reason, at);
      const a: Answer = { value: b.value, ...(b.text !== undefined ? { text: b.text } : {}), by: "master", via: "cli", at,
        ruleIds: b.ruleIds, confidence: b.confidence };
      const next = withAnswer(item, a, { state: "held", deliverAfter: at + AUTO_HOLD_MS, attempts: 0 });
      // Check 6 again, atomic with its audit line. The line goes first: an
      // auto answer is never committed without one (it counts for the breaker).
      const entry: AuditEntry = { at, itemId: id, agentId: item.agentId, kind: item.kind, value: a.value, ruleIds: b.ruleIds,
        confidence: b.confidence, undoUntil: at + this.d.undoMs, event: "auto", delivered: false };
      if (!(await this.d.audit.appendBelow(entry, AUTO_PER_HOUR, at - HOUR_MS))) return this.downgrade(item, b, rules, caller, BREAKER, at);
      try {
        await this.d.store.write(next);
      } catch (e) {
        this.log(`[queue] ${id}: auto answer write failed after its audit line: ${errText(e)}`);
        throw e;
      }
      // No decision line: an auto answer is not a user decision.
      answered = next;
      return { code: 200, item: next };
    });
    if (answered) {
      this.d.deliverer.kick(id);
      this.notify(answered);
    }
    return r;
  }

  // Checks 2–8 and 10 in spec order, plus the recommend match (decision 58)
  // right after the kind checks; checks 4, 7 and 10 run per cited rule, in
  // the cited order (ruleAutoEligible, Task 2b-5). The reason of the first
  // failure, or null when all pass.
  private async firstFailure(item: QueueItem, b: AutoBody, rules: Map<string, Rule>, at: number): Promise<string | null> {
    if (item.kind !== "choice" && item.kind !== "question") return "pr and preview items are never auto-answered";
    if (item.kind === "question" && !item.recommend) return "a question needs a recommendation first";
    // Never another answer than the one the user sees suggested (decision 58;
    // a question compares normalized texts, decision 33).
    if (item.recommend && !followsRecommend(item, b)) return DIFFERS;
    // Log mode refuses on its own, whatever the cited ids are.
    const mode = this.d.mode();
    if (mode === "log") return "log mode: auto-answer off";
    for (const ruleId of b.ruleIds) {
      const rule = rules.get(ruleId);
      if (!rule) return `rule ${ruleId} does not exist`;
      const e = ruleAutoEligible(rule, item, mode);
      if (!e.ok) return e.reason;
    }
    // Fails closed on a threshold outside (0, 1] (NaN included).
    const t = this.d.threshold;
    if (!(t > 0 && t <= 1 && b.confidence >= t)) return `request confidence < ${t}`;
    if ((await this.d.audit.countSince("auto", at - HOUR_MS)) >= AUTO_PER_HOUR) return BREAKER;
    // Any author but the user counts as the master.
    if ([...item.history, ...(item.answer ? [item.answer] : [])].some((a) => a.by !== "user")) return "the item was auto-answered before";
    return null;
  }

  // A choice with no recommend gets one from the request (decision 57); every
  // other item keeps what it has. Check 9 has passed by now.
  private async downgrade(item: QueueItem, b: AutoBody, rules: Map<string, Rule>, caller: Caller, reason: string, at: number): Promise<AutoResult> {
    if (item.kind !== "choice" || item.recommend) return this.refused(item, reason);
    this.log(`[queue] ${item.id}: auto refused: ${reason}`);
    const next: QueueItem = { ...item, recommend: { value: b.value, why: `auto refused: ${reason}`,
      ruleIds: b.ruleIds.filter((ruleId) => rules.has(ruleId)), by: caller.agentId ?? FLEET_MASTER_ID, at } };
    await this.d.store.write(next);
    return { code: 200, item: next, downgraded: reason };
  }

  // A downgrade that writes nothing.
  private refused(item: QueueItem, reason: string): AutoResult {
    this.log(`[queue] ${item.id}: auto refused: ${reason}`);
    return { code: 200, item, downgraded: reason };
  }

  // The Telegram one-liner; its failure never undoes the answer.
  private notify(item: QueueItem): void {
    const failed = (e: unknown) => this.log(`[queue] ${item.id}: auto notice failed: ${errText(e)}`);
    try {
      const r: unknown = this.d.onAuto?.(item);
      if (r instanceof Promise) r.catch(failed);
    } catch (e) {
      failed(e);
    }
  }
}
