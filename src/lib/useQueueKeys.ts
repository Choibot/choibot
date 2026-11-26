import { useEffect, useRef } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only: types.ts has a node:crypto import
import { canAccept } from "./queueDetail";

export type QueueAction =
  | { t: "move"; by: 1 | -1 } | { t: "approve" } | { t: "changes" } | { t: "pick"; key: "A" | "B" | "C" | "D" | "E" | "F" }
  | { t: "reply" } | { t: "accept" } | { t: "send" } | { t: "cancel" } | { t: "undo" } | { t: "snooze" } | { t: "open" }
  | { t: "merge" }
  | { t: "goQueue" } | { t: "help" } | { t: "voice"; down: boolean };

type TypingEl = { tagName?: string; isContentEditable?: boolean; closest?(s: string): unknown };

// Focus inside a terminal, the composer, a form field, contenteditable or an open dropdown owns the keyboard.
export function isTypingTarget(el: TypingEl | null): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.(".xterm, [data-composer], [data-dropdown-open], [contenteditable='true'], [contenteditable='']");
}

function hasHttpUrl(f: QueueItem): boolean {
  return [f.pr && "url" in f.pr ? f.pr.url : undefined, f.preview?.url].some((u) => typeof u === "string" && /^https?:\/\//i.test(u));
}

const PICK = ["A", "B", "C", "D", "E", "F"] as const;

export function keyToAction(key: string, o: {
  inReplyBox: boolean; gPending: boolean; focused?: QueueItem; voiceEnabled?: boolean;
  ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; isComposing: boolean; targetIsButton: boolean;
}): QueueAction | null {
  // Browser and OS shortcuts stay theirs; shift only combines with `?`.
  if (o.ctrl || o.meta || o.alt || o.isComposing) return null;
  if (o.inReplyBox) {
    if (o.shift) return null; // Shift+Enter is a newline
    if (key === "Enter") return { t: "send" };
    if (key === "Escape") return { t: "cancel" };
    return null;
  }
  if (o.shift) return key === "?" ? { t: "help" } : null;
  if (o.gPending) return key === "q" ? { t: "goQueue" } : null;
  const f = o.focused;
  switch (key) {
    case "j": case "ArrowDown": return { t: "move", by: 1 };
    case "k": case "ArrowUp": return { t: "move", by: -1 };
    case "Escape": return { t: "cancel" };
    case "u": return { t: "undo" };
    case "v": return o.voiceEnabled ? { t: "voice", down: true } : null;
    case "?": return { t: "help" };
    case "s": return f ? { t: "snooze" } : null;
    case "a": return f && (f.kind === "pr" || f.kind === "preview") ? { t: "approve" } : null;
    case "c": return f && (f.kind === "pr" || f.kind === "preview") ? { t: "changes" } : null;
    case "r": return f && (f.kind === "choice" || f.kind === "question") ? { t: "reply" } : null;
    case "o": return f && hasHttpUrl(f) ? { t: "open" } : null;
    // `m` opens the Merge confirm step of a pr ticket; it never merges by itself.
    case "m": return f && f.kind === "pr" && !!f.pr && "url" in f.pr ? { t: "merge" } : null;
    case "Enter":
      if (o.targetIsButton || !f) return null;
      return canAccept(f) ? { t: "accept" } : null; // decision 39: one rule with the bar and planAction
    default:
      if (f?.kind === "choice" && /^[1-6]$/.test(key)) {
        const k = PICK[Number(key) - 1];
        return f.choice?.options.some((x) => x.key === k) ? { t: "pick", key: k } : null;
      }
      return null;
  }
}

export type KeyEventLike = {
  key: string; type: "keydown" | "keyup"; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  shiftKey: boolean; isComposing: boolean; keyCode?: number; code?: string; target: TypingEl | null;
};
export type KeyState = {
  onQueueTab: boolean; // the Queue is shown (Agents tab, Queue row; lib/queueRow onQueueRow); elsewhere only `g` then `q` acts
  gPending: boolean; inReplyBox: boolean; focused?: QueueItem; focusedSection?: "open" | "undelivered" | "auto" | "gone";
  voiceEnabled: boolean; voiceActive: boolean; // supported by the browser / a session is running
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

export function handleKey(e: KeyEventLike, s: KeyState): { action: QueueAction | null; preventDefault: boolean; next: KeyState } {
  const none = (next: KeyState) => ({ action: null, preventDefault: false, next });
  const isV = e.key === "v" || e.key === "V";
  // Releasing the V key always stops an active session, whatever has focus now (also the reply
  // textarea) and whatever character it gave (Option+v gives "√").
  if (e.type === "keyup") return s.voiceActive && (isV || e.code === "KeyV") ? { action: { t: "voice", down: false }, preventDefault: false, next: s } : none(s);
  // While a session runs no plain `v` may land in the reply box (Ctrl/Cmd+V still pastes).
  if (s.voiceActive && isV && !e.ctrlKey && !e.metaKey && !e.altKey) return { action: null, preventDefault: true, next: s };
  const reset: KeyState = { ...s, gPending: false };
  if (MODIFIER_KEYS.has(e.key)) return none(s); // a bare modifier must not break `g` then `q`
  const typing = isTypingTarget(e.target);
  const t = e.target;
  const hardBlock = !!t?.closest?.(".xterm, [data-dropdown-open]");
  // Only the reply textarea takes keys from a typing target; derived from the event target, not from state alone.
  const inReplyBox = s.inReplyBox && typing && !hardBlock && !!t?.closest?.("[data-queue-reply]");
  if (typing && !inReplyBox) return none(reset);
  const composing = e.isComposing || e.keyCode === 229; // Safari IME reports keyCode 229
  if (inReplyBox && e.repeat && e.key === "Enter" && !e.shiftKey && !composing) return { action: null, preventDefault: true, next: reset };
  if (e.repeat && !["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return none(reset);
  const isG = e.key === "g" && !s.gPending && !inReplyBox && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !composing;
  if (isG) return { action: null, preventDefault: s.onQueueTab, next: { ...s, gPending: true } };
  let action = keyToAction(e.key, {
    inReplyBox, gPending: s.gPending, focused: s.focused, voiceEnabled: s.voiceEnabled,
    ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, isComposing: composing,
    targetIsButton: (t?.tagName ?? "").toUpperCase() === "BUTTON" || !!t?.closest?.("a[href], summary, [role=button]"),
  });
  if (!s.onQueueTab && action?.t !== "goQueue") action = null;
  if (action?.t === "snooze" && s.focusedSection !== "open") action = null; // snooze applies to Open rows only
  return { action, preventDefault: action !== null, next: reset };
}

// `onKeyDown` sees every keydown first, before its action (the Queue tab's hold counts keystrokes).
export function useQueueKeys(o: { active: boolean; state: () => KeyState; onAction(a: QueueAction): void; onKeyDown?(e: KeyEventLike): void }): void {
  const ref = useRef(o);
  ref.current = o;
  const { active } = o;
  useEffect(() => {
    if (!active) return;
    let gPending = false;
    const onKey = (e: KeyboardEvent) => {
      const cur = ref.current;
      if (e.type === "keydown") cur.onKeyDown?.(e as KeyEventLike);
      const r = handleKey(e as KeyEventLike, { ...cur.state(), gPending });
      gPending = r.next.gPending;
      if (r.preventDefault) e.preventDefault();
      if (r.action) cur.onAction(r.action);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("keyup", onKey); };
  }, [active]);
}
