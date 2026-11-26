import { describe, it, expect } from "vitest";
import { makeSessionValue, isSessionValueValid } from "./session.js";

describe("session value", () => {
  it("mints a JSON token with a unique jti and future exp", () => {
    const v = makeSessionValue(1000, 10_000);
    expect(JSON.parse(v)).toEqual({ jti: expect.any(String), exp: 11_000 });
    expect(makeSessionValue(1000, 10_000)).not.toEqual(v); // unique jti
  });
  it("accepts an unexpired token and rejects an expired/garbage one", () => {
    const v = makeSessionValue(1000, 10_000);
    expect(isSessionValueValid(v, 10_500)).toBe(true);
    expect(isSessionValueValid(v, 11_001)).toBe(false);
    expect(isSessionValueValid(undefined, 0)).toBe(false);
    expect(isSessionValueValid("not-json", 0)).toBe(false);
    expect(isSessionValueValid(JSON.stringify({ jti: "x" }), 0)).toBe(false); // no exp
  });
});
