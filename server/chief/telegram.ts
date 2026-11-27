// server/chief/telegram.ts — the chief of staff's Telegram route (spec §8).
// Phase 1a ships clause c: /pair and /unpair from the user in the Master topic
// (spec §3.1 steps 1 and 3). Phase 1b adds clauses a (q:k q:d q:p q:q), b
// (quoted replies to rule and proposal cards) and d (`rule:` lines), the
// Master-topic decision log, and the rule and proposal cards. Phase 2b adds
// the queue item taps (q:a q:c q:o q:r q:s q:u q:x) and the quoted replies
// that answer an item card awaiting one.
// IssuePoller asks this module before the master route and awaits each route
// in turn, so route() never awaits: it queues the work on a chain, and every
// step ends in .catch(log) (an unhandled rejection reaches uncaughtException,
// and server/index.ts exits on it). Inside a chain only local store and file
// work is awaited; every Telegram call (the 1a client has no timeout) runs
// beside the chain, so one hung call never stalls the next tap.
import type { EventHub } from "../events.js";
import { clip, TelegramError, type TelegramClient, type TgCallbackQuery, type TgMessage, type TgPhotoSize, type TgUpdate } from "../issues/telegram.js";
import { isCommand, largestPhoto } from "../issues/updates.js";
import { MAX_UPLOAD_BYTES } from "../agents/upload.js";
import type { CardChat } from "../master/telegram.js";
import { DEVICE_LABEL_RE, type Caller, type DeviceStore, type PairingCodes } from "./auth.js";
import { applyProposal, discardProposal } from "./brain/apply.js";
import type { CaptureLine } from "./brain/capture.js";
import { readProposal, type Proposal } from "./brain/distill.js";
import type { DecisionLog, Rule, RuleStore } from "./brain/store.js";
import { proposalCardText, proposalKeyboard, ruleCardKeyboard, ruleCardText, sha256Hex, type CardIndex } from "./cards.js";
import { oneLine } from "../text.js";
import type { DeployService } from "./deploy/service.js";
import type { LimitTicket } from "./limit/service.js";
import { onChain } from "./files.js";
import type { ChiefPaths } from "./paths.js";
import type { ActionResult, QueueActions } from "./queue/actions.js";
import { parseItemCallback, QUEUE_GLYPH, type ItemCallback } from "./queue/cards.js";
import { LIMIT_ALL } from "./limit/ticket.js";
import { sortOpen } from "./queue/priority.js";
import type { QueueStore } from "./queue/store.js";
import type { QueueItem } from "./queue/types.js";
import { userCli } from "../usercli.mjs";

export type ChiefRoute = "handled" | "pass";

export const CHIEF_TG_TEXT = {
  pairSent: "Pairing link sent to you privately.",
  needStart: "Open a private chat with the bot, send /start, then /pair again",
  misconfigured: `Chief misconfigured — see \`${userCli()} doctor\``,
  // A console that pairs devices from the server (log mode): Telegram never starts a pairing
  // and never removes a device there.
  pairOnServer: "This console does not add or remove a device from Telegram. Open Settings, then Devices, in the console.",
  pairUsage: "Usage: /pair <label> (a-z, 0-9, - or _, up to 32 characters)",
  unpairUsage: "Usage: /unpair <label>",
  privateLink: (url: string) => `Pair this device: ${url}\nThe link works once, within 10 minutes.`,
  unpaired: (l: string) => `Device ${l} removed.`, noDevice: (l: string) => `No device named ${l}.`,
  changed: "changed since this card — see the new card",
  useButtons: "Use the buttons on the card.",
  noProposal: "No proposal waiting.",
  confirmed: (t: string) => `✓ Confirmed: "${t}"`,
  discarded: "✗ Discarded",
  applied: (v: string | null) => (v === null ? "✓ Applied" : `✓ Applied (previous brain saved as ${v})`),
  alreadyAnswered: "Already answered — see the Queue tab.",
  replyChanges: "Reply to this card with the changes.",
  replyAnswer: "Reply to this card with your answer.",
  tapFirst: "Tap a button on the card first.",
  refused: (why: string) => `Not accepted: ${why}`,
  photoUnread: "the photo could not be read from Telegram: send it again, or add it in the Queue",
} as const;

type Hub = Pick<EventHub, "emitEvent">;

export type ChiefTgDeps = {
  tg: Pick<TelegramClient, "sendMessage" | "deleteMessage" | "answerCallbackQuery" | "editMessageText">;
  // The fleet master chat, or the user's private chat with the bot (no threadId). In the
  // private chat only the ticket cards live: a tap on one and a quoted reply to one count, from
  // the user, exactly as in the fleet master chat. Nothing else is read there (see route).
  cfg: CardChat; consoleUrl: string; misconfigured: string | null;
  // The sign-in mode. "log": devices pair from the server only, so /pair and /unpair answer one
  // fixed line and do nothing. Absent = "telegram" (as before).
  userAuth?: "telegram" | "log";
  pairing: PairingCodes; devices: Pick<DeviceStore, "revoke">; log?: (s: string) => void;
  // Phase 1b. Without rules, cards and paths, clauses a and b are off; without
  // capture, clause d is off; without decisions, no Master-topic logging.
  rules?: RuleStore; decisions?: Pick<DecisionLog, "append">;
  cards?: Pick<CardIndex, "lookup" | "recordRule" | "recordProposal" | "addItem">; paths?: ChiefPaths; hub?: Hub;
  capture?: (line: CaptureLine) => Promise<{ hint?: string }>;
  // Phase 2a. Without queue, /queue passes.
  queue?: Pick<QueueStore, "list">; now?: () => number;
  // Phase 2b. Without actions, queueStore and cards, item taps are only
  // answered and replies to item cards pass.
  actions?: Pick<QueueActions, "answerUser" | "answerImage" | "snooze" | "undo" | "withdraw">;
  // A photo in a reply to a ticket card becomes the answer's image (queue/answerImages.ts). Without
  // it a photo reply gives only its caption, as before.
  files?: Pick<TelegramClient, "getFile" | "downloadFile">;
  queueStore?: Pick<QueueStore, "get" | "withItem" | "write">;
  // The deploy ticket's Deploy button (spec §5.7). Without it a `q:y` tap does nothing.
  deploy?: Pick<DeployService, "startFromCard">;
  // The usage-limit ticket's buttons (limit/service.ts); absent: its taps do nothing.
  limit?: Pick<LimitTicket, "press">;
};

const QUEUE_LINE_MAX = 200;

// An age as "now", "12m", "3h" or "2d".
function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

type Brain = { rules: RuleStore; cards: NonNullable<ChiefTgDeps["cards"]>; paths: ChiefPaths; hub: Hub };
type Items = { actions: NonNullable<ChiefTgDeps["actions"]>; store: NonNullable<ChiefTgDeps["queueStore"]>; cards: NonNullable<ChiefTgDeps["cards"]> };
type Awaiting = NonNullable<NonNullable<QueueItem["telegram"]>["awaiting"]>;

// Group commands arrive as /pair@botname, and isCommand checks the entity only.
export function commandWord(m: TgMessage): string | null {
  if (!isCommand(m) || typeof m.text !== "string") return null;
  return m.text.slice(0, m.entities![0].length).split("@")[0];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const CALLBACK = /^q:([kdpq]):(r_[0-9a-z]{5}|brain)$/;
const RULE_PREFIX = /^rule:/i;
const RULES_CHAIN = "chief-tg:rules";
const PROPOSAL_CHAIN = "chief-tg:proposal";
// One chain per item: its taps and replies run in arrival order.
const ITEM_CHAIN = "tg-item:";
const noHub: Hub = { emitEvent() {} };
// The Telegram user (route checks the sender) acts as USER.
const TG_USER: Caller = { level: "user", agentHeaders: false };
const SNOOZE_MINUTES = 60;
const isOpen = (item: QueueItem): boolean => item.status === "open" || item.status === "snoozed";
// An auto answer still held: it never went out, so a user answer beats it (spec §5.6).
const isHeldAuto = (item: QueueItem): boolean => item.status === "auto" && item.delivery?.state === "held";

export class ChiefTelegram {
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();
  private readonly log: (s: string) => void;

  constructor(private readonly d: ChiefTgDeps) {
    this.log = d.log ?? ((s) => console.warn(s));
  }

  route(u: TgUpdate): ChiefRoute {
    if (u.callback_query) return this.routeCallback(u.callback_query);
    const m = u.message;
    if (!m || !this.fromUserInTopic(m)) return "pass";
    // The private chat: only a quoted reply to a ticket card is taken. This chat is also where
    // issues come in, so no command, no rule line and no decision line is read here.
    if (this.d.cfg.threadId === undefined) {
      if (this.d.misconfigured !== null || m.forward_origin) return "pass";
      return this.routeCardReply(m, true) ? "handled" : "pass";
    }
    const word = commandWord(m);
    if (word === "/pair" || word === "/unpair") {
      // Misconfigured (spec §4.4): only this reply, never the master's PTY.
      if (this.d.misconfigured !== null) {
        this.enqueue(word, () => this.reply(m, CHIEF_TG_TEXT.misconfigured));
        return "handled";
      }
      // Log mode: device pairing stays on the server. No code is minted, no device is removed.
      if (this.d.userAuth === "log") {
        this.enqueue(word, () => this.reply(m, CHIEF_TG_TEXT.pairOnServer));
        return "handled";
      }
      const label = m.text!.slice(m.entities![0].length).trim();
      this.enqueue(word, () => (word === "/pair" ? this.pair(m, label) : this.unpair(m, label)));
      return "handled";
    }
    // Fails closed: everything below is off while misconfigured.
    if (this.d.misconfigured !== null) return "pass";
    if (word === "/queue" && this.d.queue) {
      const queue = this.d.queue;
      // Beside the chain: a hung send must not stall /pair or /unpair.
      this.run(word, () => this.queueList(queue));
      return "handled";
    }
    // Forwarded text is third-party (spec §6.2): not logged, no candidate, no card edit.
    if (m.forward_origin) return "pass";
    if (this.routeCardReply(m)) return "handled";
    const capture = this.d.capture;
    if (capture && typeof m.text === "string" && RULE_PREFIX.test(m.text)) {
      // capture logs the line itself, then makes the candidate and its card.
      const text = m.text;
      this.run("rule: line", () => capture({ text, via: "master-telegram" }).then((r) => {
        if (r.hint) { const hint = r.hint; this.run("hint", () => this.reply(m, hint)); }
      }));
      return "pass";
    }
    const decisions = this.d.decisions;
    const text = m.text ?? m.caption;
    if (decisions && text?.trim()) {
      this.run("decision line", () => decisions.append({ by: "user", via: "master-telegram", correction: null, text }));
    }
    return "pass";
  }

  // Resolves when the work queued so far, and the work it started, has settled (tests).
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await Promise.all([chain, ...this.pending]);
      if (this.pending.size === 0 && chain === this.chain) return;
    }
  }

  // The card for `rule` in the Master topic, recorded in cards.json. Rejects
  // to the caller; idle() waits for it too.
  postRuleCard(rule: Rule): Promise<void> {
    return this.track((async () => {
      const b = this.requireBrain();
      const sent = await this.d.tg.sendMessage(this.d.cfg.chatId, ruleCardText(rule),
        { threadId: this.d.cfg.threadId, keyboard: ruleCardKeyboard(rule) });
      await b.cards.recordRule(sent.message_id, rule);
    })());
  }

  postProposalCard(p: Proposal): Promise<void> {
    return this.track((async () => {
      const b = this.requireBrain();
      const sent = await this.d.tg.sendMessage(this.d.cfg.chatId, proposalCardText(p),
        { threadId: this.d.cfg.threadId, keyboard: proposalKeyboard(this.d.consoleUrl) });
      await b.cards.recordProposal(sent.message_id, p);
    })());
  }

  // Clauses a and b need the rule store, the card index and the brain paths,
  // and are off while misconfigured.
  private brain(): Brain | null {
    const { rules, cards, paths, hub } = this.d;
    if (this.d.misconfigured !== null || !rules || !cards || !paths) return null;
    return { rules, cards, paths, hub: hub ?? noHub };
  }

  private requireBrain(): Brain {
    const b = this.brain();
    if (!b) throw new Error("rule and proposal cards are off");
    return b;
  }

  // From the user, in the chat of the cards: the Master topic, or (no threadId) the user's own
  // private chat with the bot.
  private fromUserInTopic(m: TgMessage): boolean {
    const { chatId, threadId, userId } = this.d.cfg;
    if (threadId === undefined) return m.chat.type === "private" && m.chat.id === chatId && chatId === userId && m.from?.id === userId;
    return m.chat.id === chatId && m.is_topic_message === true && m.message_thread_id === threadId && m.from?.id === userId;
  }

  // Clause a. The answer fires first; the action is queued synchronously, so
  // two taps keep arrival order, and never on a store lock itself. Only a tap
  // by the user on a message in the Master topic (chat and thread) counts.
  private routeCallback(cq: TgCallbackQuery): ChiefRoute {
    const { chatId, threadId, userId } = this.d.cfg;
    // The private chat has ticket cards only: no rule card and no proposal card.
    const b = threadId === undefined ? null : this.brain();
    const q = this.items();
    const card = cq.message;
    if ((!b && !q) || !card || cq.from.id !== userId || card.chat.id !== chatId || card.message_thread_id !== threadId) return "pass";
    if (threadId === undefined && (card.chat.type !== "private" || chatId !== userId)) return "pass";
    if (typeof cq.data !== "string" || !cq.data.startsWith("q:")) return "pass";
    this.run("answerCallbackQuery", () => this.d.tg.answerCallbackQuery(cq.id));
    const tapped = parseItemCallback(cq.data);
    if (tapped) {
      if (q) this.run(cq.data, () => onChain(ITEM_CHAIN + tapped.itemId, () => this.itemTap(q, tapped, card.message_id)));
      return "handled";
    }
    const hit = b ? CALLBACK.exec(cq.data) : null;
    if (!b || !hit) return "handled";                 // unknown q: data
    const [, act, target] = hit;
    const onRule = act === "k" || act === "d";
    if (onRule !== (target !== "brain")) return "handled";
    if (onRule) this.run(cq.data, () => onChain(RULES_CHAIN, () => this.ruleTap(b, act, target, card.message_id)));
    else this.run(cq.data, () => onChain(PROPOSAL_CHAIN, () => this.proposalTap(b, act, card.message_id)));
    return "handled";
  }

  private async ruleTap(b: Brain, act: string, id: string, messageId: number): Promise<void> {
    const card = b.cards.lookup(messageId);
    if (!card || card.kind !== "rule" || card.ruleId !== id) return;   // unknown card
    const rule = await b.rules.get(id);
    if (!rule) return;
    if (act === "d") {
      // Discard is for candidates; a rule confirmed since the card stays.
      if (rule.state === "active") return;
      if (rule.state === "candidate") await b.rules.retire(id, { by: "user", why: "discarded on Telegram" });
      this.edit(messageId, CHIEF_TG_TEXT.discarded);
      return;
    }
    if (rule.state === "retired") return;
    // The user only ever confirms text they saw.
    if (sha256Hex(rule.text) !== card.textSha256) {
      this.run("changed", () => this.replyTo(messageId, CHIEF_TG_TEXT.changed));
      this.run("rule card", () => this.postRuleCard(rule));
      return;
    }
    // A second tap: confirm would write another line. A tab or CLI confirm
    // since the card does not count: the tap still writes via "telegram".
    const c = rule.latestConfirm;
    if (rule.state === "active" && c && c.via === "telegram" && c.at >= card.at) return;
    const done = await b.rules.confirm(id, { via: "telegram" });
    this.edit(messageId, CHIEF_TG_TEXT.confirmed(done.text));
  }

  private async proposalTap(b: Brain, act: string, messageId: number): Promise<void> {
    const card = b.cards.lookup(messageId);
    if (!card || card.kind !== "brain") return;      // unknown card
    const expectSha256 = card.proposalSha256;
    try {
      if (act === "p") {
        const { version } = await applyProposal({ paths: b.paths, rules: b.rules, hub: b.hub, expectSha256 });
        this.edit(messageId, CHIEF_TG_TEXT.applied(version));
      } else {
        if (!(await readProposal(b.paths))) throw new Error("no proposal");
        await discardProposal({ paths: b.paths, hub: b.hub, expectSha256 });
        this.edit(messageId, CHIEF_TG_TEXT.discarded);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : "";
      if (why === "no proposal") {
        this.run("noProposal", () => this.replyTo(messageId, CHIEF_TG_TEXT.noProposal));
      } else if (why === "changed") {
        this.run("changed", () => this.replyTo(messageId, CHIEF_TG_TEXT.changed));
        const current = await readProposal(b.paths);
        if (current) this.run("proposal card", () => this.postProposalCard(current));
      } else {
        throw e;
      }
    }
  }

  // Item taps need the queue actions, the item store and the card index, and
  // are off while misconfigured.
  private items(): Items | null {
    const { actions, queueStore, cards } = this.d;
    if (this.d.misconfigured !== null || !actions || !queueStore || !cards) return null;
    return { actions, store: queueStore, cards };
  }

  // On the item's chain. Every action takes the item lock itself; the card
  // edit that follows a change is the CardPoster's (hub `queue` event).
  private async itemTap(q: Items, cb: ItemCallback, cardId: number): Promise<void> {
    const id = cb.itemId;
    let r: ActionResult;
    switch (cb.action) {
      case "a": r = await this.answer(q, id, { value: "approve" }); break;
      case "o": {
        // Options never change on an item, so the key read here stays valid.
        // An `auto` item goes on to answerUser, which decides under the lock
        // (spec §5.6): a held auto answer loses to the user, a later one is 409.
        const item = await q.store.get(id);
        const key = item?.choice?.options[cb.idx ?? -1]?.key;
        if (!item) r = { code: 404, body: { error: "not found" } };
        else if (!isOpen(item) && item.status !== "auto") r = { code: 409, body: { error: "already answered" } };
        else if (key === undefined) r = { code: 400, body: { error: `no option ${cb.idx} on this item` } };
        else r = await this.answer(q, id, { value: key });
        break;
      }
      case "c": case "r": return this.awaitReply(q, cb, cardId);
      case "s": r = await q.actions.snooze(id, SNOOZE_MINUTES); break;
      case "u": r = await q.actions.undo(id, TG_USER, { expectSeq: cb.seq, via: "telegram" }); break;
      case "x": r = await q.actions.withdraw(id, TG_USER); break;
      // Deploy (spec §5.7): routeCallback let only the user's own Telegram account come here.
      // The service starts a run only for the console's own open ticket, and takes no input.
      case "y": {
        const deploy = this.d.deploy;
        if (!deploy) return;
        const s = await deploy.startFromCard(id);
        r = s.code === 200 ? { code: 200, item: s.item } : { code: 409, body: { error: s.error, reason: "deploy" } };
        break;
      }
      // The usage-limit ticket: routeCallback let only the user's own Telegram account come here.
      // The service checks the ticket, the row and the login again now. The card edits itself (the
      // rows' states); a press of "all" also says how many it took.
      case "l": {
        const limit = this.d.limit;
        if (!limit || !cb.limit) return;
        const s = await limit.press(id, cb.limit);
        if (s.code === 200) {
          r = { code: 200, item: s.item };
          if (cb.limit.row === LIMIT_ALL) this.run("limit reply", () => this.replyTo(cardId, s.text));
        } else r = { code: s.code, body: { error: s.error, reason: "limit" } };
        break;
      }
    }
    this.outcome(r, cardId);
  }

  // A user answer from Telegram. The commit itself ends any wait for a reply
  // (withAnswer drops `awaiting` in the same item write for a user answer).
  private answer(q: Items, id: string, body: { value: string; text?: string; images?: string[] }): Promise<ActionResult> {
    return q.actions.answerUser(id, body, "telegram");
  }

  // Changes… / Other… / Reply…: under the item lock, mark the item awaiting
  // a reply; then, beside the chain, post the hint on the card and record its
  // id (a reply to the hint answers the item too, also after a restart). A
  // held auto item may still wait for one: the reply would beat it (§5.6).
  private async awaitReply(q: Items, cb: ItemCallback, cardId: number): Promise<void> {
    const id = cb.itemId;
    const r = await q.store.withItem(id, async (): Promise<ActionResult | null> => {
      const item = await q.store.get(id);
      if (!item) return { code: 404, body: { error: "not found" } };
      if (!isOpen(item) && !isHeldAuto(item)) return { code: 409, body: { error: "already answered" } };
      const awaiting: Awaiting | null = cb.action === "c"
        ? (item.kind === "pr" || item.kind === "preview" ? "changes" : null)
        : (item.kind === "choice" ? "other" : item.kind === "question" ? "reply" : null);
      if (!awaiting) return { code: 400, body: { error: `no ${cb.action === "c" ? "changes" : "reply"} on a ${item.kind} item` } };
      await q.store.write({ ...item, telegram: { ...item.telegram, awaiting } });
      return null;
    });
    if (r) return this.outcome(r, cardId);
    const text = cb.action === "c" ? CHIEF_TG_TEXT.replyChanges : CHIEF_TG_TEXT.replyAnswer;
    this.run("hint", async () => {
      const sent = await this.d.tg.sendMessage(this.d.cfg.chatId, text, { threadId: this.d.cfg.threadId, replyTo: cardId });
      q.cards.addItem(sent.message_id, id);
      await q.store.withItem(id, async () => {
        const cur = await q.store.get(id);
        const extra = cur?.telegram?.extraMessageIds ?? [];
        if (!cur || extra.includes(sent.message_id)) return;
        await q.store.write({ ...cur, telegram: { ...cur.telegram, extraMessageIds: [...extra, sent.message_id] } });
      });
    });
  }

  // On the item's chain: a quoted reply to an item card (or its hint). Only
  // an item awaiting a reply takes it as the answer. On an `auto` item the
  // awaited reply goes on to answerUser, which decides under the lock (spec
  // §5.6): a held auto loses to it, a later one is 409. An auto item's card
  // has no buttons, so a reply there that awaits nothing is already answered.
  // `photo`: the bytes of the reply's photo (or why they could not be read). It goes up as one
  // image of the answer, checked from its bytes as the Queue page's images are, with the caption
  // as the text. An album comes as one message for each photo: the first answers, and each other
  // one gets "Already answered".
  private async itemReply(q: Items, id: string, m: TgMessage, photo?: Buffer | { error: string }): Promise<void> {
    const item = await q.store.get(id);
    const awaiting = item?.telegram?.awaiting;
    const value = awaiting === "changes" ? "changes" : awaiting === "other" || awaiting === "reply" ? "reply" : null;
    const auto = item?.status === "auto";
    if (!item || (!isOpen(item) && !auto)) return this.outcome({ code: item ? 409 : 404, body: {} }, m.message_id);
    if (!value) {
      if (auto) return this.outcome({ code: 409, body: {} }, m.message_id);
      this.run("tapFirst", () => this.reply(m, CHIEF_TG_TEXT.tapFirst));
      return;
    }
    let images: string[] | undefined;
    if (photo) {
      if (!Buffer.isBuffer(photo)) return this.outcome({ code: 400, body: { error: photo.error } }, m.message_id);
      const up = await q.actions.answerImage(id, photo);
      if (up.code !== 200) return this.outcome({ code: up.code === 404 || up.code === 409 ? up.code : 400, body: { error: up.error } }, m.message_id);
      images = [up.name];
    }
    // Multi-line text as is: the answer line keeps its breaks (decision 55).
    this.outcome(await this.answer(q, id, { value, text: m.text ?? m.caption ?? "", ...(images ? { images } : {}) }), m.message_id);
  }

  // The reply to a refused action, beside the chain; a success says nothing
  // here (the poster edits the card). 404 and 409 mean the card is stale.
  private outcome(r: ActionResult, replyTo: number): void {
    if (r.code === 200) return;
    // The merge gate's 409 (overview decision 60) is not a stale card: it says why.
    const gated = r.code === 409 && typeof r.body.reason === "string" && typeof r.body.error === "string";
    const text = (r.code === 404 || r.code === 409) && !gated ? CHIEF_TG_TEXT.alreadyAnswered
      : CHIEF_TG_TEXT.refused(typeof r.body.error === "string" ? r.body.error : "refused");
    this.run("item reply", () => this.replyTo(replyTo, text));
  }

  // Clause b: a quoted reply to a card in the index. Every forum message
  // quotes the topic root, so a miss means "not a reply to us".
  private routeCardReply(m: TgMessage, itemsOnly = false): boolean {
    const quoted = m.reply_to_message?.message_id;
    if (quoted === undefined) return false;
    const card = this.d.cards?.lookup(quoted);
    if (itemsOnly && card?.kind !== "item") return false;
    if (card?.kind === "item") {
      const q = this.items();
      if (!q) return false;
      const itemId = card.itemId;
      const photo = largestPhoto(m.photo);
      const files = this.d.files;
      if (photo && files) {
        // The download is a Telegram call: beside the chain (the head of this file). The answer
        // then goes on the item's chain, after what arrived before it.
        this.run("item photo reply", async () => {
          const got = await photoBytes(files, photo);
          await onChain(ITEM_CHAIN + itemId, () => this.itemReply(q, itemId, m, got));
        });
        return true;
      }
      this.run("item card reply", () => onChain(ITEM_CHAIN + itemId, () => this.itemReply(q, itemId, m)));
      return true;
    }
    const b = this.brain();
    if (!b) return false;
    if (card?.kind === "brain") {
      this.run("useButtons", () => this.reply(m, CHIEF_TG_TEXT.useButtons));
      return true;
    }
    if (card?.kind !== "rule") return false;
    const ruleId = card.ruleId;
    const text = m.text ?? m.caption ?? "";
    this.run("rule card reply", () => onChain(RULES_CHAIN, async () => {
      const rule = await b.rules.update(ruleId, { text });
      this.run("rule card", () => this.postRuleCard(rule));
    }));
    return true;
  }

  // Runs fn now (a sync throw counts as a rejection); its error is logged,
  // never thrown. idle() waits for it.
  private run(what: string, fn: () => Promise<unknown>): void {
    let p: Promise<unknown>;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    void this.track(p.catch((e: unknown) => { this.log(`[chief] telegram ${what} failed: ${errText(e)}`); }));
  }

  // p, unchanged; idle() waits until it settles.
  private track<T>(p: Promise<T>): Promise<T> {
    const done = p.then(() => {}, () => {});
    this.pending.add(done);
    void done.then(() => { this.pending.delete(done); });
    return p;
  }

  // The card edited in place, buttons removed.
  private edit(messageId: number, text: string): void {
    this.run("editMessageText", () => this.d.tg.editMessageText(this.d.cfg.chatId, messageId, text));
  }

  private enqueue(what: string, fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((e) => { this.log(`[chief] telegram ${what} failed: ${errText(e)}`); });
  }

  private async reply(m: TgMessage, text: string): Promise<void> {
    await this.replyTo(m.message_id, text);
  }

  private async replyTo(messageId: number, text: string): Promise<void> {
    await this.d.tg.sendMessage(this.d.cfg.chatId, text, { threadId: this.d.cfg.threadId, replyTo: messageId });
  }

  // The link goes only to the user's private chat, never into the topic (§3.1 step 1).
  private async pair(m: TgMessage, label: string): Promise<void> {
    if (!DEVICE_LABEL_RE.test(label)) return this.reply(m, CHIEF_TG_TEXT.pairUsage);
    const { userId } = this.d.cfg;
    const { code } = this.d.pairing.mint(label);
    let sent: TgMessage;
    try {
      sent = await this.d.tg.sendMessage(userId, CHIEF_TG_TEXT.privateLink(`${this.d.consoleUrl}/#pair=${code}`));
    } catch (e) {
      // A link that may or may not have arrived is never left claimable.
      this.d.pairing.drop(code);
      // 403: the user never sent /start to the bot.
      if (e instanceof TelegramError && e.status === 403) return this.reply(m, CHIEF_TG_TEXT.needStart);
      throw e;
    }
    if (!this.d.pairing.attachMessage(code, userId, sent.message_id)) {
      // Claimed before the send resolved: nothing else deletes the spent link (§3.1 step 2).
      await this.d.tg.deleteMessage(userId, sent.message_id)
        .catch((e) => { this.log(`[chief] telegram deleteMessage failed: ${errText(e)}`); });
    }
    await this.reply(m, CHIEF_TG_TEXT.pairSent);
  }

  // Titles and repos are untrusted agent text: plain text, no parse mode.
  private async queueList(queue: Pick<QueueStore, "list">): Promise<void> {
    const now = (this.d.now ?? Date.now)();
    const open = sortOpen(await queue.list(), now);
    const text = open.length === 0 ? "Nothing waits on you." : clip(open.map((i) =>
      clip(`${QUEUE_GLYPH[i.kind]} · ${oneLine(i.repo)} · ${i.id} · ${ageText(now - i.createdAt)} — ${oneLine(i.title)}`, QUEUE_LINE_MAX)).join("\n"));
    await this.d.tg.sendMessage(this.d.cfg.chatId, text, { threadId: this.d.cfg.threadId });
  }

  private async unpair(m: TgMessage, label: string): Promise<void> {
    if (!DEVICE_LABEL_RE.test(label)) return this.reply(m, CHIEF_TG_TEXT.unpairUsage);
    const found = await this.d.devices.revoke(label);
    await this.reply(m, found ? CHIEF_TG_TEXT.unpaired(label) : CHIEF_TG_TEXT.noDevice(label));
  }
}

// The bytes of a reply's photo (its largest size), at most the answer image limit (10 MB), or why
// not. Telegram stores a photo as a JPEG; saveDraft checks the bytes, as for every answer image.
export async function photoBytes(files: Pick<TelegramClient, "getFile" | "downloadFile">, p: TgPhotoSize): Promise<Buffer | { error: string }> {
  const tooBig = { error: `the photo is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` };
  if ((p.file_size ?? 0) > MAX_UPLOAD_BYTES) return tooBig;
  try {
    const f = await files.getFile(p.file_id);
    if (!f.file_path) return { error: CHIEF_TG_TEXT.photoUnread };
    if ((f.file_size ?? 0) > MAX_UPLOAD_BYTES) return tooBig;
    const buf = await files.downloadFile(f.file_path);
    return buf.length > MAX_UPLOAD_BYTES ? tooBig : buf;
  } catch {
    return { error: CHIEF_TG_TEXT.photoUnread };
  }
}
