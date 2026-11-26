// server/chief/queue/sections.ts — the Queue tab's section predicates (spec
// §8b), shared by the header counts (api.ts queueCounts) and the client's
// sections(). Pure; the Next client imports it, so: types only, no runtime imports.
import type { Delivery, QueueItem } from "./types.js";

export const AUTO_RECENT_MS = 10 * 60_000;
export const GONE_MS = 24 * 60 * 60_000;

export const isStuck = (s: Delivery | undefined): boolean => s?.state === "failed" || s?.state === "unknown";
// Withdrawn because its agent record is gone (decision 37): no line goes out for it again.
export const isAgentGone = (i: QueueItem): boolean => i.status === "withdrawn" && i.lastError === "agent-gone";
// An answer or withdrawal slot is stuck, and a line may still go out for the item: every item but
// an agent-gone one. A withdrawal of an item withdrawn otherwise (merged, closed, by its agent or
// the user) still matters (§5.6 "when in doubt withdraw"), so it stays actionable.
// The merged notice of a pr item (overview decision 60) that waits for its agent: the PR is
// merged, the agent has no session, and the line goes out by itself when the agent comes back
// (the `not-live` retry). Nothing here needs the user, so it is not shown as undelivered.
const isWaitingNotice = (i: QueueItem): boolean => i.status === "withdrawn" && i.lastError === "merged" && !i.answer
  && i.delivery?.state === "failed" && i.delivery.lastError === "not-live";
// The answer slot is stuck and the user can act on it.
export const isStuckAnswer = (i: QueueItem): boolean => isStuck(i.delivery) && !isWaitingNotice(i);
export const isUndelivered = (i: QueueItem): boolean => !isAgentGone(i) && (isStuckAnswer(i) || isStuck(i.withdrawal));
export const isRecentAuto = (i: QueueItem, now: number): boolean =>
  i.status === "auto" && i.answer !== undefined && now - i.answer.at < AUTO_RECENT_MS;
export const isGone = (i: QueueItem, now: number): boolean =>
  isAgentGone(i) && i.closedAt !== undefined && now - i.closedAt < GONE_MS;
