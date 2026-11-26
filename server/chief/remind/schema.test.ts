// server/chief/remind/schema.test.ts — the reminder input rules: durations,
// the due time window and the text limits.
import { describe, expect, it } from "vitest";
import { MAX_AHEAD_MS, MIN_AHEAD_MS, parseDuration, parseReminderInput, REMINDER_ID_RE, newReminderId } from "./schema.js";

const NOW = Date.parse("2026-11-10T15:40:00Z");
const M = 60_000, H = 60 * M, D = 24 * H;

describe("parseDuration", () => {
  it.each([
    ["30m", 30 * M], ["6h", 6 * H], ["3d", 3 * D], ["1d12h", D + 12 * H], ["1h30m", H + 30 * M], ["2d3h4m", 2 * D + 3 * H + 4 * M],
    ["90m", 90 * M],
  ])("%s", (s, ms) => {
    expect(parseDuration(s)).toBe(ms);
  });
  it.each(["", "0m", "3", "m", "3x", "1.5h", "-1h", "3h1d", "1d 2h", "1D", "99999999999999999999d"])("refuses %j", (s) => {
    expect(parseDuration(s)).toBeNull();
  });
});

describe("parseReminderInput", () => {
  it("--in gives now + the duration", () => {
    expect(parseReminderInput({ in: "3d", text: "check the canary" }, NOW)).toEqual({ ok: true, value: { dueAt: NOW + 3 * D, text: "check the canary" } });
  });
  it("--at takes an ISO date-time", () => {
    const r = parseReminderInput({ at: "2026-11-12T09:00:00Z", text: "t" }, NOW);
    expect(r).toEqual({ ok: true, value: { dueAt: Date.parse("2026-11-12T09:00:00Z"), text: "t" } });
  });
  it("refuses a date with no time, and junk", () => {
    expect(parseReminderInput({ at: "2026-11-12", text: "t" }, NOW).ok).toBe(false);
    expect(parseReminderInput({ at: "next tuesday", text: "t" }, NOW).ok).toBe(false);
  });
  it("needs exactly one of in and at", () => {
    expect(parseReminderInput({ text: "t" }, NOW)).toEqual({ ok: false, error: "give exactly one of in or at" });
    expect(parseReminderInput({ in: "1h", at: "2026-11-12T09:00:00Z", text: "t" }, NOW).ok).toBe(false);
  });
  it("keeps dueAt between now + 5 min and now + 30 days", () => {
    expect(parseReminderInput({ in: "4m", text: "t" }, NOW).ok).toBe(false);
    expect(parseReminderInput({ in: "5m", text: "t" }, NOW).ok).toBe(true);
    expect(parseReminderInput({ in: "30d", text: "t" }, NOW).ok).toBe(true);
    expect(parseReminderInput({ in: "30d1m", text: "t" }, NOW).ok).toBe(false);
    expect(parseReminderInput({ at: "2026-11-10T15:00:00Z", text: "t" }, NOW).ok).toBe(false);
    expect(MIN_AHEAD_MS).toBe(5 * M);
    expect(MAX_AHEAD_MS).toBe(30 * D);
  });
  it("trims the text and keeps it 1..1000 chars", () => {
    expect(parseReminderInput({ in: "1h", text: "  hi  " }, NOW)).toMatchObject({ ok: true, value: { text: "hi" } });
    expect(parseReminderInput({ in: "1h", text: "   " }, NOW).ok).toBe(false);
    expect(parseReminderInput({ in: "1h", text: "x".repeat(1000) }, NOW).ok).toBe(true);
    expect(parseReminderInput({ in: "1h", text: "x".repeat(1001) }, NOW).ok).toBe(false);
    expect(parseReminderInput({ in: "1h", text: 7 }, NOW).ok).toBe(false);
  });
  it("redacts secrets in the text as the decision log does", () => {
    const r = parseReminderInput({ in: "1h", text: "use sk-abcdefghijklmnop then check" }, NOW);
    expect(r).toMatchObject({ ok: true, value: { text: "use [redacted] then check" } });
  });
  it("refuses a body that is not an object", () => {
    expect(parseReminderInput(null, NOW).ok).toBe(false);
    expect(parseReminderInput("x", NOW).ok).toBe(false);
  });
});

describe("reminder ids", () => {
  it("are r_ + 8 base36", () => {
    for (let i = 0; i < 20; i++) expect(newReminderId()).toMatch(REMINDER_ID_RE);
    expect(REMINDER_ID_RE.test("r_../x")).toBe(false);
  });
});
