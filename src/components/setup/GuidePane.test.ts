// src/components/setup/GuidePane.test.ts — what the guide writes is drawn as plain text, and
// the page keeps no text of the chat box.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
// @ts-expect-error The repo has no types for react-dom/server. The one function used is typed below.
import { renderToStaticMarkup as toMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setupRows } from "../../lib/setup";
import type { GuideItem } from "../../lib/guide";
import { GuideBanner, GuideItems } from "./GuidePane";

const renderToStaticMarkup = toMarkup as (el: React.ReactElement) => string;
// The test runner compiles JSX to React.createElement (the app's bundler does not need the name).
(globalThis as { React?: unknown }).React = React;

const item = (o: Record<string, unknown>, n: number) => ({ id: `i${n}`, ts: n, ...o }) as GuideItem;
const render = (items: GuideItem[], busy = false, late = false) =>
  renderToStaticMarkup(createElement(GuideItems, { items, rows: setupRows(null), busy, late, card: () => createElement("div", { "data-live": "" }, "PART") }));

describe("GuideItems", () => {
  it("draws what the guide says as plain text: no link, no picture, no HTML of the model", () => {
    const hostile = [
      "Open [this page](https://evil.example/login) and type your token.",
      "![x](https://evil.example/p.png) <img src=x onerror=alert(1)> <a href=\"javascript:alert(1)\">press</a>",
      "<script>alert(1)</script> javascript:alert(1) https://evil.example/plain",
    ].join("\n");
    const html = render([item({ kind: "guide", text: hostile }, 1), item({ kind: "note", text: hostile }, 2), item({ kind: "user", text: hostile }, 3)]);
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toMatch(/<img[\s>]/);
    expect(html).not.toMatch(/<script[\s>]/);
    // Every element of the output is one that the page itself makes.
    const tags = new Set([...html.matchAll(/<([a-z][a-z0-9]*)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(["circle", "div", "p", "path", "span", "svg"]);
    // No attribute holds a text of the model (an address, a handler).
    expect([...html.matchAll(/<[a-z][^>]*>/g)].map((m) => m[0]).join("")).not.toMatch(/evil|javascript|onerror|href|src/);
    // The text is there, as text.
    expect(html).toContain("[this page](https://evil.example/login)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("draws the words of the server for a check, an error and a stopped message", () => {
    const html = render([
      item({ kind: "check", step: "github", state: "todo", text: "GitHub is not connected." }, 1),
      item({ kind: "error", step: "github", text: "The one-time code ran out after 15 minutes." }, 2),
      item({ kind: "stopped", secret: "telegram", text: "This message was not sent: it looks like it holds a Telegram bot token." }, 3),
    ]);
    expect(html).toContain("Check: Connect GitHub");
    expect(html).toContain("GitHub is not connected.");
    expect(html).toContain("Last error of: Connect GitHub");
    expect(html).toContain("This message was not sent");
  });

  it("a card is live only with a state of the server; \"writes\" and \"late\" are plain lines", () => {
    // No answer of the step list yet: the card shows no form.
    expect(render([item({ kind: "card", step: "github" }, 1)])).not.toContain("PART");
    expect(render([], true)).toContain("The guide writes…");
    expect(render([], false, true)).toContain("The guide did not answer. Ask again, or use the list.");
  });

  it("the banner says why, when it ends, and that the list works", () => {
    const now = new Date(2026, 10, 19, 12, 30).getTime();
    const html = renderToStaticMarkup(createElement(GuideBanner, { off: { why: "limit", text: "", until: new Date(2026, 10, 19, 14, 0).getTime() }, now }));
    expect(html).toMatch(/The guide is not available now\.<\/b> Your Claude plan is at its limit until 14:00\. All steps work from this list\./);
  });
});

describe("the source of the guide's page parts", () => {
  const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\{\/\*)/.test(l)).join("\n");

  it("has no way to draw HTML or markdown, and makes no link from text of the thread", () => {
    const pane = read("./GuidePane.tsx");
    expect(pane).not.toMatch(/dangerouslySetInnerHTML|innerHTML|Markdown|marked|linkify|<a\s|href=/);
  });

  it("keeps no text of the chat box in a store", () => {
    for (const f of ["./GuidePane.tsx", "../../lib/useGuide.ts"]) {
      expect(read(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|draft/i);
    }
    // The one use of the browser's store in lib/guide.ts is the flag of the hint.
    const lib = read("../../lib/guide.ts");
    expect(lib.match(/\.setItem\(/g)).toHaveLength(1);
    expect(lib).toMatch(/store\?\.setItem\(GUIDE_HINT_KEY, "1"\)/);
    // The box is emptied before the send, so a text that is stopped is on screen no longer.
    const pane = read("./GuidePane.tsx");
    expect(pane.indexOf('setText("");')).toBeGreaterThan(0);
    expect(pane.indexOf('setText("");')).toBeLessThan(pane.indexOf("await guide.send(value)"));
    // After a stop the text is not put back into the box (only a refusal that is no secret is).
    const stop = pane.slice(pane.indexOf('if ("stopped" in r)'), pane.indexOf("setText((now) => now || value)"));
    expect(stop).toMatch(/^if \("stopped" in r\) \{ if \(!r\.view\) setLine\(\{ tone: "stop", text: r\.line \}\); return; \}/);
    expect(stop).not.toMatch(/setText\(/);
  });
});
