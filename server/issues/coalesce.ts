// server/issues/coalesce.ts — one user action can arrive as several messages:
// an album (same media_group_id) or a forward followed by a typed comment.
// Hold new-issue messages until 1.5 s after the last one in the chat, then
// merge them into one logical message. A crash inside the window loses at
// most those 1.5 s of input (accepted for v1).
import type { TgMessage, TgPhotoSize } from "./telegram.js";
import { forwardedFromOf, largestPhoto } from "./updates.js";

export type MergedMessage = {
  firstMessageId: number;
  messageIds: number[];
  text: string;              // texts and captions joined with a blank line
  forwardedFrom?: string;
  photos: TgPhotoSize[];     // the largest size of each photo, in message order
};

export function mergeMessages(msgs: TgMessage[]): MergedMessage {
  const sorted = [...msgs].sort((a, b) => a.message_id - b.message_id);
  const texts = sorted.map((m) => (m.text ?? m.caption ?? "").trim()).filter(Boolean);
  const photos = sorted.map((m) => largestPhoto(m.photo)).filter((p): p is TgPhotoSize => !!p);
  const forwardedFrom = sorted.map((m) => forwardedFromOf(m.forward_origin)).find(Boolean);
  return {
    firstMessageId: sorted[0].message_id,
    messageIds: sorted.map((m) => m.message_id),
    text: texts.join("\n\n"),
    ...(forwardedFrom ? { forwardedFrom } : {}),
    photos,
  };
}

export type Timer = { clear: () => void };

const WINDOW_MS = 1500;

export class Coalescer {
  private pending = new Map<number, { msgs: TgMessage[]; timer: Timer }>();
  private stopped = false;
  private setTimer: (fn: () => void, ms: number) => Timer;

  constructor(private opts: {
    onFlush: (m: MergedMessage) => unknown;
    windowMs?: number;
    setTimer?: (fn: () => void, ms: number) => Timer;
  }) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const h = setTimeout(fn, ms);
      return { clear: () => clearTimeout(h) };
    });
  }

  push(msg: TgMessage): void {
    if (this.stopped) return;
    const chat = msg.chat.id;
    const cur = this.pending.get(chat);
    cur?.timer.clear();
    const msgs = [...(cur?.msgs ?? []), msg];
    const timer = this.setTimer(() => this.flush(chat), this.opts.windowMs ?? WINDOW_MS);
    this.pending.set(chat, { msgs, timer });
  }

  // Shutdown: cancel every pending window. A batch still open is dropped —
  // the process is about to exit, so its intake could not finish anyway.
  stop(): void {
    this.stopped = true;
    for (const { timer } of this.pending.values()) timer.clear();
    this.pending.clear();
  }

  private flush(chat: number): void {
    const cur = this.pending.get(chat);
    if (!cur) return;
    this.pending.delete(chat);
    void Promise.resolve()
      .then(() => this.opts.onFlush(mergeMessages(cur.msgs)))
      .catch((e) => console.warn("[issues] intake failed:", e instanceof Error ? e.message : e));
  }
}
