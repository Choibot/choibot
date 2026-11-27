// server/chief/queue/actions.ts — what the user (and an item's own agent)
// does to a queue item (spec §5.1, §5.4 step 7, §5.6, §6.2 source 1, §7):
// answer (which supersedes a held auto answer), undo (the user's own answer
// or an auto answer; the master its own auto answer), snooze, withdraw, and
// the Undelivered actions Resend / Mark delivered. Every change is a
// read-modify-write under the item lock. The brain and audit writes of an
// answer or an undo run under it too, after the commit, along the lock chain
// item → rule store → decision log (spec §5.4; the audit file is a leaf);
// `deliverer.kick` runs only once the item lock is released.
import { join } from "node:path";
import { isPersistentKind, type SessionStore } from "../../agents/store.js";
import type { MasterInbox } from "../../master/inbox.js";
import { FLEET_MASTER_ID } from "../../master/paths.js";
import type { Caller } from "../auth.js";
import { isPersistentAgentId } from "../kinds.js";
import { normalizeRuleText, RuleError, type DecisionLog, type Reason, type RuleStore, type Via } from "../brain/store.js";
import type { AuditEntry, AuditLog } from "./auto.js";
import type { Deliverer } from "./deliver.js";
import { answerMsgId, closedMerged, isMergedNotice, nextAnswerSeq, withdrawalMsgId } from "./lines.js";
import { gateRefusal, type MergeState } from "./prgate.js";
import { parseRecommend, validateUserAnswer } from "./schema.js";
import { isAgentGone } from "./sections.js";
import type { QueueStore } from "./store.js";
import { isAgentItem, isRuleSuggestion, type AgentItem, type Answer, type AnswerImage, type Delivery, type QueueItem } from "./types.js";
import { pruneDrafts, saveDraft, takeDrafts, type TakeDeps } from "./answerImages.js";

export type ActionResult = { code: 200; item: QueueItem } | { code: 400 | 403 | 404 | 409; body: Record<string, unknown> };

export type QueueActionsDeps = {
  store: QueueStore; rules: RuleStore; decisions: DecisionLog; agents: Pick<SessionStore, "load">;
  deliverer: Pick<Deliverer, "kick">; inbox: Pick<MasterInbox, "cancel">; audit: Pick<AuditLog, "append">; undoMs: number;
  // Is the item's PR merged right now (prgate.ts prMergeState)? Asked outside the item lock,
  // before an `approve` of a pr item (decision 60). It must never reject.
  mergeState: (item: QueueItem) => Promise<MergeState>;
  // After a rule suggestion is answered: the suggester may show the next one. Never awaited.
  onRuleAnswered?: () => void;
  // How an answer's image goes to the agent (tests); default: the composer's upload (answerImages.ts).
  images?: TakeDeps;
  now?: () => number; log?: (s: string) => void;
};

// The answers of a rule suggestion (brain/suggest.ts): A = Yes, B = No, a reply = Edit.
export const RULE_YES = "A";
export const RULE_NO = "B";
// Why a rule suggestion closed with no answer (QueueItem.lastError).
export const RULE_CHANGED = "rule-changed";

// Seven days (spec §7 `snooze`, Review Focus 4).
export const SNOOZE_MAX_MINUTES = 7 * 24 * 60;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const done = (item: QueueItem): ActionResult => ({ code: 200, item });
const refuse = (code: 400 | 403 | 404 | 409, error: string, item?: QueueItem): ActionResult =>
  ({ code, body: item ? { error, item } : { error } });
// A 409 carries the current item, which the tab applies (Review Focus 5).
const alreadyAnswered = (item: QueueItem): ActionResult => refuse(409, "already answered", item);

const isOpen = (item: QueueItem): boolean => item.status === "open" || item.status === "snoozed";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const NO_ANSWER = "a deploy ticket takes no answer: use Deploy";
// The pr an item points at, as one string: the gate's read and its close must name the same one.
const prKeyOf = (item: QueueItem): string => JSON.stringify(item.pr && ("url" in item.pr ? [item.pr.url] : [item.pr.local.repo, item.pr.local.branch]));

// What an undo does to the line it takes back (the §5.6 table).
type UndoPlan = { withdraw: boolean; afterMsgId?: string; cancelled?: { msgId: string; result: "removed" | "in-flight" } };

const queueVia = (via: Answer["via"]): Via => (via === "telegram" ? "queue-telegram" : "queue-tab");
const prUrlOf = (item: QueueItem): string | undefined => (item.pr && "url" in item.pr ? item.pr.url : undefined);

// True when an answer gives `value` in the recommend sense: a question
// compares the normalized texts, every other kind the value (overview
// decisions 25, 33).
function answersWith(item: QueueItem, value: string, a: Pick<Answer, "value" | "text">): boolean {
  if (item.kind === "question") return normalizeRuleText(a.text ?? "") === normalizeRuleText(value);
  return a.value === value;
}

// True when an answer takes the recommendation.
export function followsRecommend(item: QueueItem, a: Pick<Answer, "value" | "text">): boolean {
  return item.recommend ? answersWith(item, item.recommend.value, a) : false;
}

// An auto answer read as a recommendation (overview decision 46): a
// question's value is its text, as `recommend.value` is.
const autoAsRecommend = (item: QueueItem, auto: Answer): { value: string; ruleIds: string[] } =>
  ({ value: item.kind === "question" ? auto.text ?? "" : auto.value, ruleIds: auto.ruleIds ?? [] });

// Why a user answer is a correction (spec §6.2 source 1), or null when it is not.
export function correctionOf(item: QueueItem, a: Pick<Answer, "value" | "text">): Reason | null {
  if (item.recommend && !followsRecommend(item, a)) return "differs-from-recommend";
  if (item.kind === "pr" && a.value === "changes") return "pr-changes";
  if (item.kind === "choice" && a.value === "reply") return "free-text";
  return null;
}

// The answer commit (spec §5.1, decision 50): the next answerSeq, the answer,
// and a fresh `delivery` slot whose msgId names that seq. A snooze ends here,
// whatever the path (tab, Telegram, auto). A user answer also ends a wait for
// a Telegram reply in this same write; an auto answer keeps it, so the awaited
// reply still reaches answerUser, where it beats a held auto (spec §5.6). An
// item with no `telegram` gets none.
export function withAnswer(item: QueueItem, a: Answer, slot: Omit<Delivery, "msgId">): QueueItem {
  const seq = nextAnswerSeq(item);
  const { snoozedUntil: _ended, ...rest } = item;
  const next: QueueItem = { ...rest, status: a.by === "master" ? "auto" : "answered", answer: a, answerSeq: seq,
    delivery: { msgId: answerMsgId(item, seq), ...slot } };
  if (a.by === "user" && item.telegram?.awaiting !== undefined) {
    const { awaiting: _done, ...telegram } = item.telegram;
    next.telegram = telegram;
  }
  return next;
}

// Decision 39, failing closed: true for an item of a master or a lead by
// its id, by who created it for itself, or by its record, and for an item
// whose record does not load (a torn record loads as null, decision 37; the
// id test alone is only a UI guard, a lead id need not start with `lead-`).
// Shared by `recommend` and the auto-answer check 9 (auto.ts).
export async function userAnswersOnly(item: QueueItem, agents: Pick<SessionStore, "load">): Promise<boolean> {
  // The console's own deploy ticket (spec §5.7): never a recommendation, never an auto answer.
  if (!isAgentItem(item)) return true;
  if (isPersistentAgentId(item.agentId)) return true;
  const by = item.createdBy;
  if ((by.kind === "lead" || by.kind === "fleet-master" || by.kind === "coordinator") && by.agentId === item.agentId) return true;
  const rec = await agents.load(item.agentId);
  return !rec || isPersistentKind(rec.kind);
}

export class QueueActions {
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: QueueActionsDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // The ticket's own media folder (store.ts): its preview images, its page, its answer images.
  mediaDir(id: string): string { return join(this.d.store.mediaDir, id); }

  // A user answer. On an auto item (spec §5.6 "Races and undo"), compared
  // under the lock: a `held` auto line never went out, so the user wins and
  // the auto answer goes to history; any later state may have reached the
  // agent, so the change goes through undo and its withdrawal (409).
  async answerUser(id: string, body: unknown, via: Answer["via"]): Promise<ActionResult> {
    // Decision 60: an `approve` of a pr item goes to the merge gate, whatever the surface.
    // Decision 64: a `changes` goes there too. A merged PR has nothing left to change: the item
    // closes as merged and no change request reaches the agent.
    if (isObj(body) && (body.value === "approve" || body.value === "changes")) {
      const gated = await this.mergeGate(id, body, via, body.value);
      if (gated) return gated;
    }
    let rule = false;
    const r = await this.locked(id, async (item) => {
      if (isRuleSuggestion(item)) {
        rule = true;
        return this.answerRule(item, body, via);
      }
      // The console's own deploy ticket has no answer: only its Deploy route acts (spec §5.7).
      if (!isAgentItem(item)) return refuse(400, NO_ANSWER);
      const auto = item.status === "auto" && item.answer?.by === "master" ? item.answer : undefined;
      if (auto && item.delivery?.state !== "held") return refuse(409, "undo first", item);
      if (!auto && !isOpen(item)) return alreadyAnswered(item);
      const v = validateUserAnswer(item, body);
      if (!v.ok) return refuse(400, v.error);
      // Fail closed: the gate above takes every approve of a pr item. One that still gets here
      // (the item was not readable a moment ago) is never committed.
      if (item.kind === "pr" && v.value === "approve") return refuse(409, "approve needs the merge check; try again", item);
      // The images (answerImages.ts): copied to the agent and kept by the ticket before the write.
      let images: AnswerImage[] = [];
      let undoImages = async (): Promise<void> => {};
      if (v.images) {
        const t = await takeDrafts(this.mediaDir(id), v.images, nextAnswerSeq(item), await this.d.agents.load(item.agentId), this.d.images);
        if (!t.ok) return refuse(t.code === 409 ? 409 : 400, t.error);
        images = t.images;
        undoImages = t.undo;
      }
      const a: Answer = { value: v.value, ...(v.text !== undefined ? { text: v.text } : {}), by: "user", via, at: this.now(), ...(images.length ? { images } : {}) };
      // The held slot is replaced by the user's (same lock, so it never went out).
      const next = withAnswer(auto ? { ...item, history: [...item.history, auto] } : item, a, { state: "pending", attempts: 0 });
      try {
        await this.d.store.write(next);
      } catch (e) {
        // No answer names the kept images: they are drafts again, for the same answer once more.
        await this.attempt(id, "image undo", undoImages);
        throw e;
      }
      // The drafts that this answer did not take are of no use now.
      await this.attempt(id, "draft clean-up", () => pruneDrafts(this.mediaDir(id), 0, true));
      // Superseded: no hits for the auto answer, ever (its line never went out).
      if (auto) await this.audit(item, auto, "superseded", false);
      await this.learn(item, a, auto);
      return done(next);
    });
    if (r.code === 200 && rule) this.afterRule();
    else if (r.code === 200) this.d.deliverer.kick(id);
    return r;
  }

  // One image for the user's answer (answerImages.ts), kept as a draft of the ticket until the
  // answer names it. Only a ticket that a reply can answer: an agent's open ticket (or one whose
  // held auto answer the user may still replace), never a rule suggestion or the deploy ticket.
  async answerImage(id: string, buf: Buffer): Promise<{ code: 200; name: string } | { code: 400 | 404 | 409 | 413 | 415; error: string }> {
    return this.d.store.withItem(id, async () => {
      const item = await this.d.store.get(id);
      if (!item) return { code: 404 as const, error: "not found" };
      if (!isAgentItem(item) || isRuleSuggestion(item)) return { code: 400 as const, error: "this ticket takes no images" };
      const heldAuto = item.status === "auto" && item.answer?.by === "master" && item.delivery?.state === "held";
      if (!isOpen(item) && !heldAuto) return { code: 409 as const, error: "already answered" };
      const r = await saveDraft(this.mediaDir(id), buf, this.now());
      return r.ok ? { code: 200 as const, name: r.name } : { code: r.code, error: r.error };
    });
  }

  // A rule suggestion, under its item lock (lock order item → rule store). The answer acts on the
  // candidate first: Yes confirms it (as the panel's Confirm did), No retires it, a reply (Edit)
  // sets its text and confirms it. Only then is the answer written, closed at once: there is no
  // agent to deliver to and no undo (the Rules list edits or removes the rule). The caller is
  // the user: answerUser runs only for a USER request or a Telegram tap of the user. A rule that
  // is no longer a candidate (confirmed or retired elsewhere) closes the item, nothing written.
  private async answerRule(item: QueueItem, body: unknown, via: Answer["via"]): Promise<ActionResult> {
    if (!isOpen(item)) return alreadyAnswered(item);
    const v = validateUserAnswer(item, body);
    if (!v.ok) return refuse(400, v.error);
    if (v.images) return refuse(400, "a rule suggestion takes no images");
    const ruleId = item.rule!.id;
    const changed = async (why: string): Promise<ActionResult> => {
      const { snoozedUntil: _ended, ...rest } = item;
      const next: QueueItem = { ...rest, status: "withdrawn", lastError: RULE_CHANGED, closedAt: this.now() };
      await this.d.store.write(next);
      return refuse(409, why, next);
    };
    const cur = await this.d.rules.get(ruleId);
    if (!cur || cur.state !== "candidate") return changed(cur ? `rule ${ruleId} is ${cur.state} already` : `unknown rule ${ruleId}`);
    try {
      if (v.value === "reply") await this.d.rules.update(ruleId, { text: v.text!, confirm: true, via });
      else if (v.value === RULE_YES) await this.d.rules.confirm(ruleId, { via });
      else if (v.value === RULE_NO) await this.d.rules.retire(ruleId, { by: "user", why: "no to the suggestion" });
      else return refuse(400, "value must be A (yes), B (no) or reply (edit)");
    } catch (e) {
      if (e instanceof RuleError && e.code === 400) return refuse(400, e.message);
      if (e instanceof RuleError) return changed(e.message);
      throw e;
    }
    const a: Answer = { value: v.value, ...(v.text !== undefined ? { text: v.text } : {}), by: "user", via, at: this.now() };
    const next: QueueItem = { ...withAnswer(item, a, { state: "delivered", attempts: 0 }), closedAt: a.at };
    await this.d.store.write(next);
    return done(next);
  }

  private afterRule(): void {
    try {
      this.d.onRuleAnswered?.();
    } catch (e) {
      this.log(`[queue] rule suggestion follow-up failed: ${errText(e)}`);
    }
  }

  // The merge gate (overview decision 60): a pr item is never answered `approve`. The user
  // merges; the item then closes on its own (PrWatch) and its agent gets the merged line. An
  // approve while the PR is not merged, or while its state cannot be read, is refused with the
  // reason (409, the item unchanged). An approve after the merge closes the item at once, the
  // way PrWatch would: `withdrawn`, `lastError: "merged"`, the merged notice `pending`, plus the
  // user's decision line. The gh or git read runs outside the item lock; the close re-reads the
  // item under it. Null: not an open pr item, so answerUser goes on (404, 409, 400 as before).
  // A `changes` (decision 64) asks the same question first. Merged: the same close, the text is
  // not sent to the agent (the decision line keeps it), and no candidate rule is made. Not merged,
  // or not readable: null, and the change request is committed as before.
  private async mergeGate(id: string, body: unknown, via: Answer["via"], value: "approve" | "changes"): Promise<ActionResult | null> {
    const pre = await this.d.store.get(id);
    if (!pre || pre.kind !== "pr" || !isOpen(pre)) return null;
    const v = validateUserAnswer(pre, body);
    if (!v.ok) return refuse(400, v.error);
    let st: MergeState;
    try {
      st = await this.d.mergeState(pre);
    } catch (e) {
      st = { state: "unknown", why: errText(e) };
    }
    if (st.state !== "merged") {
      if (value === "changes") return null;
      const no = gateRefusal(pre, st);
      return { code: 409, body: { error: no.error, reason: no.reason, item: (await this.d.store.get(id)) ?? pre } };
    }
    const r = await this.locked(id, async (item) => {
      // PrWatch closed it while the gate read the state: the same result, nothing more to write.
      if (item.status === "withdrawn" && item.lastError === "merged" && prKeyOf(item) === prKeyOf(pre)) return done(item);
      if (!isOpen(item)) return alreadyAnswered(item);
      if (item.kind !== "pr" || prKeyOf(item) !== prKeyOf(pre)) return refuse(409, "the item changed; try again", item);
      const at = this.now();
      const next = closedMerged(item, at);
      await this.d.store.write(next);
      const prUrl = prUrlOf(item);
      await this.attempt(id, "decision line", () => this.d.decisions.append({
        at, via: queueVia(via), by: "user", itemId: id, agentId: item.agentId, ...(prUrl !== undefined ? { prUrl } : {}),
        repo: item.repo, area: item.area, value: "approve", text: value === "changes" ? v.text ?? "" : "", correction: false,
      }));
      return done(next);
    });
    // A kick for an item PrWatch closed is harmless: the Deliverer sends a slot once.
    if (r.code === 200) this.d.deliverer.kick(id);
    return r;
  }

  // Undo inside the undo window (spec §5.6 "Races and undo", §5.1): the user
  // undoes any answer, the master only its own auto answer. The answer goes
  // to history, the item reopens, and `delivery` is always cleared (decision
  // 32): the state it had decides only whether a withdrawal is created.
  // `expectSeq` names the answer to undo (the Telegram [Undo], decision 51):
  // compared under the lock, so an answer committed since is never undone.
  // `via` is where the undo came from (its decision line).
  async undo(id: string, caller: Caller, opts: { expectSeq?: number; via?: Answer["via"] } = {}): Promise<ActionResult> {
    if (caller.level !== "user" && caller.level !== "master") return refuse(403, "only the user or the master can undo an answer");
    const r = await this.locked(id, async (item) => {
      const a = item.answer;
      if (!isAgentItem(item)) return refuse(409, "nothing to undo", item); // a deploy ticket has no answer
      // An auto answer is `auto`, a user answer `answered`; anything else is a hand-edited file.
      if (!a || item.status !== (a.by === "master" ? "auto" : "answered")) return refuse(409, "nothing to undo", item);
      if (caller.level === "master" && a.by !== "master") return refuse(403, "the master undoes only its own auto answer");
      if (opts.expectSeq !== undefined && opts.expectSeq !== item.answerSeq) return refuse(409, "stale undo", item);
      // The scanner closes an answer only once its window passed (§5.1).
      if (this.now() - a.at > this.d.undoMs || item.closedAt !== undefined) return refuse(409, "undo window passed", item);
      const { answer: _undone, delivery, recommend: _cleared, ...rest } = item;
      const next: QueueItem = { ...rest, status: "open", history: [...item.history, a] };
      const plan = this.cancelOrWithdraw(item, delivery);
      // No new withdrawal keeps the slot as it is: one not yet delivered still
      // goes out before any newer answer (one slot is enough, §5.6).
      if (plan.withdraw) {
        next.withdrawal = { msgId: withdrawalMsgId(item, item.answerSeq), state: "pending", attempts: 0,
          ...(plan.afterMsgId !== undefined ? { afterMsgId: plan.afterMsgId } : {}) };
      }
      try {
        await this.d.store.write(next);
      } catch (e) {
        // The inbox already dropped or marked the line; the file still says
        // `delivering`. Resend would send the answer the user undid.
        if (plan.cancelled) {
          this.log(`[queue] ${id}: undo write failed after the inbox cancel of ${plan.cancelled.msgId} (${plan.cancelled.result}): ${errText(e)};`
            + " the item keeps its answer and its slot stays delivering (unknown after a restart): undo again, or Mark delivered, not Resend");
        }
        throw e;
      }
      // An auto answer: one strike per cited rule, by the user or the master.
      // `delivered`: the line had reached the agent (or may have, `unknown`).
      if (a.by === "master") {
        await this.audit(item, a, "undone", delivery?.state === "delivered" || delivery?.state === "unknown");
        await this.count(new Map((a.ruleIds ?? []).map((ruleId) => [ruleId, "strike" as const])), id);
      }
      // The user's line: a correction of the master, or a change of mind with
      // no strikes (§5.6, §6.5). The master's own undo writes none (decision 24).
      if (caller.level === "user") {
        const prUrl = prUrlOf(item);
        await this.attempt(id, "decision line", () => this.d.decisions.append({
          at: this.now(), via: queueVia(opts.via ?? "tab"), by: "user", itemId: id, agentId: item.agentId,
          ...(prUrl !== undefined ? { prUrl } : {}), repo: item.repo, area: item.area, value: a.value, text: "",
          ...(a.by === "master" ? { correction: true, reason: "undo" as const } : { correction: false, reason: "undo-own" as const }),
        }));
      }
      return done(next);
    });
    if (r.code === 200) this.d.deliverer.kick(id);
    return r;
  }

  // The §5.6 table, under the item lock: `withdraw` false when the line never
  // reached the agent, else a withdrawal to create. A master `delivering`
  // calls `inbox.cancel` first; `cancelled` says when that changed the inbox.
  // A worker or lead `delivering` is not observable (the paste holds the item
  // lock); found anyway, it withdraws, as does a missing slot ("when in
  // doubt, withdraw").
  private cancelOrWithdraw(item: QueueItem, delivery: Delivery | undefined): UndoPlan {
    const state = delivery?.state;
    if (state === "held" || state === "pending" || state === "failed") return { withdraw: false };
    if (delivery && state === "delivering" && item.agentId === FLEET_MASTER_ID) {
      const { msgId } = delivery;
      const result = this.d.inbox.cancel(msgId);
      if (result === "removed") return { withdraw: false, cancelled: { msgId, result } };
      // In flight: released when that send resolves, dropped when it returns false.
      if (result === "in-flight") return { withdraw: true, afterMsgId: msgId, cancelled: { msgId, result } };
    }
    return { withdraw: true };
  }

  async snooze(id: string, minutes: unknown): Promise<ActionResult> {
    return this.locked(id, async (item) => {
      // An answered item would reopen with its answer still set (decision 50).
      // Checked first, so an answered item always gets 409 with the item.
      if (!isOpen(item)) return alreadyAnswered(item);
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > SNOOZE_MAX_MINUTES) {
        return refuse(400, `minutes must be a whole number from 1 to ${SNOOZE_MAX_MINUTES}`);
      }
      const next: QueueItem = { ...item, status: "snoozed", snoozedUntil: this.now() + minutes * 60_000 };
      await this.d.store.write(next);
      return done(next);
    });
  }

  // The master's or the Coordinator's suggestion on a worker's item (spec §5.3,
  // §7), or a lead's on an item of a worker it spawned (the agent's record has
  // spawnedBy = the lead). Never on an item of a master, a lead or the
  // Coordinator (overview decision 39), checked first for every caller. A
  // cited rule the store does not know is a 400.
  async recommend(id: string, body: unknown, caller: Caller): Promise<ActionResult> {
    if (caller.level !== "master" && caller.level !== "coordinator" && caller.level !== "lead") return refuse(403, "only the master can recommend");
    return this.locked(id, async (item) => {
      if (await userAnswersOnly(item, this.d.agents)) return refuse(409, "the user answers this item", item);
      if (caller.level === "lead") {
        const rec = await this.d.agents.load(item.agentId);
        if (!caller.agentId || rec?.spawnedBy !== caller.agentId) return refuse(403, "a lead recommends only on its own workers' items");
      }
      if (!isOpen(item)) return refuse(409, "item is not open", item);
      // One recommendation per open item: the value the tab accepts never changes under the
      // user's cursor (an undo clears it, so a reopened item can get a new one).
      if (item.recommend) return refuse(409, "already recommended", item);
      const v = parseRecommend(item, body);
      if (!v.ok) return refuse(400, v.error);
      // One fold of rules.jsonl for all cited ids.
      const known = new Set((await this.d.rules.all()).map((r) => r.id));
      const unknown = v.value.ruleIds.find((ruleId) => !known.has(ruleId));
      if (unknown !== undefined) return refuse(400, `unknown rule ${unknown}`);
      const next: QueueItem = { ...item, recommend: { ...v.value, by: caller.agentId ?? FLEET_MASTER_ID, at: this.now() } };
      await this.d.store.write(next);
      return done(next);
    });
  }

  // The user, or the item's own agent (spec §7).
  async withdraw(id: string, caller: Caller): Promise<ActionResult> {
    return this.locked(id, async (item) => {
      // The console's own tickets (deploy, usage limit, a rule suggestion) have no agent: only the user.
      if (!isAgentItem(item) && caller.level !== "user") return refuse(403, "only the user can withdraw a ticket of the console");
      const own = caller.level !== "none" && caller.agentId !== undefined && caller.agentId === item.agentId;
      if (caller.level !== "user" && !own) return refuse(403, "only the item's agent or the user can withdraw it");
      if (!isOpen(item)) return refuse(409, "item is not open", item);
      const { snoozedUntil: _ended, ...rest } = item;
      const next: QueueItem = { ...rest, status: "withdrawn", closedAt: this.now() };
      await this.d.store.write(next);
      return done(next);
    });
  }

  // Resend / Mark delivered (spec §5.4 step 5, §7): only a slot in `unknown`
  // or `failed`. The answer slot also needs `item.answer`, or to be the merged
  // notice of a pr item (decision 60): after an undo its slot is stale and is
  // never sent again (decision 32). An item withdrawn agent-gone sends nothing
  // again (decision 37).
  async deliveryAction(id: string, action: unknown, slot: unknown = "answer"): Promise<ActionResult> {
    if (action !== "resend" && action !== "mark-delivered") return refuse(400, 'action must be "resend" or "mark-delivered"');
    if (slot !== "answer" && slot !== "withdrawal") return refuse(400, 'slot must be "answer" or "withdrawal"');
    const name = slot === "answer" ? "delivery" : "withdrawal";
    const r = await this.locked(id, async (item) => {
      if (isAgentGone(item)) return refuse(409, "agent gone", item);
      const cur = item[name];
      if (!cur || (cur.state !== "unknown" && cur.state !== "failed") || (name === "delivery" && !item.answer && !isMergedNotice(item))) {
        return refuse(409, "only an unknown or failed slot", item);
      }
      const { lastError: _cleared, ...rest } = cur;
      const moved = { ...rest, state: action === "resend" ? "pending" as const : "delivered" as const };
      const next: QueueItem = name === "delivery" ? { ...item, delivery: moved } : { ...item, withdrawal: moved };
      await this.d.store.write(next);
      return done(next);
    });
    // Mark delivered on a withdrawal frees the answer waiting behind it.
    if (r.code === 200) this.d.deliverer.kick(id);
    return r;
  }

  // fn on the item, read under its item lock; a missing item → 404.
  private locked(id: string, fn: (item: QueueItem) => Promise<ActionResult>): Promise<ActionResult> {
    return this.d.store.withItem(id, async () => {
      const item = await this.d.store.get(id);
      return item ? fn(item) : refuse(404, "not found");
    });
  }

  // The brain side of a committed user answer (spec §6.1, §6.2 source 1),
  // under the item lock, in this order: one hit or strike per cited rule, one
  // decision line with its correction flag. An answer makes no candidate rule
  // (pick A "Quiet rules", 2026-11-19): a one-time answer is not a rule; the
  // distiller reads the decision lines and proposes a rule only for a
  // correction that comes again. `item` is the item before the commit; `auto`
  // the held auto answer it superseded. Each write is best effort: the answer
  // is already committed, so a failure is logged and never turns the answer
  // into an error.
  private async learn(item: AgentItem, a: Answer, auto?: Answer): Promise<void> {
    const rec = item.recommend;
    // Another value than the held auto answer corrects the master, even with
    // no recommend; its line carries the auto value as `recommend` (decision 46).
    const autoRec = auto && autoAsRecommend(item, auto);
    const beatsAuto = autoRec !== undefined && !answersWith(item, autoRec.value, a);
    const reason: Reason | null = beatsAuto ? "differs-from-recommend" : correctionOf(item, a);
    const via = queueVia(a.via);
    const prUrl = prUrlOf(item);
    const ids = { itemId: item.id, agentId: item.agentId, ...(prUrl !== undefined ? { prUrl } : {}) };
    // One event per rule for this commit, and a strike wins: the auto's
    // rules first, then the recommend's (a hit when the user took it).
    const events = new Map<string, "hit" | "strike">();
    if (beatsAuto) for (const ruleId of autoRec.ruleIds) events.set(ruleId, "strike");
    if (rec) {
      const ev = followsRecommend(item, a) ? "hit" : "strike";
      for (const ruleId of rec.ruleIds) if (!events.has(ruleId)) events.set(ruleId, ev);
    }
    await this.count(events, item.id);
    const lineRec = beatsAuto ? autoRec : rec && { value: rec.value, ruleIds: rec.ruleIds };
    await this.attempt(item.id, "decision line", () => this.d.decisions.append({
      at: a.at, via, by: "user", ...ids, repo: item.repo, area: item.area, value: a.value, text: a.text ?? "",
      ...(lineRec ? { recommend: lineRec } : {}),
      correction: reason !== null, ...(reason ? { reason } : {}),
    }));
  }

  // One hit or strike per rule id, in map order. RuleStore writes nothing for
  // an id it does not know or a retired rule (its fold would drop the line).
  private async count(events: ReadonlyMap<string, "hit" | "strike">, itemId: string): Promise<void> {
    for (const [ruleId, ev] of events) {
      await this.attempt(itemId, `${ev} ${ruleId}`, () => (ev === "hit" ? this.d.rules.hit(ruleId, itemId) : this.d.rules.strike(ruleId, itemId)));
    }
  }

  // An audit line for an auto answer that left `auto` (spec §5.6); best effort.
  private async audit(item: AgentItem, auto: Answer, event: "superseded" | "undone", delivered: boolean): Promise<void> {
    const e: AuditEntry = { at: this.now(), itemId: item.id, agentId: item.agentId, kind: item.kind, value: auto.value,
      ruleIds: auto.ruleIds ?? [], confidence: auto.confidence ?? 0, undoUntil: auto.at + this.d.undoMs, event, delivered };
    await this.attempt(item.id, `audit ${event}`, () => this.d.audit.append(e));
  }

  private async attempt(itemId: string, what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log(`[queue] ${itemId}: ${what} failed: ${errText(e)}`);
    }
  }
}
