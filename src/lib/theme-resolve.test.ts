// src/lib/theme-resolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveInitialTheme } from "./theme-resolve";

describe("resolveInitialTheme", () => {
  it("honors an explicit stored choice over the system preference", () => {
    expect(resolveInitialTheme("light", true)).toBe("light");
    expect(resolveInitialTheme("dark", false)).toBe("dark");
  });

  it("falls back to the system preference when nothing is stored", () => {
    expect(resolveInitialTheme(null, true)).toBe("dark");
    expect(resolveInitialTheme(null, false)).toBe("light");
  });

  it("ignores garbage stored values and uses the system preference", () => {
    expect(resolveInitialTheme("purple", true)).toBe("dark");
    expect(resolveInitialTheme("", false)).toBe("light");
  });
});
