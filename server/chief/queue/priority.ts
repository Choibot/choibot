// server/chief/queue/priority.ts — queue priority score (spec §5.5).
// Pure; the Next client imports it, so: types only, no runtime imports.
import type { QueueItem } from "./types.js";

const BASE: Record<QueueItem["kind"], number> = { question: 40, pr: 35, choice: 30, deploy: 30, limit: 40, preview: 20 };
const AGE_STEP_MS = 10 * 60_000;
const AGE_CAP = 30;

export function score(item: QueueItem, now: number): number {
  let s = BASE[item.kind];
  if (item.blocking) s += 25;
  const pr = item.pr;
  if (pr && "url" in pr) {
    if (pr.checks === "success" && pr.mergeable === "MERGEABLE") s += 10;
    else if (pr.checks === "failure") s -= 15;
  }
  s += Math.min(AGE_CAP, Math.max(0, Math.floor((now - item.createdAt) / AGE_STEP_MS)));
  if (item.recommend) s += 5;
  return s;
}

// Open items, plus snoozed ones whose snoozedUntil has passed.
export function sortOpen(items: QueueItem[], now: number): QueueItem[] {
  return items
    .filter((i) => i.status === "open" || (i.status === "snoozed" && (i.snoozedUntil ?? 0) <= now))
    .map((i) => ({ i, s: score(i, now) }))
    .sort((a, b) => b.s - a.s || a.i.createdAt - b.i.createdAt)
    .map((x) => x.i);
}
