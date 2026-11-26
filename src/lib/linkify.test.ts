import { describe, expect, it } from "vitest";
import { linkParts } from "./linkify";

describe("linkParts", () => {
  it("keeps text without a URL as one text part", () => {
    expect(linkParts("no link here")).toEqual([{ text: "no link here" }]);
  });

  it("splits an https URL out of the text", () => {
    expect(linkParts("Mockups: https://share.example.com/mock-4m#pw=AB-CD\n\nA: one")).toEqual([
      { text: "Mockups: " },
      { url: "https://share.example.com/mock-4m#pw=AB-CD", text: "https://share.example.com/mock-4m#pw=AB-CD" },
      { text: "\n\nA: one" },
    ]);
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    expect(linkParts("See https://github.com/o/r/pull/18. Then go.")).toEqual([
      { text: "See " },
      { url: "https://github.com/o/r/pull/18", text: "https://github.com/o/r/pull/18" },
      { text: ". Then go." },
    ]);
  });

  it("keeps a closing parenthesis that the URL opened, drops one it did not", () => {
    expect(linkParts("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { text: "(" },
      { url: "https://en.wikipedia.org/wiki/Foo_(bar)", text: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { text: ")" },
    ]);
  });

  it("finds several URLs, http included", () => {
    const parts = linkParts("a http://x.test/1 b https://y.test/2");
    expect(parts.filter((p) => "url" in p).map((p) => (p as { url: string }).url)).toEqual(["http://x.test/1", "https://y.test/2"]);
  });

  it("never makes a link of other schemes", () => {
    expect(linkParts("javascript:alert(1) data:text/html,x file:///etc/passwd")).toEqual([
      { text: "javascript:alert(1) data:text/html,x file:///etc/passwd" },
    ]);
  });

  it("does not link a URL glued to a word before it", () => {
    expect(linkParts("xhttps://evil.test")).toEqual([{ text: "xhttps://evil.test" }]);
  });

  it("keeps an empty string as no parts", () => {
    expect(linkParts("")).toEqual([]);
  });
});
