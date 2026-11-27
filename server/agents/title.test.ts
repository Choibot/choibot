import { describe, it, expect } from "vitest";
import { TITLE_MAX, checkTitle } from "./title.js";

describe("checkTitle", () => {
  it("trims a title and keeps it", () => {
    expect(checkTitle("  Worker titles  ")).toEqual({ title: "Worker titles" });
    expect(checkTitle("é".repeat(TITLE_MAX))).toEqual({ title: "é".repeat(TITLE_MAX) });
  });
  it("refuses with one clear line: not text, empty, two lines, too long", () => {
    expect(checkTitle(3)).toEqual({ error: "title must be text" });
    expect(checkTitle(" \t ")).toEqual({ error: "title must not be empty" });
    expect(checkTitle("a\nb")).toEqual({ error: "title must be one line" });
    expect(checkTitle("a\tb")).toEqual({ error: "title must be one line" });
    expect(checkTitle("x".repeat(41))).toEqual({ error: "title is 41 characters; the most is 40" });
  });
});
