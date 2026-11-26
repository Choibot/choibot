import { describe, it, expect } from "vitest";
import { ActedLog, ACT_SUPPRESS_MS } from "./acted.js";

describe("ActedLog", () => {
  it("reports an id as recent for 60 s after a mark", () => {
    let t = 1_000;
    const log = new ActedLog(() => t);
    expect(log.recent("a")).toBe(false);
    log.mark("a");
    t += ACT_SUPPRESS_MS - 1;
    expect(log.recent("a")).toBe(true);
    t += 1;
    expect(log.recent("a")).toBe(false);
    expect(log.recent("b")).toBe(false);
  });
});
