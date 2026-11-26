import { describe, it, expect } from "vitest";
import { isAbsolute, join } from "node:path";
import { isAgentId, isWidgetId, resolveWidgetsDataDir, widgetDir, agentWidgetsDir } from "./paths.js";

describe("isWidgetId", () => {
  it("accepts lowercase ids up to 48 chars", () => {
    expect(isWidgetId("ratex")).toBe(true);
    expect(isWidgetId("rate-x_2")).toBe(true);
    expect(isWidgetId("a".repeat(48))).toBe(true);
  });
  it("refuses upper case, dots, separators, a leading - or _, long ids and non-strings", () => {
    for (const bad of ["RateX", "a.b", "a/b", "..", "-a", "_a", "", "a".repeat(49), 5, null]) {
      expect(isWidgetId(bad)).toBe(false);
    }
  });
});

describe("isAgentId", () => {
  it("accepts uuids and the master ids", () => {
    expect(isAgentId("3ee90a02-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isAgentId("fleet-master")).toBe(true);
  });
  it("refuses dots, separators, empty and long ids", () => {
    for (const bad of ["..", ".", "a/b", "a\\b", "", ".x", "x".repeat(65), undefined]) {
      expect(isAgentId(bad)).toBe(false);
    }
  });
});

describe("resolveWidgetsDataDir", () => {
  it("defaults to .widgets-data under the cwd, absolute", () => {
    expect(resolveWidgetsDataDir({})).toBe(join(process.cwd(), ".widgets-data"));
  });
  it("makes a relative WIDGETS_DATA_DIR absolute and keeps an absolute one", () => {
    const d = resolveWidgetsDataDir({ WIDGETS_DATA_DIR: "x/w" });
    expect(isAbsolute(d)).toBe(true);
    expect(d).toBe(join(process.cwd(), "x/w"));
    expect(resolveWidgetsDataDir({ WIDGETS_DATA_DIR: "/srv/w" })).toBe("/srv/w");
  });
});

describe("widget folders", () => {
  it("joins root, agent and widget", () => {
    expect(agentWidgetsDir("/r", "a1")).toBe("/r/a1");
    expect(widgetDir("/r", "a1", "w1")).toBe("/r/a1/w1");
  });
});
