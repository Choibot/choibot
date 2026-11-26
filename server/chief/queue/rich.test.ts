import { describe, expect, it } from "vitest";
import { checkRich, cssProblem, RICH_MAX_BYTES } from "./rich.js";

const ok = (src: string) => {
  const r = checkRich(src);
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.page;
};
const refused = (src: string): string => {
  const r = checkRich(src);
  if (r.ok) throw new Error(`accepted: ${r.page.html}`);
  return r.error;
};

describe("checkRich: what passes", () => {
  it("writes the allowed tags again in one plain form and returns the CSS apart", () => {
    const p = ok(`<style>.x{color:red}</style>\n<H2 Class='x' id=top>Plan</H2><p>a &amp; b &lt; c &nbsp;</p><table><tr><td colspan="2">1</td></tr></table><br/><hr>`);
    expect(p.css).toBe(".x{color:red}\n");
    expect(p.html).toBe(`\n<h2 class="x" id="top">Plan</h2><p>a &amp; b &lt; c &nbsp;</p><table><tr><td colspan="2">1</td></tr></table><br><hr>`);
  });
  it("escapes every < > and stray & of the text", () => {
    expect(ok("<p>1 < 2 > 0 & x &bogus &#x41; <3</p>").html).toBe("<p>1 &lt; 2 &gt; 0 &amp; x &amp;bogus &#x41; &lt;3</p>");
  });
  it("drops a comment", () => {
    expect(ok("<p>a<!-- <script>x</script> -->b</p>").html).toBe("<p>ab</p>");
  });
  it("a link becomes its text and its address: no href reaches the page", () => {
    const p = ok(`<p><a href="https://example.com/x?a=1&amp;b=2" class="k">the PR</a> and <a href="https://example.com/">https://example.com/</a> and <a>none</a></p>`);
    expect(p.html).toBe(`<p><span data-link="" class="k">the PR</span> <span class="link-addr">https://example.com/x?a=1&amp;b=2</span> and <span data-link="">https://example.com/</span> and <span data-link="">none</span></p>`);
    expect(p.html).not.toContain("href");
  });
  it("an attribute value is decoded once, checked, and written escaped", () => {
    expect(ok(`<p title='a "q" &lt;b&gt; &#38; &unknown;'>x</p>`).html).toBe(`<p title="a &quot;q&quot; &lt;b&gt; &amp; &amp;unknown;">x</p>`);
  });
  it("a data: image and inline styles with data: images pass", () => {
    const p = ok(`<img src="data:image/png;base64,AAAA" alt="shot" width="10"><div style="background:url('data:image/svg+xml,%3Csvg/%3E')">x</div>`);
    expect(p.html).toContain(`<img src="data:image/png;base64,AAAA" alt="shot" width="10">`);
  });
  it("details, checks and the base classes pass", () => {
    ok(`<details open><summary>More</summary><ul class="checks"><li class="done">a</li></ul></details><span class="badge"><i class="dot ok"></i>ok</span><div class="cols"><div>a</div><div>b</div></div><div class="callout" role="note" aria-label="x" data-x="1">c</div>`);
  });
});

describe("checkRich: what is refused, with a plain reason", () => {
  const cases: [string, string, RegExp][] = [
    ["a script", "<p>x</p><script>alert(1)</script>", /<script> is not allowed: no script runs/],
    ["a script with odd attributes", `<script src=//evil.example/x.js async></script>`, /<script> is not allowed/],
    ["a script end tag alone", "</script>", /<\/script> is not allowed/],
    ["an event handler", `<img src="data:image/png;base64,AA" onerror="alert(1)">`, /event handler "onerror" on <img> is not allowed/],
    ["an event handler in capitals", `<div ONCLICK=x()>x</div>`, /event handler "onclick"/],
    ["a javascript: link", `<a href="javascript:alert(1)">x</a>`, /javascript: address is not allowed/],
    ["a javascript: link written with references", `<a href="&#106;avascript:alert(1)">x</a>`, /javascript: address is not allowed/],
    ["a javascript: link with a tab", `<a href="java&#9;script:alert(1)">x</a>`, /full http\(s\) address/],
    ["a data:text/html link", `<a href="data:text/html,<script>alert(1)</script>">x</a>`, /full http\(s\) address/],
    ["a relative link", `<a href="/api/queue">x</a>`, /full http\(s\) address/],
    ["a meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example/">`, /<meta> is not allowed/],
    ["a base", `<base href="https://evil.example/">`, /<base> is not allowed/],
    ["a link tag", `<link rel="stylesheet" href="https://evil.example/x.css">`, /<link> is not allowed/],
    ["an iframe", `<iframe src="https://evil.example/"></iframe>`, /<iframe> is not allowed/],
    ["an object", `<object data="x"></object>`, /<object> is not allowed/],
    ["an embed", `<embed src="x">`, /<embed> is not allowed/],
    ["a form", `<form action="https://evil.example/"><input name="a"></form>`, /<form> is not allowed: nothing in a ticket page can act/],
    ["a button", `<button>Merge</button>`, /<button> is not allowed: nothing in a ticket page can act/],
    ["an input", `<input type="checkbox">`, /<input> is not allowed/],
    ["inline SVG", `<svg onload="alert(1)"><script>1</script></svg>`, /<svg> is not allowed/],
    ["MathML", `<math><mi>x</mi></math>`, /<math> is not allowed/],
    ["an outside image", `<img src="https://evil.example/p.png">`, /src of an <img> must be a data: image/],
    ["a data:text/html image", `<img src="data:text/html,<b>x</b>">`, /must be a data: image/],
    ["an srcset", `<img src="data:image/png;base64,AA" srcset="https://evil.example/p.png 2x">`, /attribute "srcset" on <img> is not allowed/],
    ["a whole document", `<!doctype html><html><body>x</body></html>`, /<!doctype> is not allowed: write only the content/],
    ["an html tag", `<html lang="en"><p>x</p></html>`, /<html> is not allowed: write only the content/],
    ["a title", `<title>x</title>`, /<title> is not allowed/],
    ["a textarea", `<textarea></textarea>`, /<textarea> is not allowed/],
    ["a template", `<template><p>x</p></template>`, /<template> is not allowed/],
    ["a custom element", `<x-a>1</x-a>`, /<x-a> is not allowed/],
    ["an unknown attribute", `<p contenteditable>x</p>`, /attribute "contenteditable" on <p> is not allowed/],
    ["a second attribute of one name", `<p class="a" class="b">x</p>`, /has the attribute "class" twice/],
    ["a CDATA or a processing instruction", `<![CDATA[x]]>`, /is not allowed: write plain HTML/],
    ["an unclosed tag", `<p class="x`, /no closing quote/],
    ["an unclosed comment", `<p>x</p><!-- `, /comment .* is not closed/],
    ["an unclosed link", `<a href="https://example.com/">x`, /<a> is not closed/],
    ["a link in a link", `<a href="https://a.example/">x<a href="https://b.example/">y</a></a>`, /link inside a link/],
    ["a self-closed div", `<div/>`, /<div\/> is not allowed/],
    ["a NUL", "<p>x\u0000</p>", /control characters/],
    ["an empty page", `<style>p{}</style>  `, /page is empty/],
    ["an @import", `<style>@import url("https://evil.example/x.css");</style><p>x</p>`, /@import is not allowed/],
    ["an @import written with escapes", `<style>@\\69mport "https://evil.example/x.css";</style><p>x</p>`, /@import is not allowed/],
    ["an outside url() in a style block", `<style>p{background:url(https://evil.example/p.png)}</style><p>x</p>`, /url\(\) must be a data: image/],
    ["an outside url() written with escapes", `<style>p{background:\\75rl(https://evil.example/p.png)}</style><p>x</p>`, /url\(\) must be a data: image/],
    ["an outside url() in a style attribute", `<p style="background:url('//evil.example/p.png')">x</p>`, /the style of <p>: url\(\) must be a data: image/],
    ["an image-set()", `<p style='background:image-set("https://evil.example/p.png" 1x)'>x</p>`, /image-set\(\)/],
    ["a font face", `<style>@font-face{font-family:x;src:url(data:font/woff2;base64,AA)}</style><p>x</p>`, /@font-face is not allowed/],
    ["a style block that ends a tag", `<style>p{}</style x><p>x</p>`, /<style> is not closed|is not allowed/],
    ["a < in CSS", `<style>p::after{content:"<b>"}</style><p>x</p>`, /CSS must not hold "<"/],
  ];
  for (const [name, src, re] of cases) it(name, () => { expect(refused(src)).toMatch(re); });

  it("a page over the limit, with the limit in the reason", () => {
    expect(refused(`<p>${"a".repeat(RICH_MAX_BYTES)}</p>`)).toMatch(/larger than 300 KB/);
  });
});

describe("checkRich: the output is safe by its form", () => {
  // Whatever goes in, the output has only tags of the allow list, no handler and no address but a data: image.
  const HOSTILE = [
    `<p title="x"><script>alert(1)</script>">y</p>`,
    `<p title='</p><script>alert(1)</script>'>y</p>`,
    `<p>x</p <script>alert(1)</script>`,
    `<p><!--><script>alert(1)</script>-->y</p>`,
    `<p title="a" onclick=alert(1)>y</p>`,
    `<p/onclick=alert(1)>y</p>`,
    `<img src="data:image/png;base64,AA" title="x" src="https://evil.example/">`,
    `<p title=x\`onmouseover=alert(1)>y</p>`,
    `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`,
    `<p>&#60;script&#62;alert(1)</p>`,
    `<div style="x:expression(alert(1))" title="&quot; onclick=&quot;alert(1)">y</div>`,
    `<a href="https://example.com/&quot; onclick=&quot;alert(1)">y</a>`,
  ];
  for (const src of HOSTILE) {
    it(`no script, handler or outside address in the output of ${src.slice(0, 40)}`, () => {
      const r = checkRich(src);
      if (!r.ok) return; // refused: nothing is stored
      const out = r.page.html;
      // Every tag of the output is one this file wrote.
      for (const m of out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) expect(["p", "div", "span", "img"]).toContain(m[1]);
      // Outside the quoted values there is no attribute named on*, href or a second src.
      const bare = out.replace(/"[^"]*"/g, '""');
      expect(bare).not.toMatch(/\son[a-z]+\s*=/i);
      expect(bare).not.toMatch(/\shref\s*=/i);
      expect(out).not.toMatch(/src="(?!data:image\/)/);
    });
  }
  it("the same check accepts its own output and does not change it (the read of the stored copy)", () => {
    const first = ok(`<h2>A</h2><p><a href="https://example.com/a">x</a> 1 < 2</p><ul class="checks"><li class="done">a`);
    expect(ok(first.html).html).toBe(first.html);
  });
});

describe("cssProblem", () => {
  it("passes plain CSS and data: images", () => {
    expect(cssProblem(`.a{color:var(--ink-0);position:fixed;background:url("data:image/png;base64,AA")} @media (max-width:520px){.a{display:none}}`)).toBeNull();
  });
  it("a property with src in its name is not src()", () => {
    expect(cssProblem(".a{--my-src:1;mask-source-type:auto}")).toBeNull();
  });
});
