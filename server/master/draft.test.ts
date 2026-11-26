import { describe, it, expect } from "vitest";
import { InputTracker, DRAFT_TTL_MS, pressesEnter } from "./draft.js";

function tracker() {
  let t = 1_000_000;
  const tr = new InputTracker(() => t);
  return { tr, advance: (ms: number) => { t += ms; } };
}

describe("InputTracker draft flag", () => {
  it("printable text without Enter is a draft; Enter submits and clears it", () => {
    const { tr } = tracker();
    expect(tr.onInput("hel")).toEqual({ submitted: false });
    expect(tr.hasDraft()).toBe(true);
    expect(tr.onInput("lo\r")).toEqual({ submitted: true });
    expect(tr.hasDraft()).toBe(false);
  });

  it("text typed after a submit in the same chunk is a new draft", () => {
    const { tr } = tracker();
    expect(tr.onInput("a\rb")).toEqual({ submitted: true });
    expect(tr.hasDraft()).toBe(true);
  });

  it("a \\r inside a bracketed paste is not a submit, even across chunks", () => {
    const { tr } = tracker();
    expect(tr.onInput("\x1b[200~line1\rline2")).toEqual({ submitted: false });
    expect(tr.onInput("\rmore\x1b[201~")).toEqual({ submitted: false });
    expect(tr.hasDraft()).toBe(true);
    expect(tr.onInput("\r")).toEqual({ submitted: true });
    expect(tr.hasDraft()).toBe(false);
  });

  it("arrow keys count as input but are not a draft", () => {
    const { tr, advance } = tracker();
    advance(60_000);
    tr.onInput("\x1b[A\x1bOB");
    expect(tr.hasDraft()).toBe(false);
    expect(tr.quietFor(30_000)).toBe(false);
  });

  it("Ctrl+C and Ctrl+U clear the draft (Claude Code empties its input line)", () => {
    const { tr } = tracker();
    tr.onInput("abandoned");
    expect(tr.onInput("\x03")).toEqual({ submitted: false });
    expect(tr.hasDraft()).toBe(false);
    tr.onInput("again");
    tr.onInput("\x15");
    expect(tr.hasDraft()).toBe(false);
    tr.onInput("\x15new");
    expect(tr.hasDraft()).toBe(true);
  });

  it("Ctrl+C inside a bracketed paste does not clear (pasted bytes, not a key)", () => {
    const { tr } = tracker();
    tr.onInput("\x1b[200~text\x03more");
    expect(tr.hasDraft()).toBe(true);
  });

  it("a draft expires after 10 minutes without web input", () => {
    const { tr, advance } = tracker();
    tr.onInput("half a thought");
    advance(DRAFT_TTL_MS - 1);
    expect(tr.hasDraft()).toBe(true);
    advance(1);
    expect(tr.hasDraft()).toBe(false);
  });
});

describe("InputTracker ignores terminal reports (Review Focus 2)", () => {
  it("focus in/out, cursor reports, device attributes and OSC replies set nothing", () => {
    const { tr, advance } = tracker();
    expect(tr.quietFor(30_000)).toBe(true); // never typed
    for (const r of ["\x1b[I", "\x1b[O", "\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b]11;rgb:0000/0000/0000\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP1$r0m\x1b\\", "\x1bP1$r2 q\x1b\\"]) {
      expect(tr.onInput(r)).toEqual({ submitted: false });
    }
    expect(tr.hasDraft()).toBe(false);
    expect(tr.quietFor(30_000)).toBe(true);
    tr.onInput("x");
    advance(29_999);
    tr.onInput("\x1b[O");
    expect(tr.quietFor(30_000)).toBe(false);
    advance(1);
    expect(tr.quietFor(30_000)).toBe(true);
  });
});

describe("pressesEnter", () => {
  it("is true for Enter and false for keys and terminal reports", () => {
    expect(pressesEnter("\r")).toBe(true);
    expect(pressesEnter("fix it\r")).toBe(true);
    expect(pressesEnter("abc")).toBe(false);
    expect(pressesEnter("\x1b[A")).toBe(false);
    expect(pressesEnter("\x1b[I\x1b[24;1R\x1b[?1;2c")).toBe(false);
  });
});
