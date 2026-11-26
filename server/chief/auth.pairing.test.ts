import { afterEach, describe, expect, it, vi } from "vitest";
import { PAIR_TTL_MS, PairingCodes, type PendingPair } from "./auth.js";

type FakeTimer = { fn: () => void; ms: number; cleared: boolean };
function fakeTimers() {
  const timers: FakeTimer[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t: FakeTimer = { fn, ms, cleared: false };
    timers.push(t);
    return { clear: () => { t.cleared = true; } };
  };
  return { timers, setTimer };
}

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const { timers, setTimer } = fakeTimers();
  const expired: PendingPair[] = [];
  const codes = new PairingCodes({ now: clock.now, setTimer, onExpire: (p) => { expired.push(p); } });
  return { clock, timers, expired, codes };
}

// Fire a timer the way setTimeout would: once, and only if it was not cleared.
const fire = (t: FakeTimer): void => { if (!t.cleared) t.fn(); };

afterEach(() => { vi.restoreAllMocks(); });

describe("PairingCodes", () => {
  it("PAIR_TTL_MS is 10 minutes", () => {
    expect(PAIR_TTL_MS).toBe(600_000);
  });

  it("mint returns a 22-char base64url code (16 random bytes) and expiresAt = now + 600 000", () => {
    const { codes, clock, timers } = setup();
    const { code, expiresAt } = codes.mint("laptop");
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(code, "base64url")).toHaveLength(16);
    expect(expiresAt).toBe(clock.now() + 600_000);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(600_000);
  });

  it("mint returns a fresh code each time", () => {
    const { codes } = setup();
    const seen = new Set(Array.from({ length: 50 }, () => codes.mint("laptop").code));
    expect(seen.size).toBe(50);
  });

  it("the first claim returns the pending pair, the second returns null", () => {
    const { codes } = setup();
    const { code, expiresAt } = codes.mint("laptop");
    expect(codes.claim(code)).toEqual({ label: "laptop", expiresAt });
    expect(codes.claim(code)).toBeNull();
  });

  it("an unknown code claims null", () => {
    const { codes } = setup();
    codes.mint("laptop");
    expect(codes.claim("A".repeat(22))).toBeNull();
    expect(codes.claim("")).toBeNull();
  });

  it("a claim after the TTL (now + 600 001 ms) returns null", () => {
    const { codes, clock } = setup();
    const { code } = codes.mint("laptop");
    clock.advance(600_001);
    expect(codes.claim(code)).toBeNull();
  });

  it("a code minted and never claimed is still claimable at minute 9", () => {
    const { codes, clock, expired } = setup();
    const { code } = codes.mint("phone");
    clock.advance(9 * 60_000);
    expect(codes.claim(code)).toMatchObject({ label: "phone" });
    expect(expired).toEqual([]);
  });

  it("the TTL timer fires onExpire with the tg meta set by attachMessage, and the code is gone", () => {
    const { codes, timers, expired } = setup();
    const { code, expiresAt } = codes.mint("laptop");
    expect(codes.attachMessage(code, 4242, 77)).toBe(true);
    fire(timers[0]);
    expect(expired).toEqual([{ label: "laptop", expiresAt, tg: { chatId: 4242, messageId: 77 } }]);
    expect(codes.claim(code)).toBeNull();
  });

  it("the TTL timer fires onExpire without tg meta when no message was attached", () => {
    const { codes, timers, expired } = setup();
    const { code, expiresAt } = codes.mint("laptop");
    fire(timers[0]);
    expect(expired).toEqual([{ label: "laptop", expiresAt }]);
    expect(codes.claim(code)).toBeNull();
  });

  it("claim returns the tg meta set by attachMessage", () => {
    const { codes } = setup();
    const { code } = codes.mint("laptop");
    codes.attachMessage(code, 4242, 77);
    expect(codes.claim(code)).toMatchObject({ label: "laptop", tg: { chatId: 4242, messageId: 77 } });
  });

  it("attachMessage on an unknown code does nothing and returns false", () => {
    const { codes, timers, expired } = setup();
    const { code } = codes.mint("laptop");
    expect(codes.attachMessage("B".repeat(22), 1, 2)).toBe(false);
    fire(timers[0]);
    expect(expired).toHaveLength(1);
    expect(expired[0].tg).toBeUndefined();
    expect(codes.claim(code)).toBeNull();
  });

  it("attachMessage after a claim, a drop or the TTL returns false (the code is gone)", () => {
    const { codes, timers } = setup();
    const a = codes.mint("laptop");
    expect(codes.claim(a.code)).not.toBeNull();
    expect(codes.attachMessage(a.code, 4242, 77)).toBe(false);
    const b = codes.mint("phone");
    codes.drop(b.code);
    expect(codes.attachMessage(b.code, 4242, 78)).toBe(false);
    const c = codes.mint("tablet");
    fire(timers[2]);
    expect(codes.attachMessage(c.code, 4242, 79)).toBe(false);
  });

  it("a claimed code's timer is cleared: no onExpire", () => {
    const { codes, timers, expired } = setup();
    const { code } = codes.mint("laptop");
    codes.attachMessage(code, 4242, 77);
    expect(codes.claim(code)).not.toBeNull();
    expect(timers[0].cleared).toBe(true);
    timers[0].fn(); // even a late callback from a timer that could not be cancelled
    expect(expired).toEqual([]);
  });

  it("drop makes claim return null and fires no onExpire", () => {
    const { codes, timers, expired } = setup();
    const { code } = codes.mint("laptop");
    codes.attachMessage(code, 4242, 77);
    codes.drop(code);
    expect(timers[0].cleared).toBe(true);
    expect(codes.claim(code)).toBeNull();
    timers[0].fn();
    expect(expired).toEqual([]);
  });

  it("an expired claim drops the code and fires onExpire once (the private message is deleted)", () => {
    const { codes, clock, timers, expired } = setup();
    const { code, expiresAt } = codes.mint("laptop");
    codes.attachMessage(code, 4242, 77);
    clock.advance(600_001);
    expect(codes.claim(code)).toBeNull();
    expect(expired).toEqual([{ label: "laptop", expiresAt, tg: { chatId: 4242, messageId: 77 } }]);
    expect(timers[0].cleared).toBe(true);
    timers[0].fn();
    expect(expired).toHaveLength(1);
  });

  it("codes are independent: claiming one leaves the other valid", () => {
    const { codes, timers, expired } = setup();
    const a = codes.mint("laptop");
    const b = codes.mint("phone");
    expect(codes.claim(a.code)).toMatchObject({ label: "laptop" });
    expect(codes.claim(b.code)).toMatchObject({ label: "phone" });
    expect(timers.every((t) => t.cleared)).toBe(true);
    expect(expired).toEqual([]);
  });

  it("a throwing onExpire is logged and never escapes the timer callback", () => {
    const { timers, setTimer } = fakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const codes = new PairingCodes({ setTimer, onExpire: () => { throw new Error("boom"); } });
    const { code } = codes.mint("laptop");
    expect(() => fire(timers[0])).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(codes.claim(code)).toBeNull();
  });

  it("a rejecting onExpire is caught and logged (no unhandled rejection)", async () => {
    const { timers, setTimer } = fakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const codes = new PairingCodes({ setTimer, onExpire: () => Promise.reject(new Error("gone")) });
      codes.mint("laptop");
      fire(timers[0]);
      await new Promise((r) => setTimeout(r, 10));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("ttlMs overrides the TTL", () => {
    const { timers, setTimer } = fakeTimers();
    const codes = new PairingCodes({ ttlMs: 5_000, now: () => 100, setTimer });
    expect(codes.mint("laptop").expiresAt).toBe(5_100);
    expect(timers[0].ms).toBe(5_000);
  });

  it("the default timer is a real setTimeout of ttlMs", () => {
    vi.useFakeTimers();
    try {
      const expired: PendingPair[] = [];
      const codes = new PairingCodes({ onExpire: (p) => { expired.push(p); } });
      const { code } = codes.mint("laptop");
      vi.advanceTimersByTime(PAIR_TTL_MS - 1);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toHaveLength(1);
      expect(codes.claim(code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
