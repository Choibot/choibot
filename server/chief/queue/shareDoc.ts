// server/chief/queue/shareDoc.ts — the one HTML file of a ticket that can go outside (share.ts):
// the title, the body as the first block, then the ticket's page. It is built only from the
// queue's stored copy, checked again here (rich.ts checkRich), never from text the browser sends.
// The file is whole by itself: the console's base style and its two fonts are inside it, it holds
// no script and loads nothing (the policy of the frame, src/lib/richTicket.ts RICH_CSP). It shows
// in the light theme, and in the dark theme when the reader's device asks for it.
import { readFile } from "node:fs/promises";
import { renderMessageMarkdown } from "../../../src/lib/markdown.js";
import { RICH_BASE_CSS, RICH_CSP, RICH_TOKENS } from "../../../src/lib/richTicket.js";
import { checkRich, type RichPage } from "./rich.js";

export type ShareSource = { title: string; body: string; page: RichPage | null };
export type ShareLook = { fontCss: string; light: Record<string, string>; dark: Record<string, string> };

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The body as the Queue shows it (markdown, each line on its own line), written again by checkRich:
// a link becomes its text and its address, as in the frame. The parser's link and table attributes
// that the check does not take are changed first. Any refusal: the body as plain text.
export function bodyHtml(body: string): string {
  if (!body.trim()) return "";
  const md = renderMessageMarkdown(body, { breaks: true })
    .replace(/ target="_blank" rel="noopener noreferrer"/g, "")
    .replace(/ align="(left|right|center)"/g, ' style="text-align:$1"')
    .replace(/<input checked="" disabled="" type="checkbox">/g, "☑")
    .replace(/<input disabled="" type="checkbox">/g, "☐");
  const c = checkRich(md);
  if (c.ok && c.page.css === "") return c.page.html;
  return `<p>${escapeText(body).replace(/\r?\n/g, "<br>")}</p>`;
}

const TOKEN_VALUE = /^[#\w\s.,()%/-]{1,80}$/;
const tokenCss = (t: Record<string, string>): string =>
  RICH_TOKENS.map((k) => (TOKEN_VALUE.test(t[k] ?? "") ? `${k}:${t[k]!.trim()};` : "")).join("");

// A standalone page around the frame's base style: a column of reading width.
const DOC_CSS = `
html{background:var(--bg-1)}
body{max-width:820px;margin:0 auto;padding:40px 24px 64px}
.share-title{margin:0 0 12px;color:var(--ink-0);font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-0.015em}
.share-head{margin:0 0 20px;padding:0 0 18px;border-bottom:1px solid var(--line)}
.share-head>:last-child{margin-bottom:0}
@media (max-width:600px){body{padding:24px 16px 40px}.share-title{font-size:19px}}
`;

/** The file. Pure: the caller gives the look (fonts and colours, loadLook). */
export function shareHtml(src: ShareSource, look: ShareLook): string {
  const title = escapeText(src.title.replace(/\s+/g, " ").trim() || "Shared page");
  const head = `<header class="share-head"><h1 class="share-title">${title}</h1>${bodyHtml(src.body)}</header>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${RICH_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">` +
    `<title>${title}</title>` +
    `<style>${look.fontCss}:root{color-scheme:light dark;${tokenCss(look.light)}}` +
    `@media (prefers-color-scheme:dark){:root{${tokenCss(look.dark)}}}${RICH_BASE_CSS}${DOC_CSS}</style>` +
    (src.page ? `<style>${src.page.css}</style>` : "") +
    `</head><body>${head}${src.page ? src.page.html : ""}</body></html>`
  );
}

// --- the console's look, read once from its own files ---------------------------------------

const asset = (rel: string): URL => new URL(`../../../src/app/${rel}`, import.meta.url);

// The `--name: value` pairs of every `<selector> {` block of a style sheet (comments dropped).
export function cssVars(css: string, selector: string): Record<string, string> {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (let at = flat.indexOf(`${selector} {`); at >= 0; at = flat.indexOf(`${selector} {`, at + 1)) {
    const end = flat.indexOf("}", at);
    if (end < 0) break;
    for (const m of flat.slice(at, end).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

let look: Promise<ShareLook> | null = null;
async function readLook(): Promise<ShareLook> {
  const css = await readFile(asset("globals.css"), "utf8").catch(() => "");
  const dark = cssVars(css, ":root");
  const light = { ...dark, ...cssVars(css, ':root[data-theme="light"]') };
  const face = async (name: string, file: string): Promise<string> => {
    const data = await readFile(asset(`fonts/${file}`)).catch(() => null);
    return data ? `@font-face{font-family:"${name}";src:url(data:font/woff2;base64,${data.toString("base64")}) format("woff2");font-weight:100 900;font-display:block}` : "";
  };
  const fontCss = (await face("Console Sans", "Geist-Variable.woff2")) + (await face("Console Mono", "GeistMono-Variable.woff2"));
  return { fontCss, light, dark };
}
/** The console's fonts and its light and dark colours (a missing file: the system's fonts). */
export const loadLook = (): Promise<ShareLook> => (look ??= readLook());

/** The file of a stored item: `pageSource` is the stored copy of its page (null: no page). */
export async function buildShareFile(item: { title: string; body: string }, pageSource: string | null): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  let page: RichPage | null = null;
  if (pageSource !== null) {
    const c = checkRich(pageSource);
    if (!c.ok) return { ok: false, error: "The page of this ticket did not pass the check, so it cannot go out." };
    page = c.page;
  }
  return { ok: true, html: shareHtml({ title: item.title, body: item.body, page }, await loadLook()) };
}
