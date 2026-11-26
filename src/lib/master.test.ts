import { describe, it, expect } from "vitest";
import { masterStatusLine } from "./master";

describe("masterStatusLine", () => {
  it("shows queued events, Telegram state and the reply surface", () => {
    expect(masterStatusLine({ queuedEvents: 0, queuedMessages: 0, telegram: false, surface: "tab" }))
      .toBe("0 queued events · Telegram off · replies to tab");
    expect(masterStatusLine({ queuedEvents: 1, queuedMessages: 2, telegram: true, surface: "telegram" }))
      .toBe("1 queued event · 2 queued messages · Telegram on · replies to Telegram");
  });
  it("with the Coordinator the master has no event queue: the line has no event count", () => {
    expect(masterStatusLine({ queuedEvents: 0, queuedMessages: 0, telegram: true, surface: "tab", coordinator: true }))
      .toBe("Telegram on · replies to tab");
    expect(masterStatusLine({ queuedEvents: 0, queuedMessages: 1, telegram: false, surface: "tab", coordinator: true }))
      .toBe("1 queued message · Telegram off · replies to tab");
  });
});
