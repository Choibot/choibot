import { describe, it, expect } from "vitest";
import {
  keysOutcome, optionsLayout, outcomeNote, primaryOption, screenLines, UNKNOWN_KEYS, type PromptState,
} from "./prompt";

const opt = (label: string) => ({ label, keys: ["enter" as const] });
const prompt = (over: Partial<PromptState>): PromptState => ({
  kind: "picker", question: "Do you want to proceed?", options: [opt("Yes"), opt("No")], selected: 0, screenText: "", rev: "abc", ...over,
});

describe("keysOutcome", () => {
  it("reads each answer of the keys route", () => {
    expect(keysOutcome(200, { sent: true })).toEqual({ kind: "sent" });
    expect(keysOutcome(404, { reason: "agent-gone" })).toEqual({ kind: "gone" });
    expect(keysOutcome(409, { reason: "not-live" })).toEqual({ kind: "not-live" });
    expect(keysOutcome(400, { error: "key not allowed: left" })).toEqual({ kind: "failed", status: 400 });
    expect(keysOutcome(403, { error: "pair-required" })).toEqual({ kind: "failed", status: 403 });
    expect(keysOutcome(500, null)).toEqual({ kind: "failed", status: 500 });
  });
  it("gives the prompt that shows now on a stale card", () => {
    const now = prompt({ rev: "new", selected: 1 });
    expect(keysOutcome(409, { reason: "stale", prompt: now })).toEqual({ kind: "stale", prompt: now });
    expect(keysOutcome(409, { reason: "stale", prompt: null })).toEqual({ kind: "stale", prompt: null });
    expect(keysOutcome(409, { reason: "stale" })).toEqual({ kind: "stale", prompt: null });
  });
});

describe("outcomeNote", () => {
  it("says nothing when the keys went through", () => {
    expect(outcomeNote({ kind: "sent" })).toBeNull();
  });
  it("tells a changed prompt from one that is gone", () => {
    expect(outcomeNote({ kind: "stale", prompt: prompt({}) })).toMatch(/changed/);
    expect(outcomeNote({ kind: "stale", prompt: null })).toMatch(/gone/);
    expect(outcomeNote({ kind: "not-live" })).toMatch(/no live terminal/);
    expect(outcomeNote({ kind: "failed", status: 403 })).toMatch(/Not allowed/);
    expect(outcomeNote({ kind: "failed", status: 0 })).toMatch(/not sent/);
  });
});

describe("primaryOption", () => {
  it("is the yes answer of the trust dialog, wherever it is in the list", () => {
    expect(primaryOption(prompt({ kind: "folder-trust", options: [opt("No, exit"), opt("Yes, I trust this folder")] }))).toBe(1);
    expect(primaryOption(prompt({ kind: "folder-trust", options: [opt("Yes, I trust this folder"), opt("No, exit")] }))).toBe(0);
  });
  it("is the first yes of a permission dialog", () => {
    expect(primaryOption(prompt({ options: [opt("Yes"), opt("Yes, and don't ask again for git commands"), opt("No")] }))).toBe(0);
  });
  it("is none for equal choices and for an unknown prompt", () => {
    expect(primaryOption(prompt({ kind: "login-method", options: [opt("Claude account with subscription"), opt("Anthropic Console account")] }))).toBeNull();
    expect(primaryOption(prompt({ options: [opt("Default (recommended)"), opt("Opus"), opt("Yesterday's model")] }))).toBeNull();
    expect(primaryOption(prompt({ kind: "unknown", options: [] }))).toBeNull();
  });
});

describe("optionsLayout", () => {
  it("puts up to three short answers in a row", () => {
    expect(optionsLayout(prompt({}))).toBe("row");
    expect(optionsLayout(prompt({ options: [opt("No, exit"), opt("Yes, I trust this folder")] }))).toBe("row");
  });
  it("puts long or many answers in a column", () => {
    expect(optionsLayout(prompt({ options: [opt("Yes"), opt("Yes, and don't ask again for git commands in this folder"), opt("No")] }))).toBe("column");
    expect(optionsLayout(prompt({ options: [opt("a"), opt("b"), opt("c"), opt("d")] }))).toBe("column");
  });
});

describe("screenLines", () => {
  it("marks the line the pointer is on", () => {
    const got = screenLines(" Select login method:\n ❯ 1. Claude account\n   2. Console account\n│ ❯ boxed");
    expect(got.map((l) => l.pointed)).toEqual([false, true, false, true]);
    expect(got[1].text).toBe(" ❯ 1. Claude account");
  });
  it("does not mark a pointer inside a line", () => {
    expect(screenLines("text with ❯ inside")[0].pointed).toBe(false);
  });
});

describe("UNKNOWN_KEYS", () => {
  it("is Up, Down, Enter, Esc", () => {
    expect(UNKNOWN_KEYS.map((k) => k.key)).toEqual(["up", "down", "enter", "esc"]);
  });
});
