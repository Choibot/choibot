import { describe, expect, it } from "vitest";
import { parseHashRoute, prHash } from "./hashRoute";

describe("parseHashRoute", () => {
  it("parses pair, brain-diff and reconcile routes", () => {
    expect(parseHashRoute("#pair=abc_-1")).toEqual({ kind: "pair", code: "abc_-1" });
    expect(parseHashRoute("#brain=diff")).toEqual({ kind: "brain-diff" });
    expect(parseHashRoute("#agent=a1&reconcile")).toEqual({ kind: "reconcile", agentId: "a1" });
  });
  it("rejects empty, partial and unsafe routes", () => {
    expect(parseHashRoute("#pair=")).toBeNull();
    expect(parseHashRoute("#pair=a b")).toBeNull();
    expect(parseHashRoute("#agent=a1")).toBeNull();
    expect(parseHashRoute("#agent=../x&reconcile")).toBeNull();
    expect(parseHashRoute("#agent=" + "a".repeat(65) + "&reconcile")).toBeNull();
    expect(parseHashRoute("#brain=other")).toBeNull();
    expect(parseHashRoute("")).toBeNull();
  });
  it("parses a PR route (the PR's row in the GitHub tab) and rejects a malformed one", () => {
    expect(parseHashRoute("#pr=Octo-owner/choibot/12")).toEqual({ kind: "pr", slug: "Octo-owner/choibot", number: 12 });
    expect(parseHashRoute("#pr=example-org/web.app/7")).toEqual({ kind: "pr", slug: "example-org/web.app", number: 7 });
    for (const bad of ["#pr=", "#pr=o/r", "#pr=o/r/0", "#pr=o/r/x", "#pr=o/r/1/2", "#pr=o r/x/1", "#pr=o/r/1&x", "#pr=o/r/-1"]) {
      expect(parseHashRoute(bad), bad).toBeNull();
    }
  });
  it("parses the route of a recurring task's page (the link of its Telegram message)", () => {
    expect(parseHashRoute("#recurring=nightly-backup")).toEqual({ kind: "recurring", name: "nightly-backup" });
    for (const bad of ["#recurring=", "#recurring=Bad", "#recurring=-x", "#recurring=a/b", "#recurring=a&x", `#recurring=${"a".repeat(42)}`]) {
      expect(parseHashRoute(bad), bad).toBeNull();
    }
  });
  it("prHash builds that route, or null for a slug or number it could not parse back", () => {
    expect(prHash("o/app-shop", 12)).toBe("/#pr=o/app-shop/12");
    expect(parseHashRoute(prHash("o/app-shop", 12)!.slice(1))).toEqual({ kind: "pr", slug: "o/app-shop", number: 12 });
    expect(prHash("o/app v2", 12)).toBeNull();
    expect(prHash("o", 12)).toBeNull();
    expect(prHash("o/r", 0)).toBeNull();
  });
});
