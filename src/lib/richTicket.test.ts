import { describe, expect, it, vi } from "vitest";
import { fetchRichPage, RICH_BASE_CSS, RICH_CSP, RICH_SANDBOX, RICH_TOKENS, richDoc, richHeight } from "./richTicket";

const TOKENS = Object.fromEntries(RICH_TOKENS.map((t) => [t, "#111112"]));
// The agent's page: the srcdoc of the frame inside the console's outer page, as a browser reads it.
const inner = (doc: string): string => /srcdoc="([^"]*)"/.exec(doc)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("the wall of the frame", () => {
  it("the sandbox is empty: no script, no same origin, no form, no popup, no top navigation", () => {
    expect(RICH_SANDBOX).toBe("");
  });
  it("the policy allows no request: only inline CSS, data: images and data: fonts", () => {
    expect(RICH_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'");
    expect(RICH_CSP).not.toMatch(/script-src|https?:|\*|'self'|connect-src|frame-src/);
  });
  it("the agent's page is a frame with the empty sandbox inside a page of the console; all of it is one attribute value", () => {
    const doc = richDoc({ css: `.a::after{content:"x"}`, html: `<p title="&quot;">"AGENT" &amp; <b>x</b></p>` }, { theme: "dark", tokens: TOKENS });
    const m = /^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="([^"]*)"><style>[^<]*<\/style><\/head><body><iframe sandbox="" srcdoc="([^"]*)" title="Page from the agent"><\/iframe><\/body><\/html>$/.exec(doc);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(RICH_CSP); // the outer page: no frame address is allowed (default-src 'none')
    expect(inner(doc)).toContain(`<body><p title="&quot;">"AGENT" &amp; <b>x</b></p></body>`);
  });
  it("in the agent's page the policy is in the head before any text of the agent or of a token", () => {
    const page = inner(richDoc({ css: ".AGENT_CSS{}", html: "<p>AGENT_HTML</p>" }, { theme: "dark", tokens: TOKENS, fontCss: "@font-face{font-family:FONT_CSS}" }));
    const csp = page.indexOf(`<meta http-equiv="Content-Security-Policy" content="${RICH_CSP}">`);
    expect(csp).toBeGreaterThan(0);
    for (const mark of ["AGENT_CSS", "AGENT_HTML", "FONT_CSS", "#111112"]) expect(page.indexOf(mark)).toBeGreaterThan(csp);
    expect(page.startsWith(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"`)).toBe(true);
    expect(page).not.toContain("<script");
  });
});

describe("richDoc", () => {
  it("carries the console's colours for the theme, the base style, then the agent's CSS and content", () => {
    const doc = inner(richDoc({ css: ".a{color:red}", html: "<p class=\"a\">x</p>" }, { theme: "light", tokens: { ...TOKENS, "--ink-0": "#171717" } }));
    expect(doc).toContain(":root{color-scheme:light;");
    expect(doc).toContain("--ink-0:#171717;");
    expect(doc.indexOf(RICH_BASE_CSS)).toBeLessThan(doc.indexOf(".a{color:red}"));
    expect(doc.endsWith(`<style>.a{color:red}</style></head><body><p class="a">x</p></body></html>`)).toBe(true);
  });
  it("a token value that is not a plain colour is left out", () => {
    const doc = inner(richDoc({ css: "", html: "<p>x</p>" }, { theme: "dark", tokens: { ...TOKENS, "--bg-0": "red}</style><script>" } }));
    expect(doc).not.toContain("<script");
    expect(doc).not.toContain("--bg-0:");
  });
  it("the base style makes a table scroll sideways and stacks the two columns on a phone", () => {
    expect(RICH_BASE_CSS).toContain("table{display:block;max-width:100%;");
    expect(RICH_BASE_CSS).toContain("@media (max-width:520px){.cols{grid-template-columns:1fr}}");
  });
});

describe("richHeight", () => {
  it("the agent's wish or the default, capped until the user expands it", () => {
    expect(richHeight(undefined, false)).toBe("360px");
    expect(richHeight(200, false)).toBe("200px");
    expect(richHeight(900, false)).toBe("480px");
    expect(richHeight(900, true)).toBe("max(900px, 80vh)");
    expect(richHeight(10, false)).toBe("80px");
    expect(richHeight(99999, true)).toBe("max(2000px, 80vh)");
    expect(richHeight(Number.NaN, false)).toBe("360px");
  });
});

describe("fetchRichPage", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("reads the page with the user token; null when it cannot be shown", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL) => res(200, { css: "c", html: "h", height: 240 }));
    expect(await fetchRichPage("qabcdefgh", { fetch, storage: { getItem: () => "tok" } })).toEqual({ css: "c", html: "h", height: 240 });
    expect(fetch.mock.calls[0]![0]).toBe("/api/queue/qabcdefgh/page");
    expect(await fetchRichPage("qabcdefgh", { fetch: async () => res(422, { error: "x" }), storage: null })).toBeNull();
    expect(await fetchRichPage("qabcdefgh", { fetch: async () => res(200, { html: 1 }), storage: null })).toBeNull();
  });
});
