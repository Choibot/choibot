import { describe, it, expect } from "vitest";
import { docsParser, renderMessageMarkdown } from "./markdown";

describe("renderMessageMarkdown", () => {
  it("renders tables, lists, inline code and emphasis", () => {
    const html = renderMessageMarkdown("**Done.**\n\n| Check | Result |\n|---|---|\n| CD | OK |\n\n1. one\n2. two\n\nUse `pnpm test`.");
    expect(html).toContain("<strong>Done.</strong>");
    expect(html).toContain("<div data-table><table>");
    expect(html).toContain("</table></div>");
    expect(html).toContain("<th>Check</th>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>pnpm test</code>");
  });
  it("highlights a fenced code block and escapes its content", () => {
    const html = renderMessageMarkdown("```ts\nconst a = \"<b>\";\n```");
    expect(html).toContain('<pre><code class="hljs">');
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("<b>");
  });
  it("shows raw HTML as text, block and inline", () => {
    const html = renderMessageMarkdown("<script>alert(1)</script>\n\nhello <img src=x onerror=alert(1)> <b>bold</b>\n\n<table><tr><td>x</td></tr></table>");
    expect(html).not.toMatch(/<script|<img|<b>|<table>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("data-table"); // an escaped table is not wrapped
  });
  it("opens http, https and mailto links in a new tab, and autolinks a bare URL", () => {
    const html = renderMessageMarkdown("[PR](https://github.com/a/b/pull/1) and https://share.example.com/x and [mail](mailto:a@b.co)");
    expect(html).toContain('<a href="https://github.com/a/b/pull/1" target="_blank" rel="noopener noreferrer">PR</a>');
    expect(html).toContain('<a href="https://share.example.com/x" target="_blank" rel="noopener noreferrer">');
    expect(html).toContain('href="mailto:a@b.co"');
  });
  it("drops the address of any other link and keeps its text", () => {
    const html = renderMessageMarkdown("[x](javascript:alert(1)) [y](/api/agents/a/delete) [z](data:text/html,hi) [w](JaVaScRiPt:1)");
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/href/i);
    expect(html).toMatch(/x.*y.*z.*w/s);
  });
  it("escapes a quote in a link address", () => {
    const html = renderMessageMarkdown('[a](<https://x.co/"onmouseover="alert(1)>)');
    expect(html).not.toContain('"onmouseover="');
  });
  it("never emits an image: it becomes a link, or text when the address is not http", () => {
    const html = renderMessageMarkdown("![chart](https://evil.example/p.png?d=secret) ![local](.choibot/shot.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://evil.example/p.png?d=secret" target="_blank" rel="noopener noreferrer">[image: chart]</a>');
    expect(html).toContain("[image: local]");
  });
});

describe("renderMessageMarkdown with breaks (a queue ticket's body)", () => {
  it("keeps each line of a plain body on its own line", () => {
    const html = renderMessageMarkdown("A: one\nB: two\n\nNext part.", { breaks: true });
    expect(html).toContain("A: one<br>B: two");
    expect(html).toContain("<p>Next part.</p>");
  });
  it("without the option a single line end stays a space, as in the thread", () => {
    expect(renderMessageMarkdown("A: one\nB: two")).not.toContain("<br>");
  });
  it("the safety rules stay: raw HTML is text, an image is a link, a link opens only http(s) or mailto", () => {
    const html = renderMessageMarkdown("<b>x</b> [queue <id>]\n![shot](https://e.example/a.png)\n[bad](javascript:alert(1)) https://share.example.com/p#pw=AB-CD", { breaks: true });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;id&gt;");
    expect(html).toContain('<a href="https://e.example/a.png" target="_blank" rel="noopener noreferrer">[image: shot]</a>');
    expect(html).toContain('<a href="https://share.example.com/p#pw=AB-CD" target="_blank" rel="noopener noreferrer">');
  });
});

describe("docsParser", () => {
  it("keeps the Docs panel's render: heading ids and highlighted code", () => {
    const html = docsParser.parse("# Install it\n\n```sh\nls\n```", { async: false });
    expect(html).toContain('<h1 id="install-it">Install it</h1>');
    expect(html).toContain('<pre><code class="hljs">');
  });
});
