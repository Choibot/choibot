// server/issues/updates.ts — pure helpers over raw Telegram updates.
import type { TgForwardOrigin, TgMessage, TgPhotoSize, TgUpdate } from "./telegram.js";

// Both the sender and the chat must match: the one allowed user, in the bot's
// private chat with them. Everything else — other users, the notification
// group, channels, other update types — is dropped without a reply.
export function isAllowedUpdate(u: TgUpdate, userId: number): boolean {
  if (u.message) return u.message.from?.id === userId && u.message.chat.type === "private";
  if (u.callback_query) {
    return u.callback_query.from.id === userId && u.callback_query.message?.chat.type === "private";
  }
  return false;
}

export function isCommand(m: TgMessage): boolean {
  const first = m.entities?.[0];
  return first?.type === "bot_command" && first.offset === 0;
}

export function forwardedFromOf(o?: TgForwardOrigin): string | undefined {
  if (!o) return undefined;
  switch (o.type) {
    case "user": {
      const name = [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ");
      return name || o.sender_user.username;
    }
    case "hidden_user": return o.sender_user_name;
    case "chat": return o.sender_chat.title;
    case "channel": return o.chat.title;
    default: return undefined;
  }
}

export function largestPhoto(sizes?: TgPhotoSize[]): TgPhotoSize | undefined {
  if (!sizes?.length) return undefined;
  return [...sizes].sort((a, b) => b.width * b.height - a.width * a.height)[0];
}
