// src/lib/richTicket.ts — the page of a ticket's rich part, as the Queue shows it. The agent wrote
// the content, and the Queue holds the user's device token and the answer and Merge buttons, so
// this file and the frame of QueueRich.tsx are the SECOND wall (the first: the server's check,
// server/chief/queue/rich.ts). This wall holds with any content at all:
//   - the frame is <iframe sandbox=""> (RICH_SANDBOX): no script runs, no form is sent, no popup
//     opens, the top page cannot be moved, the origin is opaque (no cookie, no storage, no parent),
//     and with no script allowed a <meta refresh> does nothing;
//   - the page's policy (RICH_CSP) allows no request at all: only inline CSS, data: images and
//     data: fonts (the console's own two fonts);
//   - the page sits in a second frame, inside a small page of the console with the same policy.
//     A policy cannot stop a page that moves ITSELF to an address (a link that got through), but
//     the policy of the page AROUND a frame can: the outer page allows no frame address at all,
//     so the agent's page cannot go anywhere, also not on a press of the user.
// No script of the console runs in the frame either, so nothing in it can post to the Queue.
// Pure: no DOM (the component reads the colours and the fonts).
import { chiefFetch } from "./chief";

/** The frame's sandbox: empty. Never add a keyword (allow-scripts, allow-same-origin, …). */
export const RICH_SANDBOX = "";
/** No request leaves the frame: no outside image, font, CSS, frame or connection. */
export const RICH_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

export type RichPageData = { css: string; html: string; height?: number };

// The console's colour tokens the page gets as CSS variables (globals.css), read at render time
// for the theme that shows: the page follows the theme with no second fetch.
export const RICH_TOKENS = [
  "--bg-0", "--bg-1", "--bg-2", "--bg-3", "--line", "--line-2", "--ink-0", "--ink-1", "--ink-2",
  "--ok", "--err", "--warn", "--turn", "--idle", "--add", "--del",
] as const;
const TOKEN_VALUE = /^[#\w\s.,()%/-]{1,80}$/;

// The base style: a ticket page looks like the console with little CSS of its own.
// Classes: .callout, .badge, .dot (.ok .warn .err .run), .cols (two columns, one under 520 px),
// .label, .muted, .num, .add, .del, ul.checks (li.done, li.todo, li.fail). A table scrolls
// sideways inside the frame. A link is text and its address (`[data-link]`, `.link-addr`).
export const RICH_BASE_CSS = `
*{box-sizing:border-box}
html{font:400 14px/1.6 "Console Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink-1);background:var(--bg-1);-webkit-text-size-adjust:100%;letter-spacing:-0.003em}
body{margin:0;padding:14px 16px;overflow-wrap:break-word}
body>:first-child{margin-top:0}
body>:last-child{margin-bottom:0}
h1,h2,h3,h4,h5,h6{margin:16px 0 6px;color:var(--ink-0);font-size:14px;font-weight:600;line-height:1.4}
h1{font-size:16px;letter-spacing:-0.01em}
p{margin:0 0 10px}
strong,b{color:var(--ink-0);font-weight:600}
small,.muted{color:var(--ink-2)}
small,.label{font-size:12px}
.label{margin:0 0 4px;color:var(--ink-2)}
ul,ol{margin:0 0 10px;padding-left:20px}
li{margin:2px 0}
hr{border:none;border-top:1px solid var(--line);margin:14px 0}
blockquote{margin:0 0 10px;padding:1px 12px;border-left:2px solid var(--line-2)}
code,kbd,samp,pre{font-family:"Console Mono",ui-monospace,"SF Mono",Menlo,monospace;font-size:12px}
code,kbd{padding:1px 5px;border-radius:4px;background:var(--bg-2);color:var(--ink-0);overflow-wrap:anywhere}
pre{margin:4px 0 10px;padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg-2);color:var(--ink-0);line-height:1.55;overflow-x:auto}
pre code{padding:0;background:none}
img{max-width:100%;height:auto}
table{display:block;max-width:100%;margin:4px 0 10px;overflow-x:auto;border-collapse:collapse;font-size:13px;line-height:1.45}
th,td{padding:5px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--ink-0);font-weight:500;white-space:nowrap;border-bottom-color:var(--line-2)}
td code,th code{overflow-wrap:normal;white-space:nowrap}
caption{padding:0 0 4px;color:var(--ink-2);font-size:12px;text-align:left}
details{margin:0 0 10px}
summary{color:var(--ink-0);cursor:pointer}
[data-link]{color:var(--ink-0);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:2px}
.link-addr{color:var(--ink-2);font-size:12px;overflow-wrap:anywhere}
.callout{margin:0 0 10px;padding:9px 12px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--ink-0)}
.callout>:last-child{margin-bottom:0}
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:1px solid var(--line-2);border-radius:999px;color:var(--ink-1);font-size:12px;line-height:1;white-space:nowrap;vertical-align:middle}
.dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--idle);vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:var(--warn)}.dot.err{background:var(--err)}.dot.run{background:var(--turn)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 10px}
.cols>*{min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:7px}
.cols>*>:last-child{margin-bottom:0}
@media (max-width:520px){.cols{grid-template-columns:1fr}}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.add{color:var(--add)}.del{color:var(--del)}
ul.checks{padding-left:0;list-style:none}
ul.checks li{position:relative;padding-left:22px}
ul.checks li::before{content:"○";position:absolute;left:2px;color:var(--ink-2)}
ul.checks li.done::before{content:"✓";color:var(--ok)}
ul.checks li.fail::before{content:"✕";color:var(--err)}
`;

const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${RICH_CSP}">`;
const escapeAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The whole text for the `srcdoc` of the Queue's frame: the console's outer page, and in it the
 * frame with the agent's page. In both pages the policy is the first thing in the head, before
 * any text of the agent. `fontCss` is the console's own @font-face rules with data: addresses
 * ("" = the system's fonts).
 */
export function richDoc(page: RichPageData, o: { theme: "light" | "dark"; tokens: Record<string, string>; fontCss?: string }): string {
  const scheme = o.theme === "light" ? "light" : "dark";
  const tokens = RICH_TOKENS.map((t) => (TOKEN_VALUE.test(o.tokens[t] ?? "") ? `${t}:${o.tokens[t]!.trim()};` : "")).join("");
  const inner =
    `${HEAD}<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${o.fontCss ?? ""}:root{color-scheme:${scheme};${tokens}}${RICH_BASE_CSS}</style>` +
    `<style>${page.css}</style></head><body>${page.html}</body></html>`;
  return (
    `${HEAD}<style>:root{color-scheme:${scheme}}html,body{height:100%;margin:0;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head>` +
    `<body><iframe sandbox="${RICH_SANDBOX}" srcdoc="${escapeAttr(inner)}" title="Page from the agent"></iframe></body></html>`
  );
}

// The frame's height: the agent's wish or a default, with a cap until the user expands it. No
// script runs in the frame, so the console cannot measure the page: a taller page scrolls inside.
export const RICH_DEFAULT_HEIGHT = 360, RICH_CAP_HEIGHT = 480;
export function richHeight(height: number | undefined, expanded: boolean): string {
  const h = typeof height === "number" && Number.isFinite(height) ? Math.min(Math.max(Math.round(height), 80), 2000) : RICH_DEFAULT_HEIGHT;
  return expanded ? `max(${h}px, 80vh)` : `${Math.min(h, RICH_CAP_HEIGHT)}px`;
}

// GET /api/queue/:id/page: the checked page of an item, or null when it cannot be shown.
export async function fetchRichPage(id: string, deps: { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null } = {}): Promise<RichPageData | null> {
  const res = await chiefFetch(`/api/queue/${encodeURIComponent(id)}/page`, undefined, deps);
  if (!res.ok) return null;
  const b = (await res.json()) as Partial<RichPageData> | null;
  if (!b || typeof b.html !== "string" || typeof b.css !== "string") return null;
  return typeof b.height === "number" ? { css: b.css, html: b.html, height: b.height } : { css: b.css, html: b.html };
}
