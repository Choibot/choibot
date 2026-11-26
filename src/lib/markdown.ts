// src/lib/markdown.ts — the markdown parsers of the console. Pure string →
// HTML string (marked + highlight.js), so they run in tests; the caller passes
// the result through DOMPurify before it reaches the DOM.
//   - docsParser: the Docs panel's parser for repo documents (raw HTML is kept
//     for DOMPurify to filter, headings get ids for anchor links).
//   - renderMessageMarkdown: for agent messages in the thread view. An agent's
//     text is less trusted than a repo doc and is rendered on every look at the
//     agent: raw HTML shows as text, an image never loads (it becomes a link),
//     and a link opens only http, https or mailto, in a new tab.
import { Marked, type Tokens } from "marked";
import hljs from "highlight.js/lib/common";

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const escapeAttr = (str: string): string => escapeHtml(str).replace(/"/g, "&quot;");

// GitHub-flavoured heading slug, so TOC links like [Install](#install) land.
function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/<[^>]*>/g, "").replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-");
}

// Fenced code goes through hljs (same bundle as the diff views) so colours
// match the rest of the app. hljs output is pre-escaped. token.lang is the
// whole fence infostring ("ts twoslash") — only its first word names the language.
function codeBlock({ text, lang }: Pick<Tokens.Code, "text" | "lang">): string {
  const language = (lang ?? "").match(/^\S*/)?.[0];
  const code = text.replace(/\n$/, "");
  let html: string;
  try {
    html = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escapeHtml(code);
  } catch {
    html = escapeHtml(code);
  }
  return `<pre><code class="hljs">${html}</code></pre>`;
}

export const docsParser = new Marked({ gfm: true });
docsParser.use({
  renderer: {
    code: codeBlock,
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${slugify(inner)}">${inner}</h${depth}>`;
    },
  },
});

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

const messageParser = new Marked({ gfm: true });
messageParser.use({
  renderer: {
    code: codeBlock,
    // Raw HTML in a message is shown, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href)) return inner;
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    // No <img>: a remote image would load on every look at the thread, and its
    // URL can carry data out. The address stays reachable as a link.
    image({ href, text }) {
      const label = escapeHtml(`[image: ${text || href}]`);
      if (!SAFE_HREF.test(href)) return label;
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

// A wide table scrolls inside its own box, so it never widens the thread (a
// phone shows it whole by a sideways swipe). Raw HTML is escaped above, so
// every <table> here is one the parser made.
function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div data-table><table>').replace(/<\/table>/g, "</table></div>");
}

// `breaks`: a single line end is a line break. A queue ticket's body is written as plain lines
// ("A: …" / "B: …"), which a paragraph would join; the thread view leaves it off.
export function renderMessageMarkdown(src: string, opts: { breaks?: boolean } = {}): string {
  try {
    return wrapTables(messageParser.parse(src, { async: false, ...(opts.breaks ? { breaks: true } : {}) }));
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`;
  }
}

// DOMPurify options for renderMessageMarkdown output: `target` is kept for the
// new-tab links; nothing that loads or submits survives even if the parser let
// it through.
export const MESSAGE_PURIFY = {
  ADD_ATTR: ["target"],
  FORBID_TAGS: ["img", "picture", "video", "audio", "iframe", "object", "embed", "style", "form", "input", "button", "textarea", "select", "svg", "math"],
  FORBID_ATTR: ["style", "srcset"],
};
