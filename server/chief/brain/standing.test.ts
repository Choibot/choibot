import { describe, expect, it } from "vitest";
import { hasStandingMarker, oneTimeReason } from "./standing.js";

describe("oneTimeReason", () => {
  it("a one-letter or two-word answer is never a rule", () => {
    for (const t of ["A", "B ok", "done merge", "  ", "yes!"]) expect(oneTimeReason(t), t).not.toBeNull();
  });
  it("a question is never a rule, with or without its question mark", () => {
    for (const t of ["should we still merge this?", "tldr of what it does?", "What is the risk of this", "what's the dif between B and C",
      "Can we have it on the phone too", "is it ready for review", "Couldn't we keep the old layout"]) {
      expect(oneTimeReason(t), t).toBe("a question");
    }
  });
  it("an order is not a question, even when it starts with a helper verb", () => {
    for (const t of ["Do not push to main", "Don't ever merge without asking", "Never commit plan files", "Use pnpm for every install",
      "Always share pages via share.example.com", "Do not reuse a closed worker; for a new task start a new worker",
      "When a PR is ready, open it yourself", "Where possible, keep PRs small"]) {
      expect(oneTimeReason(t), t).toBeNull();
    }
  });
});

describe("hasStandingMarker", () => {
  it("finds a marker word on word bounds, any case", () => {
    for (const t of ["Always run the tests", "never squash", "From now on use Geist", "by default show 1d", "Don't ever merge"]) {
      expect(hasStandingMarker(t), t).toBe(true);
    }
    for (const t of ["show me other option", "neverland is a place", "the hallways are long", "put the line by defautl"]) {
      expect(hasStandingMarker(t), t).toBe(false);
    }
  });
});
