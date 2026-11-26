import { describe, expect, it } from "vitest";
import { MAX_SHARED_DOCS, parseDocsManifest, sharedDocKind } from "./shared.js";

describe("sharedDocKind", () => {
  it("classifies markdown and html, case-insensitively", () => {
    expect(sharedDocKind("docs/plan.md")).toBe("md");
    expect(sharedDocKind("a.MDX")).toBe("md");
    expect(sharedDocKind("b.markdown")).toBe("md");
    expect(sharedDocKind("ui/mock.html")).toBe("html");
    expect(sharedDocKind("ui/mock.HTM")).toBe("html");
  });
  it("rejects everything else", () => {
    expect(sharedDocKind("script.js")).toBe(null);
    expect(sharedDocKind("notes.md.bak")).toBe(null);
    expect(sharedDocKind("md")).toBe(null);
  });
});

describe("parseDocsManifest", () => {
  it("accepts strings and {path,title} objects, defaulting title to undefined", () => {
    const raw = JSON.stringify(["a.md", { path: "b.html", title: "Mock" }, { path: "c.md" }]);
    expect(parseDocsManifest(raw)).toEqual([
      { path: "a.md" },
      { path: "b.html", title: "Mock" },
      { path: "c.md" },
    ]);
  });
  it("trims titles and drops blank ones", () => {
    const raw = JSON.stringify([{ path: "a.md", title: "  Spec  " }, { path: "b.md", title: "   " }]);
    expect(parseDocsManifest(raw)).toEqual([{ path: "a.md", title: "Spec" }, { path: "b.md" }]);
  });
  it("normalizes ./ prefixes and keeps manifest order", () => {
    expect(parseDocsManifest(JSON.stringify(["./x/y.md", "a.md"]))).toEqual([
      { path: "x/y.md" },
      { path: "a.md" },
    ]);
  });
  it("drops absolute paths, .. traversal, disallowed extensions, and junk entries", () => {
    const raw = JSON.stringify([
      "/etc/passwd.md",
      "../escape.md",
      "docs/../../escape.md",
      "script.js",
      42,
      null,
      { title: "no path" },
      "ok.md",
    ]);
    expect(parseDocsManifest(raw)).toEqual([{ path: "ok.md" }]);
  });
  it("dedupes by path, first entry wins", () => {
    const raw = JSON.stringify([{ path: "a.md", title: "First" }, { path: "a.md", title: "Second" }]);
    expect(parseDocsManifest(raw)).toEqual([{ path: "a.md", title: "First" }]);
  });
  it("caps at MAX_SHARED_DOCS", () => {
    const raw = JSON.stringify(Array.from({ length: 60 }, (_, i) => `d${i}.md`));
    expect(parseDocsManifest(raw)).toHaveLength(MAX_SHARED_DOCS);
  });
  it("returns [] for malformed JSON and non-array shapes", () => {
    expect(parseDocsManifest("not json")).toEqual([]);
    expect(parseDocsManifest('{"path":"a.md"}')).toEqual([]);
    expect(parseDocsManifest("null")).toEqual([]);
  });
});
