// server/gh/exec.test.ts
import { describe, it, expect } from "vitest";
import { classifyError, extractPrUrl } from "./exec.js";

describe("classifyError", () => {
  it("detects auth failures", () => {
    expect(classifyError("gh auth login required; not logged in")).toBe("not_authed");
    expect(classifyError("error: no oauth token")).toBe("not_authed");
  });
  it("detects non-fast-forward pushes", () => {
    expect(classifyError("! [rejected] main -> main (non-fast-forward)")).toBe("not_fast_forward");
    expect(classifyError("Updates were rejected because the tip of your current branch is behind")).toBe("not_fast_forward");
  });
  it("detects an existing PR", () => {
    expect(classifyError("a pull request for branch \"x\" into branch \"main\" already exists")).toBe("already_exists");
  });
  it("detects missing github remote", () => {
    expect(classifyError("fatal: 'origin' does not appear to be a git repository")).toBe("no_github_remote");
    expect(classifyError("error: No such remote 'origin'")).toBe("no_github_remote");
  });
  it("detects rate limiting and not-found", () => {
    expect(classifyError("API rate limit exceeded")).toBe("rate_limited");
    expect(classifyError("Could not resolve to a Repository with the name 'x'")).toBe("not_found");
  });
  it("falls back to unknown", () => {
    expect(classifyError("some other explosion")).toBe("unknown");
  });
});

describe("extractPrUrl", () => {
  it("pulls a PR url from text", () => {
    expect(extractPrUrl("done: https://github.com/example-org/sorrel/pull/42 ok"))
      .toBe("https://github.com/example-org/sorrel/pull/42");
  });
  it("returns undefined when absent", () => {
    expect(extractPrUrl("no url here")).toBeUndefined();
  });
});
