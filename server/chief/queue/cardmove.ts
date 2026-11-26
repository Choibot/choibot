// server/chief/queue/cardmove.ts — the ticket cards live in ONE Telegram chat: the fleet master
// chat, or the user's private chat with the bot while there is no fleet master chat. A card id
// on an item (telegram.cardMessageId) says nothing of its chat, so when the chat changes (the
// user connected or disconnected the fleet master chat; the console then starts again), the open
// items forget their cards and the poster posts them again in the chat of now.
//
// A small marker file says "the cards are in the private chat of this account". It exists only
// on a console that had its cards there, and it is used only to see a change (it binds nothing).
// A console with a fleet master chat and no marker (the owner's console) is not touched: nothing
// is read but the marker's absence, and nothing is written.
import { rm } from "node:fs/promises";
import type { TelegramClient } from "../../issues/telegram.js";
import type { CardChat } from "../../master/telegram.js";
import { readJson, writeJson } from "../files.js";
import { cardIdsOf } from "./cards.js";
import type { QueueStore } from "./store.js";

export const MOVED_TEXT = "This ticket moved to another chat. Answer it there.";

const privateChatOf = (raw: unknown): number | null => {
  const id = raw && typeof raw === "object" ? (raw as { privateChat?: unknown }).privateChat : null;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
};

// Runs before the card index loads and before the poster starts. Returns the number of open
// items that forgot their cards. Never throws: a failure is logged, and the cards stay as they are.
export async function moveCards(d: {
  store: Pick<QueueStore, "list" | "get" | "withItem" | "write">;
  // <chief data>/cards-chat.json
  marker: string;
  chat: CardChat;
  // To take the buttons off a card left in a private chat (best effort).
  tg?: Pick<TelegramClient, "editMessageText">;
  log?: (s: string) => void;
}): Promise<number> {
  const log = d.log ?? ((s: string) => console.warn(s));
  try {
    // The private chat the cards are in now, and the one they were in (null: a fleet master chat).
    const now = d.chat.threadId === undefined ? d.chat.chatId : null;
    const was = privateChatOf(await readJson<unknown>(d.marker).catch(() => null));
    if (now === was) return 0;
    let moved = 0;
    for (const item of await d.store.list()) {
      // A closed item keeps its card: it shows the outcome, and nobody taps it.
      if ((item.status !== "open" && item.status !== "snoozed") || cardIdsOf(item).length === 0) continue;
      const old = item.telegram?.cardMessageId;
      await d.store.withItem(item.id, async () => {
        const cur = await d.store.get(item.id);
        if (cur?.telegram) await d.store.write({ ...cur, telegram: undefined });
      });
      moved++;
      // The card left in the old private chat loses its buttons.
      if (was !== null && old !== undefined && d.tg) void d.tg.editMessageText(was, old, MOVED_TEXT).catch(() => {});
    }
    if (now !== null) await writeJson(d.marker, { privateChat: now });
    else await rm(d.marker, { force: true });
    if (moved) log(`[chief] ticket cards: ${moved} open item(s) get a new card in ${now !== null ? "the private chat" : "the fleet master chat"}`);
    return moved;
  } catch (e) {
    log(`[chief] ticket cards: the move failed: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}
