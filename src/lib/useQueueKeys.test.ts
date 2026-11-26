import { describe, it, expect } from "vitest";
import { handleKey, isTypingTarget, keyToAction, type KeyEventLike, type KeyState } from "./useQueueKeys";
import type { QueueItem } from "../../server/chief/queue/types";

const OPTS = ["A", "B", "C", "D", "E", "F"].map((key) => ({ key, label: key }));
const item = (o: Partial<QueueItem>): QueueItem => ({ id: "q1", kind: "choice", agentId: "worker-1", choice: { options: OPTS }, ...o }) as QueueItem;
const base: KeyState = { onQueueTab: true, gPending: false, inReplyBox: false, focused: item({}), focusedSection: "open", voiceEnabled: false, voiceActive: false };
const body = { tagName: "BODY", closest: () => null };
const ev = (key: string, o: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key, type: "keydown", repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, target: body, ...o,
});
const act = (key: string, s: Partial<KeyState> = {}, o: Partial<KeyEventLike> = {}) => handleKey(ev(key, o), { ...base, ...s }).action;
const rec = { value: "A", why: "", ruleIds: [], by: "x", at: 1 };

describe("key table", () => {
  it("moves", () => {
    expect(act("j")).toEqual({ t: "move", by: 1 });
    expect(act("ArrowDown")).toEqual({ t: "move", by: 1 });
    expect(act("k")).toEqual({ t: "move", by: -1 });
    expect(act("ArrowUp")).toEqual({ t: "move", by: -1 });
  });
  it("approve / changes by kind", () => {
    expect(act("a", { focused: item({ kind: "pr" }) })).toEqual({ t: "approve" });
    expect(act("a", { focused: item({ kind: "preview" }) })).toEqual({ t: "approve" });
    expect(act("a", { focused: item({ kind: "choice" }) })).toBeNull();
    expect(act("c", { focused: item({ kind: "pr" }) })).toEqual({ t: "changes" });
    expect(act("c", { focused: item({ kind: "choice" }) })).toBeNull();
  });
  it("pick 1-6 for choice only", () => {
    expect(["1", "2", "3", "4", "5", "6"].map((k) => act(k))).toEqual(
      ["A", "B", "C", "D", "E", "F"].map((key) => ({ t: "pick", key })));
    expect(act("7")).toBeNull();
    expect(act("1", { focused: item({ kind: "question" }) })).toBeNull();
  });
  it("reply, undo, open, help, snooze", () => {
    expect(act("r", { focused: item({ kind: "question" }) })).toEqual({ t: "reply" });
    expect(act("u")).toEqual({ t: "undo" });
    expect(act("o", { focused: item({ kind: "pr", pr: { url: "https://x/1", number: 1 } }) })).toEqual({ t: "open" });
    expect(act("o", { focused: item({ kind: "choice" }) })).toBeNull();
    expect(act("?", {}, { shiftKey: true })).toEqual({ t: "help" });
    expect(act("s")).toEqual({ t: "snooze" });
    expect(act("s", { focusedSection: "auto" })).toBeNull();
    expect(act("s", { focusedSection: "undelivered" })).toBeNull();
    expect(act("s", { focusedSection: "gone" })).toBeNull();
  });
  it("Escape cancels", () => {
    expect(act("Escape")).toEqual({ t: "cancel" });
  });
  it("unknown key is null", () => {
    expect(act("x")).toBeNull();
  });
});

const replyTa = { tagName: "TEXTAREA", closest: (s: string) => (s.includes("[data-queue-reply]") ? {} : null) };

describe("Enter", () => {
  it("accepts a recommended choice/question with a non-persistent agent", () => {
    expect(act("Enter", { focused: item({ recommend: rec }) })).toEqual({ t: "accept" });
    expect(act("Enter", { focused: item({ kind: "question", recommend: rec }) })).toEqual({ t: "accept" });
  });
  it("no accept without recommend, for pr, or for persistent agents", () => {
    expect(act("Enter", { focused: item({}) })).toBeNull();
    expect(act("Enter", { focused: item({ kind: "pr", recommend: rec }) })).toBeNull();
    expect(act("Enter", { focused: item({ recommend: rec, agentId: "fleet-master" }) })).toBeNull();
    expect(act("Enter", { focused: item({ recommend: rec, agentId: "lead-app-shop" }) })).toBeNull();
  });
  it("null when the target is a button", () => {
    const t = { tagName: "BUTTON", closest: () => null };
    expect(act("Enter", { focused: item({ recommend: rec }) }, { target: t })).toBeNull();
  });
  it("sends in the reply box", () => {
    const t = replyTa;
    expect(act("Enter", { inReplyBox: true }, { target: t })).toEqual({ t: "send" });
    expect(act("Escape", { inReplyBox: true }, { target: t })).toEqual({ t: "cancel" });
    expect(act("j", { inReplyBox: true }, { target: t })).toBeNull();
  });
  it("Shift+Enter is a newline: null, no preventDefault", () => {
    const r = handleKey(ev("Enter", { target: replyTa, shiftKey: true }), { ...base, inReplyBox: true });
    expect(r.action).toBeNull();
    expect(r.preventDefault).toBe(false);
  });
  it("repeated Enter in the reply box: preventDefault, no action", () => {
    const r = handleKey(ev("Enter", { target: replyTa, repeat: true }), { ...base, inReplyBox: true });
    expect(r.action).toBeNull();
    expect(r.preventDefault).toBe(true);
  });
  it("a held Shift+Enter in the reply box is not swallowed (it keeps adding newlines)", () => {
    const r = handleKey(ev("Enter", { target: replyTa, repeat: true, shiftKey: true }), { ...base, inReplyBox: true });
    expect(r.action).toBeNull();
    expect(r.preventDefault).toBe(false);
  });
  it("a composer, plain input or other typing target ignores every key even with inReplyBox", () => {
    const composer = { tagName: "TEXTAREA", closest: (s: string) => (s.includes("[data-composer]") && !s.includes("data-queue-reply") ? {} : null) };
    const input = { tagName: "INPUT", closest: () => null };
    const ce = { tagName: "DIV", isContentEditable: true, closest: () => null };
    for (const target of [composer, input, ce]) {
      for (const k of ["Enter", "Escape"]) {
        const r = handleKey(ev(k, { target }), { ...base, inReplyBox: true });
        expect(r.action).toBeNull();
        expect(r.preventDefault).toBe(false);
      }
    }
  });
  it("IME composition (keyCode 229) in the reply box does not send", () => {
    expect(act("Enter", { inReplyBox: true }, { target: replyTa, keyCode: 229 })).toBeNull();
  });
  it("null on a link, summary or role=button target", () => {
    const t = { tagName: "A", closest: (s: string) => (s.includes("a[href]") ? {} : null) };
    expect(act("Enter", { focused: item({ recommend: rec }) }, { target: t })).toBeNull();
  });
});

describe("g q", () => {
  it("sets pending then fires goQueue and resets", () => {
    const r1 = handleKey(ev("g"), base);
    expect(r1.action).toBeNull();
    expect(r1.next.gPending).toBe(true);
    const r2 = handleKey(ev("q"), r1.next);
    expect(r2.action).toEqual({ t: "goQueue" });
    expect(r2.next.gPending).toBe(false);
  });
  it("other key resets pending", () => {
    const r = handleKey(ev("x"), { ...base, gPending: true });
    expect(r.action).toBeNull();
    expect(r.next.gPending).toBe(false);
  });
  it("q alone does nothing", () => {
    expect(act("q")).toBeNull();
  });
  it("goQueue works with no focused item", () => {
    expect(act("q", { gPending: true, focused: undefined })).toEqual({ t: "goQueue" });
  });
});

describe("modifiers and composition", () => {
  it.each([
    ["a", { metaKey: true }], ["a", { ctrlKey: true }], ["s", { metaKey: true }], ["u", { metaKey: true }],
    ["c", { metaKey: true }], ["1", { ctrlKey: true }], ["j", { altKey: true }],
  ])("%s with %j is null", (k, m) => {
    const r = handleKey(ev(k, m), { ...base, focused: item({ kind: k === "1" ? "choice" : "pr" }) });
    expect(r.action).toBeNull();
    expect(r.preventDefault).toBe(false);
  });
  it("shift+a is null, isComposing is null", () => {
    expect(act("a", { focused: item({ kind: "pr" }) }, { shiftKey: true })).toBeNull();
    expect(act("ArrowDown", {}, { shiftKey: true })).toBeNull();
    expect(act("j", {}, { keyCode: 229 })).toBeNull();
    expect(act("j", {}, { isComposing: true })).toBeNull();
  });
  it("auto-repeat only moves", () => {
    expect(act("Enter", { focused: item({ recommend: rec }) }, { repeat: true })).toBeNull();
    expect(act("j", {}, { repeat: true })).toEqual({ t: "move", by: 1 });
  });
  it("keyup yields no action", () => {
    expect(handleKey(ev("j", { type: "keyup" }), base).action).toBeNull();
  });
  it("preventDefault when an action fires", () => {
    expect(handleKey(ev("j"), base).preventDefault).toBe(true);
    expect(handleKey(ev("x"), base).preventDefault).toBe(false);
  });
});

describe("typing targets", () => {
  const inside = (sel: string) => ({ tagName: "DIV", closest: (s: string) => (s.includes(sel) ? {} : null) });
  it("isTypingTarget", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(body)).toBe(false);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isTypingTarget({ tagName })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget(inside(".xterm"))).toBe(true);
    expect(isTypingTarget(inside("[data-composer]"))).toBe(true);
    expect(isTypingTarget(inside("[data-dropdown-open]"))).toBe(true);
  });
  it("xterm ignores every key including g q, even in reply mode", () => {
    const t = inside(".xterm");
    expect(act("j", {}, { target: t })).toBeNull();
    expect(act("q", { gPending: true }, { target: t })).toBeNull();
    expect(act("Enter", { inReplyBox: true }, { target: t })).toBeNull();
    expect(handleKey(ev("g", { target: t }), base).next.gPending).toBe(false);
  });
  it("textarea ignored outside the reply box, composer and dropdown too", () => {
    const ta = { tagName: "TEXTAREA", closest: () => null };
    expect(act("j", {}, { target: ta })).toBeNull();
    expect(act("q", { gPending: true }, { target: ta })).toBeNull();
    expect(act("j", {}, { target: inside("[data-composer]") })).toBeNull();
    expect(act("j", {}, { target: inside("[data-dropdown-open]") })).toBeNull();
  });
});

describe("keyToAction", () => {
  it("is pure over its options", () => {
    const o = { inReplyBox: false, gPending: false, ctrl: false, meta: false, alt: false, shift: false, isComposing: false, targetIsButton: false };
    expect(keyToAction("j", o)).toEqual({ t: "move", by: 1 });
    expect(keyToAction("j", { ...o, meta: true })).toBeNull();
  });
});

describe("scope outside the Queue tab", () => {
  const off = { ...base, onQueueTab: false };
  it.each(["j", "k", "ArrowDown", "ArrowUp", "Escape", "u", "s", "a", "c", "r", "o", "Enter", "1", "x"])("%s is inert", (k) => {
    const r = handleKey(ev(k), { ...off, focused: item({ kind: "pr", recommend: rec, pr: { url: "https://x/1", number: 1 } }) });
    expect(r.action).toBeNull();
    expect(r.preventDefault).toBe(false);
  });
  it("? is inert", () => {
    expect(handleKey(ev("?", { shiftKey: true }), off).action).toBeNull();
  });
  it("g then q still goes to the queue; g alone does not preventDefault", () => {
    const r1 = handleKey(ev("g"), off);
    expect(r1.preventDefault).toBe(false);
    expect(r1.next.gPending).toBe(true);
    expect(handleKey(ev("q"), r1.next).action).toEqual({ t: "goQueue" });
  });
});

describe("minors", () => {
  it("c also for preview", () => {
    expect(act("c", { focused: item({ kind: "preview" }) })).toEqual({ t: "changes" });
  });
  it("pick only when the choice has that option key", () => {
    const f = item({ choice: { options: OPTS.slice(0, 2) } });
    expect(act("2", { focused: f })).toEqual({ t: "pick", key: "B" });
    expect(act("3", { focused: f })).toBeNull();
    expect(act("1", { focused: item({ choice: undefined }) })).toBeNull();
  });
  it("o needs an http(s) url", () => {
    expect(act("o", { focused: item({ kind: "pr", pr: { url: "https://github.com/a/b/pull/1", number: 1 } }) })).toEqual({ t: "open" });
    expect(act("o", { focused: item({ kind: "preview", preview: { images: [], url: "http://localhost:1" } }) })).toEqual({ t: "open" });
    expect(act("o", { focused: item({ kind: "preview", preview: { images: [] } }) })).toBeNull();
    expect(act("o", { focused: item({ kind: "pr", pr: { url: "javascript:alert(1)", number: 1 } }) })).toBeNull();
  });
  it("r is null on pr/preview and without a focused row; s too", () => {
    expect(act("r", { focused: item({ kind: "pr" }) })).toBeNull();
    expect(act("r", { focused: item({ kind: "preview" }) })).toBeNull();
    expect(act("r", { focused: undefined })).toBeNull();
    expect(act("s", { focused: undefined })).toBeNull();
  });
  it("dropdown target (root has data-dropdown-open) ignores keys", () => {
    const trigger = { tagName: "BUTTON", closest: (s: string) => (s.includes("[data-dropdown-open]") ? {} : null) };
    expect(act("j", {}, { target: trigger })).toBeNull();
  });
});

describe("voice push-to-talk", () => {
  const on = { voiceEnabled: true };
  const xterm = { tagName: "DIV", closest: (s: string) => (s.includes(".xterm") ? {} : null) };
  it("v keydown starts only when voice is supported", () => {
    expect(act("v", on)).toEqual({ t: "voice", down: true });
    expect(act("v")).toBeNull();
  });
  it("is Queue tab only, never in a terminal or other typing target", () => {
    expect(act("v", { ...on, onQueueTab: false })).toBeNull();
    expect(act("v", on, { target: xterm })).toBeNull();
    expect(act("v", on, { target: { tagName: "INPUT", closest: () => null } })).toBeNull();
  });
  it("ignores a repeated keydown, shift and modifiers", () => {
    expect(act("v", on, { repeat: true })).toBeNull();
    expect(act("V", on, { shiftKey: true })).toBeNull();
    expect(act("v", on, { ctrlKey: true })).toBeNull();
  });
  it("v in the reply box does not start a session", () => {
    expect(act("v", { ...on, inReplyBox: true }, { target: replyTa })).toBeNull();
  });
  it("keyup stops an active session, also from the reply box", () => {
    const up = (s: Partial<KeyState>, o: Partial<KeyEventLike> = {}) => handleKey(ev("v", { type: "keyup", ...o }), { ...base, ...on, ...s }).action;
    expect(up({ voiceActive: true })).toEqual({ t: "voice", down: false });
    expect(up({ voiceActive: true, inReplyBox: true }, { target: replyTa })).toEqual({ t: "voice", down: false });
    expect(up({ voiceActive: true }, { key: "V" })).toEqual({ t: "voice", down: false });
    expect(up({ voiceActive: true, onQueueTab: false })).toEqual({ t: "voice", down: false });
    expect(up({ voiceActive: false })).toBeNull();
  });
  it("during a session every v keydown is prevented and starts nothing", () => {
    for (const target of [body, replyTa, xterm]) {
      const r = handleKey(ev("v", { target }), { ...base, ...on, voiceActive: true, inReplyBox: true });
      expect(r.action).toBeNull();
      expect(r.preventDefault).toBe(true);
    }
    const rep = handleKey(ev("v", { repeat: true, target: replyTa }), { ...base, ...on, voiceActive: true, inReplyBox: true });
    expect(rep.preventDefault).toBe(true);
  });
  it("during a session Ctrl/Cmd/Alt+v is not prevented (paste keeps working)", () => {
    for (const m of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      const r = handleKey(ev("v", { target: replyTa, ...m }), { ...base, ...on, voiceActive: true, inReplyBox: true });
      expect(r.preventDefault, JSON.stringify(m)).toBe(false);
      expect(r.action).toBeNull();
    }
  });
  it("keyup of the V key stops a session whatever character it gave (Option+v gives √)", () => {
    const r = handleKey(ev("√", { type: "keyup", code: "KeyV", altKey: true }), { ...base, ...on, voiceActive: true });
    expect(r.action).toEqual({ t: "voice", down: false });
    expect(handleKey(ev("x", { type: "keyup", code: "KeyX" }), { ...base, ...on, voiceActive: true }).action).toBeNull();
  });
});

// `m` opens the Merge confirm step of a pr ticket with a GitHub PR (QueueMerge.tsx); never a merge by itself.
describe("the m key", () => {
  it("maps to merge on a pr ticket with a PR url only", () => {
    expect(act("m", { focused: item({ kind: "pr", pr: { url: "https://github.com/o/r/pull/1", number: 1 } }) })).toEqual({ t: "merge" });
    expect(act("m", { focused: item({ kind: "pr", pr: { local: { repo: "r", branch: "agent/x" } } }) })).toBeNull();
    expect(act("m", { focused: item({ kind: "preview" }) })).toBeNull();
    expect(act("m", { focused: item({ kind: "choice" }) })).toBeNull();
    expect(act("m", { focused: undefined })).toBeNull();
  });
  it("is not a key in the reply box or with a modifier", () => {
    const pr = item({ kind: "pr", pr: { url: "https://github.com/o/r/pull/1", number: 1 } });
    expect(act("m", { focused: pr, inReplyBox: true }, { target: replyTa })).toBeNull();
    expect(act("m", { focused: pr }, { ctrlKey: true })).toBeNull();
    expect(act("m", { focused: pr }, { metaKey: true })).toBeNull();
  });
});
