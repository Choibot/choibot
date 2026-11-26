import { describe, expect, it } from "vitest";
import { isHtmlPath, isMarkdownPath, resolveDocHref } from "./docs";

describe("isMarkdownPath", () => {
  it("matches md/mdx/markdown, case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guide.MD")).toBe(true);
    expect(isMarkdownPath("a/b.mdx")).toBe(true);
    expect(isMarkdownPath("a/b.markdown")).toBe(true);
  });
  it("rejects other files and md-in-the-middle names", () => {
    expect(isMarkdownPath("src/index.ts")).toBe(false);
    expect(isMarkdownPath("notes.md.bak")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});

describe("resolveDocHref", () => {
  it("resolves siblings and subdirectories relative to the current doc", () => {
    expect(resolveDocHref("docs/guide.md", "setup.md")).toBe("docs/setup.md");
    expect(resolveDocHref("docs/guide.md", "./setup.md")).toBe("docs/setup.md");
    expect(resolveDocHref("docs/guide.md", "sub/deep.md")).toBe("docs/sub/deep.md");
  });
  it("folds .. without escaping the repo root", () => {
    expect(resolveDocHref("docs/guide.md", "../README.md")).toBe("README.md");
    expect(resolveDocHref("README.md", "../../etc/passwd")).toBe("etc/passwd");
  });
  it("treats a leading / as repo-root-relative", () => {
    expect(resolveDocHref("docs/a/b.md", "/CONTRIBUTING.md")).toBe("CONTRIBUTING.md");
  });
  it("strips anchors and query strings, decodes %20", () => {
    expect(resolveDocHref("docs/a.md", "b.md#section")).toBe("docs/b.md");
    expect(resolveDocHref("docs/a.md", "b.md?x=1")).toBe("docs/b.md");
    expect(resolveDocHref("docs/a.md", "my%20notes.md")).toBe("docs/my notes.md");
  });
  it("returns null for external, protocol, anchor-only, and empty links", () => {
    expect(resolveDocHref("a.md", "https://example.com/x.md")).toBe(null);
    expect(resolveDocHref("a.md", "//cdn.example.com/x.md")).toBe(null);
    expect(resolveDocHref("a.md", "mailto:x@y.z")).toBe(null);
    expect(resolveDocHref("a.md", "#top")).toBe(null);
    expect(resolveDocHref("a.md", "")).toBe(null);
  });
});

describe("isHtmlPath", () => {
  it("matches html/htm, case-insensitively", () => {
    expect(isHtmlPath("ui/mock.html")).toBe(true);
    expect(isHtmlPath("a.HTM")).toBe(true);
  });
  it("rejects other files", () => {
    expect(isHtmlPath("a.md")).toBe(false);
    expect(isHtmlPath("page.html.bak")).toBe(false);
  });
});
