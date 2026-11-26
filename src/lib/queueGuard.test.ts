import { describe, expect, it } from "vitest";
import {
  ENTER_GUARD_MS, HOLD_QUIET_MS, SHIFT_GUARD_MS, enterGuardBlocks, holdBlocks, holdOnKey, holdOnLeave, holdOnReturn, isHeld, mayTakeFocus,
  measureCard, pageAway, replyBlurEnds, replyLost, shiftGuardBlocks, startEnterGuard, startHold,
} from "./queueGuard";
import type { QueueAction } from "./useQueueKeys";

const T = 1_000_000;

describe("hold after the reply box vanished (I1)", () => {
  const commits: QueueAction[] = [
    { t: "approve" }, { t: "pick", key: "A" }, { t: "accept" }, { t: "snooze" }, { t: "undo" },
    { t: "changes" }, { t: "reply" }, { t: "send" }, { t: "open" }, { t: "voice", down: true },
  ];
  it("blocks every commit action, reply/changes focus and a voice start while held", () => {
    const h = startHold(T);
    for (const a of commits) expect(holdBlocks(h, a, T + 10), a.t).toBe(true);
  });
  it("lets move, help, cancel, goQueue and a voice stop through", () => {
    const h = startHold(T);
    for (const a of [{ t: "move", by: 1 }, { t: "help" }, { t: "cancel" }, { t: "goQueue" }, { t: "voice", down: false }] as QueueAction[]) {
      expect(holdBlocks(h, a, T + 10), a.t).toBe(false);
    }
  });
  it("blocks nothing without a hold", () => {
    for (const a of commits) expect(holdBlocks(null, a, T)).toBe(false);
  });
  it("each keystroke inside the quiet window keeps the hold and restarts the window", () => {
    let h = startHold(T);
    h = holdOnKey(h, "a", T + 1000);
    expect(h).toEqual({ lastKey: T + 1000 });
    h = holdOnKey(h, "x", T + 2000); // 2 s after the start, 1 s after the last key
    expect(h).toEqual({ lastKey: T + 2000 });
    expect(holdBlocks(h, { t: "approve" }, T + 2000)).toBe(true);
  });
  it("a quiet gap of HOLD_QUIET_MS ends the hold, so that key acts", () => {
    const h = holdOnKey(startHold(T), "a", T + HOLD_QUIET_MS);
    expect(h).toBeNull();
    expect(holdBlocks(h, { t: "approve" }, T + HOLD_QUIET_MS)).toBe(false);
    expect(holdBlocks(startHold(T), { t: "approve" }, T + HOLD_QUIET_MS)).toBe(false); // lapsed even with no key
  });
  it("Esc ends the hold at once", () => {
    expect(holdOnKey(startHold(T), "Escape", T + 1)).toBeNull();
  });
  it("no hold stays no hold on a key", () => {
    expect(holdOnKey(null, "a", T)).toBeNull();
  });
});

describe("replyLost", () => {
  it("true only when the reply box that held focus is no longer in the document", () => {
    expect(replyLost(null)).toBe(false);
    expect(replyLost({ isConnected: true })).toBe(false);
    expect(replyLost({ isConnected: false })).toBe(true);
  });
});

describe("mayTakeFocus (I4)", () => {
  const body = { tagName: "BODY" };
  const root = { tagName: "DIV" };
  const list = { tagName: "UL" };
  const ruleInput = { tagName: "INPUT", closest: () => null };
  const brainButton = { tagName: "BUTTON", closest: () => null };
  const tabButton = { tagName: "BUTTON", closest: () => null };
  const o = (firstRun: boolean) => ({ body, own: [root, list, null], firstRun });
  it("takes focus from nowhere: null, body, the view root or its listbox", () => {
    for (const a of [null, body, root, list]) {
      expect(mayTakeFocus(a, o(false))).toBe(true);
      expect(mayTakeFocus(a, o(true))).toBe(true);
    }
  });
  it("never takes focus from a typing target (a Brain rule input), not even on the first run", () => {
    expect(mayTakeFocus(ruleInput, o(false))).toBe(false);
    expect(mayTakeFocus(ruleInput, o(true))).toBe(false);
    expect(mayTakeFocus({ tagName: "TEXTAREA" }, o(true))).toBe(false);
  });
  it("an element that is not rendered (a hidden tab's terminal) counts as nowhere", () => {
    const hiddenXterm = { tagName: "TEXTAREA", closest: () => ({}), getClientRects: () => ({ length: 0 }) };
    const shownInput = { ...ruleInput, getClientRects: () => ({ length: 1 }) };
    expect(mayTakeFocus(hiddenXterm, o(true))).toBe(true);
    expect(mayTakeFocus(hiddenXterm, o(false))).toBe(true);
    expect(mayTakeFocus(shownInput, o(false))).toBe(false);
  });
  it("later Open changes never take focus from a focused button (Brain panel); the first run takes it off the tab button", () => {
    expect(mayTakeFocus(brainButton, o(false))).toBe(false);
    expect(mayTakeFocus(tabButton, o(true))).toBe(true);
  });
});

// ---- Fix round (UI wave 3) ----
const doc = (o: { active?: unknown; focus?: boolean; vis?: string } = {}) =>
  ({ activeElement: o.active ?? null, hasFocus: () => o.focus ?? true, visibilityState: o.vis ?? "visible" });

describe("pageAway", () => {
  it("away when the page is hidden or the window has no focus", () => {
    expect(pageAway(doc())).toBe(false);
    expect(pageAway(doc({ focus: false }))).toBe(true);
    expect(pageAway(doc({ vis: "hidden" }))).toBe(true);
  });
});

describe("replyBlurEnds (F1)", () => {
  const box = { isConnected: true };
  it("a blur to another element of the page ends 'the reply box holds focus'", () => {
    expect(replyBlurEnds(box, doc({ active: { tagName: "BUTTON" } }))).toBe(true);
    expect(replyBlurEnds(box, doc({ active: null }))).toBe(true); // focus to body / nowhere
  });
  it("a window or browser-tab switch does not: the box keeps document focus, the page is away", () => {
    expect(replyBlurEnds(box, doc({ active: box, focus: false }))).toBe(false);
    expect(replyBlurEnds(box, doc({ active: box }))).toBe(false); // activeElement is still the box
    expect(replyBlurEnds(box, doc({ active: { tagName: "BUTTON" }, focus: false }))).toBe(false);
    expect(replyBlurEnds(box, doc({ active: { tagName: "BUTTON" }, vis: "hidden" }))).toBe(false);
  });
  it("a removal is not a blur: it is the hold's case", () => {
    expect(replyBlurEnds({ isConnected: false }, doc({ active: null }))).toBe(false);
  });
});

describe("a hold that starts or runs while the page is away (F1)", () => {
  it("a hold started away never lapses before the return", () => {
    const h = startHold(T, true);
    expect(isHeld(h, T + 10 * 60_000)).toBe(true);
    expect(holdBlocks(h, { t: "accept" }, T + 10 * 60_000)).toBe(true);
  });
  it("the return starts the quiet window: held until HOLD_QUIET_MS after the return", () => {
    const back = T + 60_000;
    const h = holdOnReturn(startHold(T, true), back);
    expect(h).toEqual({ lastKey: back });
    expect(holdBlocks(h, { t: "approve" }, back + HOLD_QUIET_MS - 1)).toBe(true);
    expect(holdBlocks(h, { t: "approve" }, back + HOLD_QUIET_MS)).toBe(false);
  });
  it("a return leaves a hold that is not away (or none) unchanged", () => {
    const h = startHold(T);
    expect(holdOnReturn(h, T + 100)).toBe(h);
    expect(holdOnReturn(null, T)).toBeNull();
  });
  it("Esc ends an away hold; any other key means the page is in front: the quiet window starts", () => {
    expect(holdOnKey(startHold(T, true), "Escape", T + 60_000)).toBeNull();
    expect(holdOnKey(startHold(T, true), "a", T + 60_000)).toEqual({ lastKey: T + 60_000 });
  });
  it("leaving the page turns a running hold into an away hold; a lapsed or no hold stays none", () => {
    const h = holdOnLeave(startHold(T), T + 500);
    expect(isHeld(h, T + 10 * 60_000)).toBe(true);
    expect(holdOnLeave(startHold(T), T + HOLD_QUIET_MS)).toBeNull();
    expect(holdOnLeave(null, T)).toBeNull();
  });
});

describe("Enter guard after an answer from the detail pane (F3)", () => {
  it("blocks only accept (Enter) for ENTER_GUARD_MS", () => {
    const g = startEnterGuard(T);
    expect(enterGuardBlocks(g, { t: "accept" }, T + 1)).toBe(true);
    expect(enterGuardBlocks(g, { t: "accept" }, T + ENTER_GUARD_MS - 1)).toBe(true);
    expect(enterGuardBlocks(g, { t: "accept" }, T + ENTER_GUARD_MS)).toBe(false);
    for (const a of [{ t: "pick", key: "A" }, { t: "approve" }, { t: "move", by: 1 }, { t: "snooze" }, { t: "send" }] as QueueAction[]) {
      expect(enterGuardBlocks(g, a, T + 1), a.t).toBe(false);
    }
    expect(enterGuardBlocks(null, { t: "accept" }, T)).toBe(false);
  });
});

describe("shift guard (ticket cards in a thread)", () => {
  it("blocks an answer just after the card moved, and not later", () => {
    expect(shiftGuardBlocks(undefined, 1000)).toBe(false);
    expect(shiftGuardBlocks(1000, 1000)).toBe(true);
    expect(shiftGuardBlocks(1000, 1000 + SHIFT_GUARD_MS - 1)).toBe(true);
    expect(shiftGuardBlocks(1000, 1000 + SHIFT_GUARD_MS)).toBe(false);
  });
  it("counts a card that just appeared as moved", () => {
    expect(measureCard(undefined, { top: 300, height: 120 }, 5000, false)).toEqual({ top: 300, height: 120, movedAt: 5000 });
    expect(measureCard(undefined, { top: 300, height: 120 }, 5000, true)).toEqual({ top: 300, height: 120, movedAt: 5000 });
  });
  it("marks a move the thread made, and not a scroll by the user or a still card", () => {
    const at = { top: 300, height: 120, movedAt: 1000 };
    expect(measureCard(at, { top: 180, height: 120 }, 5000, false).movedAt).toBe(5000);
    expect(measureCard(at, { top: 180, height: 120 }, 5000, true)).toEqual({ top: 180, height: 120, movedAt: 1000 });
    expect(measureCard(at, { top: 301, height: 121 }, 5000, false)).toEqual({ top: 301, height: 121, movedAt: 1000 });
  });
  it("marks a card whose height changed (a suggestion arrived), also during a scroll", () => {
    const at = { top: 300, height: 120, movedAt: 1000 };
    expect(measureCard(at, { top: 300, height: 150 }, 5000, false).movedAt).toBe(5000);
    expect(measureCard(at, { top: 260, height: 150 }, 5000, true).movedAt).toBe(5000);
  });
});
