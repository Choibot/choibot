// server/chief/queue/poster.ts — every queue item as a Telegram card in the
// Master topic (spec §8 "Queue cards"), or in the user's private chat with the
// bot when there is no Master topic (CardChat with no threadId). A preview posts its images first; every
// message id is stored on the item and taught to the card index. A card is
// edited in place when what it shows changes. Telegram calls never run inside
// an item lock (spec §5.4): read the item, call Telegram, then take the lock
// only to record the result. A failed post sets `telegram.postFailed`; only the
// 30 s tick retries it, with a per-item backoff, so a Telegram outage is at most
// one call per item per tick. Images Telegram refuses (a 4xx other than 429)
// set `telegram.mediaFailed` only once the card itself goes (a refusal can be
// an auth or chat fault, not the images): the card then says where they are.
import { TelegramError, type InlineKeyboard, type TelegramClient, type TgFile, type TgMessage } from "../../issues/telegram.js";
import type { CardChat } from "../../master/telegram.js";
import { sha256Hex, type CardIndex } from "../cards.js";
import { answeredCardText, autoKeyboard, autoLineText, queueCardKeyboard, queueCardText } from "./cards.js";
import type { QueueStore } from "./store.js";
import { hasImages, type QueueItem } from "./types.js";

export type CardPosterDeps = {
  tg: Pick<TelegramClient, "sendMessage" | "sendPhoto" | "sendMediaGroup" | "editMessageText" | "editMessageReplyMarkup">;
  cfg: CardChat; consoleUrl: string; store: QueueStore; cards: Pick<CardIndex, "addItem">;
  readMedia: (item: QueueItem, name: string) => Promise<Buffer>; ruleText?: (id: string) => string | undefined;
  telegramAuto: boolean; now?: () => number; tickMs?: number; log?: (s: string) => void;
};

type Tg = NonNullable<QueueItem["telegram"]>;
// One sync loop per item: `again` asks for one more pass once this one ends
// (an event arrived meanwhile); `retry` lets that pass post a postFailed item;
// `auto` asks that pass to post the auto one-liner (from postAuto only).
type Run = { again: boolean; retry: boolean; auto: boolean; done: Promise<void> };

const TICK_MS = 30_000;
const MEDIA_MAX = 10;
// Telegram messages the tick's new posts may send (the boot tick after a
// deploy posts every open item; Telegram allows about 20 messages a minute in
// a group). A post costs its card plus each image it sends.
const MESSAGES_PER_TICK = 10;
// A card whose item closed longer ago than this already shows its final
// state: a stale hash (a hash format change after a deploy) is stored, not edited.
const SETTLED_MS = 24 * 3_600_000;
// The wait before a postFailed item is posted again: one tick after its first
// failure, then 60 s, doubling, at most 10 min (in memory: a restart retries at once).
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 600_000;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
// The card was deleted (or can no longer be edited): a retry cannot help.
const GONE = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;
// A keyboard already removed (or its message gone): nothing left to clear.
const CLEARED = /message is not modified|message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
// Telegram refused the request itself: the same request fails again.
const refused = (e: unknown): boolean => e instanceof TelegramError && e.status >= 400 && e.status < 500 && e.status !== 429;
// The keyboard without its URL buttons, or null when it has none.
function withoutUrlButtons(kb: InlineKeyboard): InlineKeyboard | null {
  const rows = kb.inline_keyboard.map((row) => row.filter((b) => "callback_data" in b));
  if (rows.every((row, i) => row.length === kb.inline_keyboard[i].length)) return null;
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}
const mimeOf = (name: string): string => MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ""] ?? "application/octet-stream";
// Open and snoozed items show the buttons; every other status shows the outcome.
const showsButtons = (item: QueueItem): boolean => item.status === "open" || item.status === "snoozed";
// The auto line's [Undo] can no longer work: the item left `auto`, or the
// scanner closed it once its undo window passed.
const autoLineDone = (item: QueueItem): boolean => item.status !== "auto" || item.closedAt !== undefined;

// Message ids Telegram returned whose record write failed: the next attempt
// records them instead of sending again (no second card, no second images).
type Unrecorded = { mediaIds?: number[]; card?: { messageId: number; renderHash: string; mediaFailed: boolean } };
type MediaSent = { ids: number[] } | { unreadable: true } | { refused: string };

// What the card shows, minus its age: rendered with now = createdAt, the age
// reads "now" for every item, so the hash changes only when the text or the
// keyboard does, never as the item ages (a restart re-edits no card). The
// cited rule's text is part of it (same ruleText lookup as the card), so a
// card posted before the rule texts loaded is edited once they arrive.
export function cardRenderHash(item: QueueItem, consoleUrl: string, ruleText?: (id: string) => string | undefined): string {
  const o = { now: item.createdAt, ruleText, consoleUrl };
  const open = showsButtons(item);
  const text = open ? queueCardText(item, o) : answeredCardText(item, o);
  return sha256Hex(`${text}\n${JSON.stringify(open ? queueCardKeyboard(item, consoleUrl) : null)}`);
}

export class CardPoster {
  private readonly runs = new Map<string, Run>();
  // The last failure logged per item: the same failure every tick logs once.
  private readonly logged = new Map<string, string>();
  // Per postFailed item: failures in a row and when the last one was.
  private readonly backoff = new Map<string, { fails: number; at: number }>();
  // Per item: message ids sent whose record write failed (cleared once recorded).
  private readonly unrecorded = new Map<string, Unrecorded>();
  private readonly now: () => number;
  private readonly log: (s: string) => void;

  constructor(private readonly d: CardPosterDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
  }

  // From the hub `queue` event. Never throws. Skips a postFailed item: only
  // the tick retries it, so the item's own postFailed write cannot loop.
  onItem(item: QueueItem): void {
    try {
      if (this.runs.has(item.id) || this.needsSync(item, false)) void this.schedule(item.id, false).catch((e) => this.log(`[chief] card poster: ${item.id} failed: ${errText(e)}`));
    } catch (e) {
      this.log(`[chief] card poster: event for ${String(item?.id)} failed: ${errText(e)}`);
    }
  }

  // The auto-answer one-liner with [Undo] (spec §5.6): posted once, its id
  // stored on the item and in the card index. Nothing when CHIEF_TELEGRAM_AUTO
  // is 0 or the item is no longer `auto`. Never throws; a failed send is logged.
  async postAuto(item: QueueItem): Promise<void> {
    try {
      if (!this.d.telegramAuto) return;
      await this.schedule(item.id, false, true);
    } catch (e) {
      this.log(`[chief] card poster: auto line for ${String(item?.id)} failed: ${errText(e)}`);
    }
  }

  // Posts every open item without a card (never posted, or postFailed once
  // its backoff is over), oldest first (createdAt, then id; store.list is
  // readdir order), within MESSAGES_PER_TICK messages a tick: the first post
  // that sends anything always goes (a 10-image preview costs 11), and once a
  // post does not fit, no later one goes this tick. Re-syncs every card whose
  // stored hash is stale and clears the keyboard of an auto line that is done.
  // Each item's run starts without waiting for the previous one (a hung
  // Telegram call must not stop the others); the per-item serialization
  // stays, and a run still going takes no budget. Never throws.
  async tick(): Promise<void> {
    let items: QueueItem[];
    try { items = await this.d.store.list(); } catch (e) {
      this.log(`[chief] card poster: tick failed: ${errText(e)}`);
      return;
    }
    items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let spent = 0;
    let full = false;
    for (const item of items) {
      try {
        this.dropClosed(item);
        if (!this.needsSync(item, true)) {
          this.backoff.delete(item.id);
          continue;
        }
        if (this.newPost(item)) {
          if (item.telegram?.postFailed === true && !this.retryDue(item.id)) continue;
          if (!this.runs.has(item.id)) {
            const cost = this.postCost(item);
            if (full || (spent > 0 && spent + cost > MESSAGES_PER_TICK)) {
              full = true;
              continue;
            }
            spent += cost;
          }
        }
        void this.schedule(item.id, true).catch((e) => this.log(`[chief] card poster: ${item.id} failed: ${errText(e)}`));
      } catch (e) {
        this.log(`[chief] card poster: tick on ${item.id} failed: ${errText(e)}`);
      }
    }
  }

  // tick() at once (boot), then every tickMs; a tick still running skips the
  // next one. The timer does not keep the process alive. Returns stop.
  start(): () => void {
    let busy = false;
    const run = (): void => {
      if (busy) return;
      busy = true;
      this.tick()
        .catch((e) => this.log(`[chief] card poster: tick failed: ${errText(e)}`))
        .finally(() => { busy = false; });
    };
    run();
    const timer = setInterval(run, this.d.tickMs ?? TICK_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // Resolves once no item sync is running (tests, shutdown).
  async idle(): Promise<void> {
    while (this.runs.size > 0) await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  private needsSync(item: QueueItem, retry: boolean): boolean {
    return this.needsCard(item, retry) || this.needsClear(item);
  }

  // An auto line posted, not yet cleared, and its [Undo] can no longer work:
  // the item left `auto`, or its undo window closed (closedAt).
  private needsClear(item: QueueItem): boolean {
    const t = item.telegram;
    return t?.autoMessageId !== undefined && t.autoCleared !== true && autoLineDone(item);
  }

  // A postFailed item may be posted again: always after one failure (the
  // next tick is the 30 s wait), else once the doubled wait has passed, less
  // half a tick (a tick that runs a little early still counts).
  private retryDue(id: string): boolean {
    const b = this.backoff.get(id);
    if (!b || b.fails <= 1) return true;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (b.fails - 1), RETRY_MAX_MS);
    return this.now() >= b.at + wait - (this.d.tickMs ?? TICK_MS) / 2;
  }

  private needsCard(item: QueueItem, retry: boolean): boolean {
    const t = item.telegram;
    if (t?.cardMessageId === undefined) return this.newPost(item) && (retry || t?.postFailed !== true);
    return cardRenderHash(item, this.d.consoleUrl, this.d.ruleText) !== t.renderHash;
  }

  // No card recorded yet: an open item, or any item whose sent card is still
  // kept in memory (answered before its id was recorded: recorded, then edited).
  private newPost(item: QueueItem): boolean {
    return item.telegram?.cardMessageId === undefined
      && (item.status === "open" || this.unrecorded.get(item.id)?.card !== undefined);
  }

  // The messages a post sends: its card (none when a sent card is kept) plus
  // the images not posted yet.
  private postCost(item: QueueItem): number {
    const kept = this.unrecorded.get(item.id);
    if (kept?.card) return 0;
    return 1 + (kept?.mediaIds ? 0 : this.imagesToSend(item).length);
  }

  // The images of a preview item, or of a pr item with screenshots (overview
  // decision 65), still to post: none once their ids are stored or mediaFailed
  // is set.
  private imagesToSend(item: QueueItem): string[] {
    const t = item.telegram;
    if (!hasImages(item) || t?.mediaMessageIds?.length || t?.mediaFailed === true) return [];
    return (item.preview?.images ?? []).slice(0, MEDIA_MAX);
  }

  // Kept media ids of a closed item (closedAt: it never opens again) can
  // never be recorded, as no card is posted for it: drop them. A kept card is
  // still recorded (post), then edited. A snoozed item, or one answered within
  // its undo window, can be open again: its ids stay (no second image set).
  private dropClosed(item: QueueItem): void {
    const kept = this.unrecorded.get(item.id);
    if (kept && !kept.card && item.closedAt !== undefined) this.unrecorded.delete(item.id);
  }

  // Closed more than SETTLED_MS ago: the card shows its final state.
  private settled(item: QueueItem): boolean {
    return item.closedAt !== undefined && this.now() - item.closedAt > SETTLED_MS;
  }

  // Serializes the poster's work per item, outside the item lock: an event
  // during a pass asks for one more pass instead of a second concurrent one,
  // so two events in a row never post two cards or race two edits.
  private schedule(id: string, retry: boolean, auto = false): Promise<void> {
    const cur = this.runs.get(id);
    if (cur) {
      cur.again = true;
      cur.retry ||= retry;
      cur.auto ||= auto;
      return cur.done;
    }
    const run: Run = { again: true, retry, auto, done: Promise.resolve() };
    this.runs.set(id, run);
    run.done = (async () => {
      try {
        while (run.again) {
          const r = run.retry;
          const a = run.auto;
          run.again = false;
          run.retry = false;
          run.auto = false;
          try { await this.sync(id, r, a); } catch (e) {
            this.log(`[chief] card poster: ${id} failed: ${errText(e)}`);
          }
        }
      } finally {
        this.runs.delete(id);
      }
    })();
    return run.done;
  }

  // One pass on the item as it is on disk now.
  private async sync(id: string, retry: boolean, auto: boolean): Promise<void> {
    const item = await this.d.store.get(id);
    if (!item) {
      this.unrecorded.delete(id);
      return;
    }
    this.dropClosed(item);
    if (this.needsCard(item, retry)) {
      const cardId = item.telegram?.cardMessageId;
      if (cardId === undefined) await this.post(item);
      else if (this.settled(item)) await this.recordHash(id, cardId, cardRenderHash(item, this.d.consoleUrl, this.d.ruleText));
      else await this.edit(item, cardId);
    }
    if (auto) {
      const cur = await this.d.store.get(id);
      if (cur) await this.sendAuto(cur);
    }
    const last = await this.d.store.get(id);
    if (last && this.needsClear(last)) await this.clearAuto(last, last.telegram!.autoMessageId!);
  }

  private async sendAuto(item: QueueItem): Promise<void> {
    if (!this.d.telegramAuto || item.status !== "auto" || item.answer?.by !== "master") return;
    if (item.telegram?.autoMessageId !== undefined) return;
    try {
      const sent = await this.d.tg.sendMessage(this.d.cfg.chatId, autoLineText(item),
        { threadId: this.d.cfg.threadId, keyboard: autoKeyboard(item) });
      this.d.cards.addItem(sent.message_id, item.id);
      // Stored even if the item left `auto` meanwhile: the clear pass needs the id.
      this.logged.delete(item.id);
      await this.record(item.id, (c) => {
        const t: Tg = { ...c.telegram, autoMessageId: sent.message_id,
          extraMessageIds: [...new Set([...(c.telegram?.extraMessageIds ?? []), sent.message_id])] };
        delete t.autoCleared;
        return t;
      });
    } catch (e) {
      this.logOnce(item.id, `auto line failed: ${errText(e)}`);
    }
  }

  // Removes the auto line's keyboard once. A failure is logged; the tick retries.
  private async clearAuto(item: QueueItem, msgId: number): Promise<void> {
    try {
      await this.d.tg.editMessageReplyMarkup(this.d.cfg.chatId, msgId);
    } catch (e) {
      if (!(e instanceof TelegramError && e.status === 400 && CLEARED.test(e.description))) {
        this.logOnce(item.id, `clearing auto line ${msgId} failed: ${errText(e)}`);
        return;
      }
    }
    this.logged.delete(item.id);
    await this.record(item.id, (c) =>
      (c.telegram?.autoMessageId === msgId && autoLineDone(c) && !c.telegram.autoCleared ? { ...c.telegram, autoCleared: true } : null));
  }

  private async post(first: QueueItem): Promise<void> {
    const id = first.id;
    let item = first;
    try {
      let card = this.unrecorded.get(id)?.card;
      if (!card) {
        let refusedWhy: string | undefined;
        let keptMedia = this.unrecorded.get(id)?.mediaIds;
        if (item.telegram?.mediaMessageIds?.length) keptMedia = undefined;
        const images = this.imagesToSend(item);
        if (keptMedia || images.length > 0) {
          const sent: MediaSent = keptMedia ? { ids: keptMedia } : await this.sendMedia(item, images);
          let cur: QueueItem | null;
          if ("refused" in sent) {
            // Nothing stored: mediaFailed goes with the card (below); if the
            // card fails too, the next attempt sends the images again.
            refusedWhy = sent.refused;
            cur = await this.d.store.get(id);
          } else {
            if ("ids" in sent) this.unrecorded.set(id, { mediaIds: sent.ids });
            // Media first, and its ids (or mediaFailed for a file that cannot
            // be read) stored at once: a card failure after this point
            // retries only the card (Review Focus 2).
            cur = await this.record(id, (c) => ("ids" in sent ? { ...c.telegram, mediaMessageIds: sent.ids } : { ...c.telegram, mediaFailed: true }));
            this.unrecorded.delete(id);
          }
          // Answered, snoozed or gone meanwhile: no card now (an item snoozed
          // before its card gets it, media kept, when it is open again).
          if (!cur || cur.status !== "open" || cur.telegram?.cardMessageId !== undefined) return;
          item = cur;
        }
        // A card sent after refused images says where they are (mediaFailed).
        const shown: QueueItem = refusedWhy === undefined ? item : { ...item, telegram: { ...item.telegram, mediaFailed: true } };
        // The hash of what is sent: if the item changes during the call, its
        // event asks for another pass, which edits the card.
        const renderHash = cardRenderHash(shown, this.d.consoleUrl, this.d.ruleText);
        const msg = await this.sendCard(shown);
        card = { messageId: msg.message_id, renderHash, mediaFailed: refusedWhy !== undefined };
        this.unrecorded.set(id, { card });
        this.d.cards.addItem(msg.message_id, id);
        if (refusedWhy !== undefined) this.logOnce(id, `images refused, the card went without them: ${refusedWhy}`);
      }
      const { messageId, renderHash, mediaFailed } = card;
      await this.record(id, (c) => {
        const t: Tg = { ...c.telegram, cardMessageId: messageId, renderHash };
        if (mediaFailed) t.mediaFailed = true;
        delete t.postFailed;
        return t;
      });
      this.unrecorded.delete(id);
      this.logged.delete(id);
      this.backoff.delete(id);
    } catch (e) {
      this.backoff.set(id, { fails: (this.backoff.get(id)?.fails ?? 0) + 1, at: this.now() });
      this.logOnce(id, `post failed: ${errText(e)}`);
      await this.record(id, (c) => (c.telegram?.postFailed ? null : { ...c.telegram, postFailed: true }));
    }
  }

  // The posted images' ids; `unreadable` when a file cannot be read (logged
  // once; mediaFailed at once, not a Telegram fault); `refused` when Telegram
  // refused the request (a 4xx other than 429). Any other failure throws: the
  // tick posts the images again.
  private async sendMedia(item: QueueItem, images: string[]): Promise<MediaSent> {
    const { chatId, threadId } = this.d.cfg;
    let files: TgFile[];
    try {
      files = await Promise.all(images.map(async (name) =>
        ({ data: await this.d.readMedia(item, name), filename: name, mime: mimeOf(name) })));
    } catch (e) {
      this.logOnce(item.id, `images not read, the card goes without them: ${errText(e)}`);
      return { unreadable: true };
    }
    let ids: number[];
    try {
      ids = files.length === 1
        ? [(await this.d.tg.sendPhoto(chatId, files[0], { threadId })).message_id]
        : (await this.d.tg.sendMediaGroup(chatId, files, { threadId })).map((m) => m.message_id);
    } catch (e) {
      if (!refused(e)) throw e;
      return { refused: errText(e) };
    }
    for (const m of ids) this.d.cards.addItem(m, item.id);
    return { ids };
  }

  // The card. Telegram refuses some URLs in a button (a 4xx other than 429):
  // the card is then sent once more at once with its callback buttons only.
  private async sendCard(item: QueueItem): Promise<TgMessage> {
    const { chatId, threadId } = this.d.cfg;
    const text = queueCardText(item, { now: this.now(), ruleText: this.d.ruleText, consoleUrl: this.d.consoleUrl });
    const keyboard = queueCardKeyboard(item, this.d.consoleUrl);
    try {
      return await this.d.tg.sendMessage(chatId, text, { threadId, keyboard });
    } catch (e) {
      const bare = withoutUrlButtons(keyboard);
      if (!bare || !refused(e)) throw e;
      this.logOnce(item.id, `card refused (${errText(e)}); sent without its link buttons`);
      return await this.d.tg.sendMessage(chatId, text, { threadId, keyboard: bare });
    }
  }

  private async edit(item: QueueItem, cardId: number): Promise<void> {
    const open = showsButtons(item);
    const o = { now: this.now(), ruleText: this.d.ruleText, consoleUrl: this.d.consoleUrl };
    const text = open ? queueCardText(item, o) : answeredCardText(item, o);
    const keyboard = open ? queueCardKeyboard(item, this.d.consoleUrl) : undefined;
    const renderHash = cardRenderHash(item, this.d.consoleUrl, this.d.ruleText);
    try {
      try {
        // The client resolves a 400 "message is not modified": that is success.
        await this.d.tg.editMessageText(this.d.cfg.chatId, cardId, text, keyboard);
        this.logged.delete(item.id);
      } catch (e) {
        // A URL Telegram refuses in a button (a 400): the edit once more at
        // once with the callback buttons only (as sendCard). "Not modified"
        // and a card that is gone keep their handling below; any other 4xx is
        // an auth or config fault, not the button. The line is logged only
        // once the retry goes, and kept, so the same refusal logs once per
        // item; a failed retry leaves one stable line to the catch below.
        const bare = keyboard && withoutUrlButtons(keyboard);
        if (!bare || !(e instanceof TelegramError && e.status === 400) || CLEARED.test(e.description)) throw e;
        await this.d.tg.editMessageText(this.d.cfg.chatId, cardId, text, bare);
        this.logOnce(item.id, `card ${cardId} refused (${errText(e)}); edited without its link buttons`);
      }
    } catch (e) {
      // Any other error leaves the hash stale: the tick retries the edit.
      if (!(e instanceof TelegramError && e.status === 400 && GONE.test(e.description))) {
        this.logOnce(item.id, `edit of card ${cardId} failed: ${errText(e)}`);
        return;
      }
      // Gone: store the hash so the tick stops; the next change tries again.
      this.logOnce(item.id, `card ${cardId} is gone (${e.description}); not edited until the item changes`);
    }
    await this.recordHash(item.id, cardId, renderHash);
  }

  private async recordHash(id: string, cardId: number, renderHash: string): Promise<void> {
    await this.record(id, (c) =>
      (c.telegram?.cardMessageId === cardId && c.telegram.renderHash !== renderHash ? { ...c.telegram, renderHash } : null));
  }

  // Under the item lock: re-read the item and write `next(item)` as its
  // telegram field; null writes nothing. The write is a hub `queue` event.
  private record(id: string, next: (cur: QueueItem) => Tg | null): Promise<QueueItem | null> {
    return this.d.store.withItem(id, async () => {
      const cur = await this.d.store.get(id);
      if (!cur) return null;
      const t = next(cur);
      if (!t) return cur;
      const item: QueueItem = { ...cur, telegram: t };
      await this.d.store.write(item);
      return item;
    });
  }

  private logOnce(id: string, why: string): void {
    if (this.logged.get(id) === why) return;
    this.logged.set(id, why);
    this.log(`[chief] card ${id}: ${why}`);
  }
}
