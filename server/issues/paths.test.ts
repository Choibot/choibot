import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveIssuesDataDir, parseIssuesUserId } from "./paths.js";

describe("resolveIssuesDataDir", () => {
  it("prefers ISSUES_DATA_DIR", () => {
    expect(resolveIssuesDataDir({ ISSUES_DATA_DIR: "/data/issues" })).toBe("/data/issues");
  });
  it("falls back to XDG_DATA_HOME", () => {
    expect(resolveIssuesDataDir({ XDG_DATA_HOME: "/x" })).toBe("/x/choibot/issues");
  });
  it("falls back to ~/.local/share", () => {
    expect(resolveIssuesDataDir({})).toBe(join(homedir(), ".local", "share", "choibot", "issues"));
  });
});

describe("parseIssuesUserId", () => {
  it("parses a positive integer id", () => expect(parseIssuesUserId(" 123456789 ")).toBe(123456789));
  it("rejects unset, blank, zero, negative and junk", () => {
    for (const v of [undefined, "", "0", "-5", "abc", "1.5", "12abc"]) expect(parseIssuesUserId(v)).toBeNull();
  });
});
