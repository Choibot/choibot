import { describe, expect, it } from "vitest";
import { oneLine } from "./text.js";

describe("oneLine", () => {
  it("drops controls and folds every whitespace run to one space", () => {
    expect(oneLine("  a\r\n\tb\u0007c\x1b[31m  d\x7f\x9b ")).toBe("a bc[31m d");
  });
});
