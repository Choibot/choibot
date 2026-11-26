// src/lib/queueGuard.ts — pure guards for the Queue tab: a keystroke or a focus change must
// never turn into an answer the user did not intend. No React, no DOM access.
import { isTypingTarget, type QueueAction } from "./useQueueKeys";

// ---- hold: the reply box vanished under the user's fingers (I1) ----
// The focused item left Open (answered elsewhere, withdrawn, a refetch) while the user typed in
// its reply box: the box unmounts and the next letters would reach the list as shortcuts on the
// newly focused item. A hold pauses those actions until Esc, a click, or HOLD_QUIET_MS without
// a keystroke. A hold that starts (or runs) while the page is away (another window or browser tab)
// does not lapse there: its quiet window starts only when the user is back (F1).
export const HOLD_QUIET_MS = 1500;
export type Hold = { lastKey: number; away?: true } | null;

const HELD = new Set<QueueAction["t"]>(["approve", "pick", "accept", "snooze", "undo", "changes", "reply", "send", "open", "merge"]);

export const startHold = (now: number, away = false): Hold => (away ? { lastKey: now, away: true } : { lastKey: now });

// One keydown while held: Esc or a quiet gap ends the hold; any other key restarts the window.
// A key during an away hold means the page is in front again: the quiet window starts now.
export function holdOnKey(h: Hold, key: string, now: number): Hold {
  if (!h || key === "Escape") return null;
  if (!h.away && now - h.lastKey >= HOLD_QUIET_MS) return null;
  return { lastKey: now };
}

export const isHeld = (h: Hold, now: number): boolean => !!h && (h.away === true || now - h.lastKey < HOLD_QUIET_MS);

// The page went away (window blur, hidden tab): a running hold waits for the return.
export const holdOnLeave = (h: Hold, now: number): Hold => (h && isHeld(h, now) ? { lastKey: h.lastKey, away: true } : null);

// The user is back: an away hold gets its quiet window from now. Anything else is unchanged.
export const holdOnReturn = (h: Hold, now: number): Hold => (h?.away ? { lastKey: now } : h);

// True when the action must not run now: commits, the reply box focus, opening a link, a voice start.
export function holdBlocks(h: Hold, a: QueueAction, now: number): boolean {
  return isHeld(h, now) && (HELD.has(a.t) || (a.t === "voice" && a.down));
}

// The reply box that held focus is gone from the document.
export const replyLost = (focusedReply: { isConnected: boolean } | null): boolean => !!focusedReply && !focusedReply.isConnected;

type DocLike = { activeElement: unknown; hasFocus(): boolean; visibilityState?: string };

// The page is not in front of the user: a hidden tab, or a window without focus.
export const pageAway = (d: DocLike): boolean => d.visibilityState === "hidden" || !d.hasFocus();

// A blur of the reply box that really ends "the reply box holds focus": the box is still in the
// document, focus went to another element, and the page is in front. A window or browser-tab
// switch also fires blur, but the box stays the document's active element; it must still count as
// focused, so that its removal while the user is away starts a hold (F1). A removal is not a blur.
export const replyBlurEnds = (el: { isConnected: boolean }, d: DocLike): boolean =>
  el.isConnected && d.activeElement !== el && !pageAway(d);

// ---- Enter guard: an answer started in the detail pane (F3) ----
// A click (or Enter / Space on a focused control) in the detail pane answers, snoozes or withdraws
// the item; the control goes and focus moves to the list, where Enter accepts the next item's
// suggestion. An Enter that comes right after is a carry-over (a double press, a second Enter on
// the gone button, a double Enter in the reply box), not a decision on an item the user has not
// seen: accept is ignored for ENTER_GUARD_MS. A move (j/k) or a row click ends the guard.
export const ENTER_GUARD_MS = 1000;
export type EnterGuard = { until: number } | null;
export const startEnterGuard = (now: number): EnterGuard => ({ until: now + ENTER_GUARD_MS });
export const enterGuardBlocks = (g: EnterGuard, a: QueueAction, now: number): boolean => !!g && a.t === "accept" && now < g.until;

// ---- focus: Open changing between empty and non-empty (I4) ----
type FocusLike = { tagName?: string; isContentEditable?: boolean; closest?(s: string): unknown; getClientRects?(): { length: number } };

// The view may pull keyboard focus only from nowhere: null, body, its own root or listbox, or an
// element that is not rendered (a hidden tab's terminal). On its first run after activation it may
// also take focus off a plain control outside (the tab button that opened it, which would swallow
// Enter). Never from a visible typing target or, later, from any visible control (a Brain panel input).
export function mayTakeFocus(active: FocusLike | null, o: { body: unknown; own: unknown[]; firstRun: boolean }): boolean {
  if (!active || active === o.body || o.own.includes(active)) return true;
  if (active.getClientRects && active.getClientRects().length === 0) return true;
  return o.firstRun && !isTypingTarget(active);
}

// ---- shift guard: a ticket card in an agent's thread ----
// The thread moves by itself: a new message, the live line, a card that folds to one line when it
// is answered. A card also changes under the pointer: the master's suggestion arrives and puts
// "Accept suggestion" where "Reply" was. A press that lands just after such a change can hit a
// button the user did not aim at (the next option of a choice, the same button of the next card;
// a double click on a card that folds). An answer from a card is ignored for SHIFT_GUARD_MS after
// that card last moved on the screen without a scroll by the user, or changed its height (a card
// that just appeared counts as moved). The card says so.
export const SHIFT_GUARD_MS = 600;
export const shiftGuardBlocks = (movedAt: number | undefined, now: number): boolean =>
  movedAt !== undefined && now - movedAt < SHIFT_GUARD_MS;

// One card's box on the screen, as last measured, and when it last changed by itself.
export type CardPlace = { top: number; height: number; movedAt: number };
const SHIFT_MIN_PX = 2;

// A new measure of one card. `byUser`: the measure follows a scroll event (the user moved the
// thread; a scroll the view made itself is measured before its event arrives, so it changes
// nothing here). A scroll never changes a height, so a new height always counts. A first
// measure is a card that just appeared.
export function measureCard(prev: CardPlace | undefined, box: { top: number; height: number }, now: number, byUser: boolean): CardPlace {
  const { top, height } = box;
  if (!prev) return { top, height, movedAt: now };
  const grew = Math.abs(height - prev.height) >= SHIFT_MIN_PX;
  const went = !byUser && Math.abs(top - prev.top) >= SHIFT_MIN_PX;
  return { top, height, movedAt: grew || went ? now : prev.movedAt };
}
