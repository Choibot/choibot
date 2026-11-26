import { describe, it, expect } from "vitest";
import { parseMeta, parseUi, resolveLayout, sortWidgets, uiFromObject } from "./meta.js";

const j = (v: unknown) => JSON.stringify(v);

describe("parseMeta", () => {
  it("reads every key", () => {
    expect(parseMeta(j({ title: " RateX ", width: 320, height: 200, chrome: false, autoRefresh: 60, order: 1, historyMax: 100 })))
      .toEqual({ title: "RateX", width: 320, height: 200, chrome: false, autoRefresh: 60, order: 1, historyMax: 100 });
  });
  it("accepts width \"wide\"", () => {
    expect(parseMeta(j({ width: "wide" }))).toEqual({ width: "wide" });
  });
  it("clamps numbers out of range", () => {
    expect(parseMeta(j({ width: 10, height: 5000, autoRefresh: 5, historyMax: 1 })))
      .toEqual({ width: 160, height: 800, autoRefresh: 30, historyMax: 10 });
    expect(parseMeta(j({ width: 9999, height: 1, historyMax: 99999 })))
      .toEqual({ width: 1200, height: 80, historyMax: 5000 });
  });
  it("drops values of the wrong type one by one", () => {
    expect(parseMeta(j({ title: 3, width: "big", height: "1", chrome: "no", autoRefresh: null, order: "x", historyMax: null, extra: 1 })))
      .toEqual({});
    expect(parseMeta(j({ title: "ok", width: "big" }))).toEqual({ title: "ok" });
  });
  it("cuts a long title to 80 chars and drops a blank one", () => {
    expect(parseMeta(j({ title: "t".repeat(100) })).title).toHaveLength(80);
    expect(parseMeta(j({ title: "   " }))).toEqual({});
  });
  it("returns {} for null, bad JSON, arrays and JSON null", () => {
    expect(parseMeta(null)).toEqual({});
    expect(parseMeta("{nope")).toEqual({});
    expect(parseMeta("[1]")).toEqual({});
    expect(parseMeta("null")).toEqual({});
  });
});

describe("parseUi", () => {
  it("reads width, height, autoRefresh and keeps autoRefresh null (turned off)", () => {
    expect(parseUi(j({ width: "wide", height: 300, autoRefresh: null }))).toEqual({ width: "wide", height: 300, autoRefresh: null });
    expect(parseUi(j({ autoRefresh: 45 }))).toEqual({ autoRefresh: 45 });
  });
  it("ignores meta-only keys", () => {
    expect(parseUi(j({ title: "x", chrome: false, order: 2 }))).toEqual({});
  });
  it("uiFromObject takes a request body as is", () => {
    expect(uiFromObject({ width: 100 })).toEqual({ width: 160 });
    expect(uiFromObject("nope")).toEqual({});
  });
});

describe("resolveLayout", () => {
  it("uses defaults and the id as title", () => {
    expect(resolveLayout("w1", {}, {})).toEqual({
      title: "w1", width: 260, height: 180, chrome: true, autoRefresh: null, order: 0, historyMax: 500,
    });
  });
  it("lets ui.json win over meta.json", () => {
    expect(resolveLayout("w", { width: 300, height: 100, autoRefresh: 60 }, { width: "wide", height: 400, autoRefresh: null }))
      .toMatchObject({ width: "wide", height: 400, autoRefresh: null });
  });
  it("falls back to meta.json for keys ui.json does not set", () => {
    expect(resolveLayout("w", { title: "T", width: 300, autoRefresh: 60, chrome: false }, { height: 90 }))
      .toMatchObject({ title: "T", width: 300, height: 90, autoRefresh: 60, chrome: false });
  });
});

describe("sortWidgets", () => {
  it("sorts by order, then title, then id", () => {
    const list = [
      { id: "c", title: "B", order: 1 },
      { id: "b", title: "B", order: 1 },
      { id: "a", title: "A", order: 2 },
      { id: "z", title: "Z", order: 0 },
    ];
    expect(sortWidgets(list).map((w) => w.id)).toEqual(["z", "b", "c", "a"]);
  });
});
