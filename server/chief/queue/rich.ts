// server/chief/queue/rich.ts — the check of a ticket's rich part (an HTML page an agent wrote).
// The page is shown beside the user's answer and Merge buttons, so this is a security boundary.
// It is the FIRST wall only: the Queue shows the page in an <iframe sandbox> with no script and
// no network (src/lib/richTicket.ts), and that wall holds when this one fails.
//
// checkRich reads the source with a small strict reader and writes it again in one plain form:
// every `<` of the output is written here, with a tag of the allow list; every attribute value is
// in double quotes with `&`, `"`, `<` and `>` escaped; a `<` of the text becomes `&lt;`. No tag of
// the allow list changes how a browser reads the text after it (no script, textarea, title, svg,
// math, …), so a browser reads the output as the same tags this file wrote. The CSS of all
// <style> blocks is returned apart (the page builder puts it in the head) and can hold no `<`.
//
// Anything outside the allow list is REFUSED with a plain reason for the agent. Nothing unsafe is
// repaired. Two things are changed, and the prompt says so: a comment is dropped, and a link
// becomes plain text followed by its address (a link in the frame would load an outside page).
// Pure: no I/O.

export const RICH_MAX_BYTES = 300 * 1024;
export const RICH_MAX_TEXT = "300 KB";
export const RICH_HEIGHT_MIN = 80, RICH_HEIGHT_MAX = 2000;
// With a page, the body is a short summary of the page (one main form per ticket: the owner's ask
// of 2026-11-26). schema.ts refuses a longer body at add time; the prompt names the same number.
export const RICH_BODY_MAX = 500;

export type RichPage = { css: string; html: string };
export type RichResult = { ok: true; page: RichPage } | { ok: false; error: string };

const VOID = new Set(["br", "hr", "img", "col", "wbr"]);
const TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img",
  "ins", "kbd", "li", "main", "mark", "meter", "nav", "ol", "p", "pre", "progress", "q", "s", "samp", "section", "small", "span",
  "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);
const GLOBAL_ATTRS = new Set(["class", "id", "style", "title", "lang", "dir", "role", "hidden"]);
const TAG_ATTRS: Record<string, string[]> = {
  a: ["href"], img: ["src", "alt", "width", "height"], td: ["colspan", "rowspan", "headers"], th: ["colspan", "rowspan", "headers", "scope"],
  col: ["span"], colgroup: ["span"], ol: ["start", "reversed", "type"], li: ["value"], details: ["open"], time: ["datetime"],
  meter: ["value", "min", "max", "low", "high", "optimum"], progress: ["value", "max"],
};
// The reason for a tag the list does not hold. A tag with no line here gets the general reason.
const NO_SCRIPT = "no script runs in a ticket page";
const NO_OUTSIDE = "a ticket page loads nothing from outside";
const NO_CONTROL = "nothing in a ticket page can act: the answer and the buttons are the console's";
const FRAGMENT = "write only the content and <style> blocks: the console writes the page around it";
const TAG_REASON: Record<string, string> = {
  html: FRAGMENT, head: FRAGMENT, body: FRAGMENT,
  script: NO_SCRIPT, noscript: NO_SCRIPT,
  meta: "the console sets the charset, the viewport and the security policy", base: NO_OUTSIDE, link: `${NO_OUTSIDE}: put the CSS in a <style> block`,
  iframe: NO_OUTSIDE, frame: NO_OUTSIDE, object: NO_OUTSIDE, embed: NO_OUTSIDE, video: NO_OUTSIDE, audio: NO_OUTSIDE, source: NO_OUTSIDE,
  form: NO_CONTROL, input: NO_CONTROL, button: NO_CONTROL, select: NO_CONTROL, textarea: NO_CONTROL, label: NO_CONTROL,
  svg: 'inline SVG is not allowed: use an <img> with a data:image/svg+xml address', math: "MathML is not allowed",
  title: "the ticket's title is the title",
};

const IMG_SRC = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i;
const LINK_HREF = /^https?:\/\/[^\s"'<>`\\]+$/i;
const ATTR_NAME = /^[a-z][a-z0-9-]*$/;

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

// --- text and attribute values -------------------------------------------------------------

// A character reference a browser would read (`&amp;`, `&#38;`, `&#x26;`, `&nbsp;`), kept as written
// in text. In text it can only make a character, never a tag.
const CHAR_REF = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;
function escapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === "&") {
      const m = CHAR_REF.exec(s.slice(i, i + 40));
      if (m) { out += m[0]; i += m[0].length - 1; } else out += "&amp;";
    } else out += c;
  }
  return out;
}

// The value of an attribute as this file reads it: number references and the five basic names are
// decoded; any other `&name;` stays as its letters. The output then escapes this very string, so
// a browser reads back exactly the value that was checked (never a second decoding).
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeAttr(s: string): string {
  return s.replace(/&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name]!;
    const n = dec ? Number(dec) : parseInt(hex!, 16);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
  });
}
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- CSS ------------------------------------------------------------------------------------

// The reason a piece of CSS is refused, or null. A plain text scan after CSS escapes are decoded
// (`\75 rl(` is `url(`), stricter than a browser: a word in a string or a comment counts too. The
// frame's policy is the wall for CSS (no network at all): this scan gives the agent the reason.
export function cssProblem(css: string): string | null {
  if (css.includes("<")) return 'CSS must not hold "<" (write \\3c )';
  const flat = css.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/g, (_all, hex: string) => {
    const n = parseInt(hex, 16);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  }).replace(/\\(.)/gs, "$1").toLowerCase();
  if (flat.includes("@import")) return `@import is not allowed: ${NO_OUTSIDE}`;
  if (flat.includes("@font-face")) return "@font-face is not allowed: the page uses the console's fonts";
  if (/image-set\s*\(|(^|[^a-z-])src\s*\(/.test(flat)) return `image-set() and src() are not allowed: ${NO_OUTSIDE}`;
  for (const m of flat.matchAll(/url\s*\(\s*(["']?)\s*([^)"']{0,40})/g)) {
    if (!IMG_SRC.test(m[2]!)) return `url() must be a data: image (found url(${short(m[2]!.trim())})): ${NO_OUTSIDE}`;
  }
  return null;
}

// --- the reader -----------------------------------------------------------------------------

type Attr = { name: string; value: string | null };

// Reads the attributes of a start tag from `i` (just after the tag name). Returns the index after
// the closing `>`, or an error text.
function readAttrs(s: string, i: number, tag: string): { end: number; attrs: Attr[]; selfClose: boolean } | string {
  const attrs: Attr[] = [];
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  for (;;) {
    while (isSpace(s[i])) i++;
    if (i >= s.length) return `<${tag}> is not closed with ">"`;
    if (s[i] === ">") return { end: i + 1, attrs, selfClose: false };
    if (s[i] === "/" && s[i + 1] === ">") return { end: i + 2, attrs, selfClose: true };
    const start = i;
    while (i < s.length && !isSpace(s[i]) && !'"\'<>/='.includes(s[i]!)) i++;
    const name = s.slice(start, i).toLowerCase();
    if (i === start || !ATTR_NAME.test(name)) return `<${tag}> has an attribute this reader does not understand near ${JSON.stringify(short(s.slice(start, start + 20)))}`;
    while (isSpace(s[i])) i++;
    if (s[i] !== "=") { attrs.push({ name, value: null }); continue; }
    i++;
    while (isSpace(s[i])) i++;
    const q = s[i];
    if (q === '"' || q === "'") {
      const close = s.indexOf(q, i + 1);
      if (close < 0) return `the attribute "${name}" of <${tag}> has no closing quote`;
      attrs.push({ name, value: s.slice(i + 1, close) });
      i = close + 1;
    } else {
      const vs = i;
      while (i < s.length && !isSpace(s[i]) && !'"\'<>=`'.includes(s[i]!)) i++;
      if (i === vs) return `the attribute "${name}" of <${tag}> has no value`;
      attrs.push({ name, value: s.slice(vs, i) });
    }
  }
}

// The checked attributes of one tag as output text (with a leading space each), or an error.
function writeAttrs(tag: string, attrs: Attr[]): { text: string; href?: string } | { error: string } {
  const seen = new Set<string>();
  let text = "", href: string | undefined;
  for (const a of attrs) {
    const { name } = a;
    if (seen.has(name)) return { error: `<${tag}> has the attribute "${name}" twice` };
    seen.add(name);
    if (name.startsWith("on")) return { error: `the event handler "${name}" on <${tag}> is not allowed: ${NO_SCRIPT}` };
    const allowed = GLOBAL_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-") || (TAG_ATTRS[tag]?.includes(name) ?? false);
    if (!allowed) return { error: `the attribute "${name}" on <${tag}> is not allowed` };
    const value = a.value === null ? "" : decodeAttr(a.value);
    if (name === "style") {
      const why = cssProblem(value);
      if (why) return { error: `the style of <${tag}>: ${why}` };
    } else if (name === "src") {
      if (!IMG_SRC.test(value)) return { error: `the src of an <img> must be a data: image (png, jpeg, gif, webp, svg) inside the file, not ${JSON.stringify(short(value))}: ${NO_OUTSIDE}` };
    } else if (name === "href") {
      if (/^\s*javascript:/i.test(value)) return { error: `a javascript: address is not allowed: ${NO_SCRIPT}` };
      if (!LINK_HREF.test(value)) return { error: `the address of a link must be a full http(s) address, not ${JSON.stringify(short(value))}` };
      href = value; // not written as an attribute: a link shows as text and its address
      continue;
    }
    text += a.value === null ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
  }
  return href === undefined ? { text } : { text, href };
}

/**
 * The checked page of a rich part, or the reason it is refused (a plain sentence for the agent).
 * The same function runs when an agent adds the ticket and each time the Queue reads the stored
 * copy, so a copy changed on disk gets the same check.
 */
export function checkRich(source: string): RichResult {
  if (Buffer.byteLength(source, "utf8") > RICH_MAX_BYTES) return fail(`the page is larger than ${RICH_MAX_TEXT} (the limit of a ticket page)`);
  let s = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  s = s.replace(/\r\n?/g, "\n");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(s)) return fail("the page holds control characters: it must be plain HTML text");
  let html = "", css = "";
  let link: { href: string; text: string } | null = null; // the open <a href>, and its text so far
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const text = s.slice(i, lt < 0 ? s.length : lt);
    if (text) { html += escapeText(text); if (link) link.text += text; }
    if (lt < 0) break;
    i = lt;
    const next = s[i + 1] ?? "";
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end < 0) return fail("a comment (<!--) is not closed");
      i = end + 3;
      continue;
    }
    if (/^<!doctype/i.test(s.slice(i, i + 9))) return fail(`<!doctype> is not allowed: ${FRAGMENT}`);
    if (next === "!" || next === "?") return fail(`"${short(s.slice(i, i + 12))}" is not allowed: write plain HTML`);
    if (next === "/") {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)[ \t\n\f]*>/.exec(s.slice(i, i + 80));
      if (!m) return fail(`an end tag is not well formed near ${JSON.stringify(short(s.slice(i, i + 20)))}`);
      const tag = m[1]!.toLowerCase();
      i += m[0].length;
      if (!TAGS.has(tag) || VOID.has(tag)) return fail(`</${tag}> is not allowed${TAG_REASON[tag] ? `: ${TAG_REASON[tag]}` : ""}`);
      if (tag === "a") {
        if (!link) return fail("</a> has no <a> before it");
        const same = link.text.trim() === link.href;
        html += same || link.href === "" ? "</span>" : `</span> <span class="link-addr">${escapeText(link.href)}</span>`;
        link = null;
      } else html += `</${tag}>`;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) { html += "&lt;"; if (link) link.text += "<"; i++; continue; } // a "<" of the text ("a < b")
    const nm = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(s.slice(i, i + 80))!;
    const tag = nm[1]!.toLowerCase();
    if (tag !== "style" && !TAGS.has(tag)) return fail(`<${tag}> is not allowed${TAG_REASON[tag] ? `: ${TAG_REASON[tag]}` : ""}`);
    const r = readAttrs(s, i + nm[0].length, tag);
    if (typeof r === "string") return fail(r);
    i = r.end;
    if (tag === "style") {
      if (r.attrs.some((a) => a.name !== "type")) return fail("<style> takes no attribute");
      const m = /<\/style[ \t\n\f]*>/i.exec(s.slice(i));
      if (!m) return fail("<style> is not closed");
      const block = s.slice(i, i + m.index);
      const why = cssProblem(block);
      if (why) return fail(`the CSS of a <style> block: ${why}`);
      css += `${block}\n`;
      i += m.index + m[0].length;
      continue;
    }
    if (r.selfClose && !VOID.has(tag)) return fail(`<${tag}/> is not allowed: write <${tag}></${tag}>`);
    const w = writeAttrs(tag, r.attrs);
    if ("error" in w) return fail(w.error);
    if (tag === "a") {
      if (link) return fail("a link inside a link is not allowed");
      link = { href: w.href ?? "", text: "" };
      // A link shows as its text, then its address: nothing in the frame opens an address.
      html += `<span data-link=""${w.text}>`;
    } else html += `<${tag}${w.text}>`;
  }
  if (link) return fail("<a> is not closed");
  if (html.trim() === "") return fail("the page is empty");
  return { ok: true, page: { css, html } };
}
