// src/lib/queueActions.ts — pure routing of a Queue-tab action to the one request it should make
// (body shape per action and kind, readOnly guard, decision-39 guard, Open-row guard), plus the
// Undelivered slot choice. No React, no fetch: QueueView runs the returned plan.
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import { isStuckAnswer } from "../../server/chief/queue/sections";
import { sortOpen } from "../../server/chief/queue/priority";
import type { QueueAction } from "./useQueueKeys";
import { canAccept, githubUrl, replyValue } from "./queueDetail";

export type ActionPlan =
  | { t: "answer"; item: QueueItem; value: string; text?: string; images?: string[]; sent?: true }
  // `a` on a pr item (overview decision 60): no answer. The server reads the PR's state now; it
  // closes the item when the PR is merged, else it gives the reason, which the view shows.
  | { t: "checkPr"; item: QueueItem }
  | { t: "snooze"; item: QueueItem; minutes: number }
  | { t: "open"; url: string }
  // `m` on a pr item with a GitHub PR: the Merge button's confirm step opens (QueueMerge.tsx).
  | { t: "mergeAsk"; item: QueueItem }
  | { t: "focusReply" };

// `images`: the draft names of the reply's images (lib/answerImages); `imagesWait`: one still goes
// up or failed, so the reply is not sent yet.
type Ctx = { focused?: QueueItem; readOnly: boolean; draft: string; snoozeMin: number; now: number; images?: string[]; imagesWait?: boolean };

// An Open row by the list's own rule (sortOpen): open, or snoozed with the snooze ended
// (snoozedUntil <= now; the server answers both). A snoozed item that is not due yet is not.
const isOpen = (i: QueueItem | undefined, now: number): i is QueueItem => !!i && sortOpen([i], now).length === 1;

export function planAction(a: QueueAction, c: Ctx): ActionPlan | null {
  const f = c.focused;
  if (c.readOnly || !isOpen(f, c.now)) return null;
  // The console's own deploy ticket (chief spec §5.7): no key and no reply box ever answers or
  // starts it. Deploy is a button of its own (DeployPanel); here it can only be snoozed.
  if (f.kind === "deploy") return a.t === "snooze" ? { t: "snooze", item: f, minutes: c.snoozeMin } : null;
  switch (a.t) {
    case "approve":
      if (f.kind === "pr") return { t: "checkPr", item: f };
      return f.kind === "preview" ? { t: "answer", item: f, value: "approve" } : null;
    case "pick":
      return f.kind === "choice" && f.choice?.options.some((o) => o.key === a.key) ? { t: "answer", item: f, value: a.key } : null;
    case "accept":
      if (!canAccept(f) || !f.recommend) return null; // decision 39 lives in canAccept
      return f.kind === "choice" ? { t: "answer", item: f, value: f.recommend.value } : { t: "answer", item: f, value: "reply", text: f.recommend.value };
    case "snooze":
      return { t: "snooze", item: f, minutes: c.snoozeMin };
    case "open": {
      // The `o` key opens what the "Open PR #n" link opens: the PR on GitHub (a GitHub url only).
      const url = f.pr && "url" in f.pr ? githubUrl(f.pr.url) : f.preview?.url;
      return url ? { t: "open", url } : null;
    }
    case "changes": case "reply":
      return { t: "focusReply" };
    case "merge":
      return f.kind === "pr" && f.pr && "url" in f.pr ? { t: "mergeAsk", item: f } : null;
    case "send": {
      const text = c.draft.trim();
      const images = c.images ?? [];
      if (c.imagesWait || (!text && images.length === 0)) return null;
      return { t: "answer", item: f, value: replyValue(f), ...(text ? { text } : {}), ...(images.length > 0 ? { images } : {}), sent: true };
    }
    default:
      return null;
  }
}

// A stuck answer slot is resent on "answer"; otherwise the stuck slot is the withdrawal.
export const deliverySlot = (i: QueueItem): "answer" | "withdrawal" => (isStuckAnswer(i) ? "answer" : "withdrawal");

const LAST_ERROR_MAX = 120;

// The Undelivered row's state text (spec §5.4 steps 4–5) for the slot Resend acts on: `unknown`
// may already have reached the agent, so Resend can send the line twice; `failed` did not.
export function undeliveredText(i: QueueItem): string {
  const which = deliverySlot(i);
  const slot = which === "answer" ? i.delivery : i.withdrawal;
  const err = slot?.lastError;
  const text = slot?.state === "unknown" ? "may have been delivered — confirm"
    : err === "not-live" ? "undelivered · Resume agent"
    : err ? `undelivered · ${err.length > LAST_ERROR_MAX ? `${err.slice(0, LAST_ERROR_MAX - 1)}…` : err}`
    : "undelivered";
  return which === "withdrawal" ? `withdrawal: ${text}` : text;
}

// Runs an answer plan. A typed reply's draft is cleared only once the server took the answer:
// a 409 (answered elsewhere), a 400 or a network error keeps the text (I2).
export async function runAnswer(
  plan: Extract<ActionPlan, { t: "answer" }>,
  d: { respond(item: QueueItem, value: string, text?: string, images?: string[]): Promise<boolean>; clearDraft(id: string): void },
): Promise<boolean> {
  const ok = await d.respond(plan.item, plan.value, plan.text, plan.images);
  if (ok && plan.sent) d.clearDraft(plan.item.id);
  return ok;
}

// The optimistic item for [Resend] (the stuck slot goes pending) or [Mark delivered] (delivered).
export function optimisticDelivery(i: QueueItem, action: "resend" | "mark-delivered"): QueueItem {
  const state = action === "resend" ? "pending" as const : "delivered" as const;
  return deliverySlot(i) === "answer"
    ? { ...i, delivery: { ...i.delivery!, state } }
    : { ...i, withdrawal: { ...i.withdrawal!, state } };
}
