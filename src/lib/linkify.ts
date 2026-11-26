// src/lib/linkify.ts — splits plain (agent-written, untrusted) text into text and
// http(s) link parts. No HTML is parsed: the caller renders each part as a React text
// node or an <a>. Only http:// and https:// become links (no javascript:, data:, file:).
export type TextPart = { text: string } | { url: string; text: string };

// A URL starts at a word boundary that is not a letter or digit, so "xhttps://…" stays text.
const URL_RE = /(?<![A-Za-z0-9])https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "]", "}", ">"]);

const count = (s: string, c: string): number => s.split(c).length - 1;

// Drop sentence punctuation after a URL; keep a ")" only while the URL opened one.
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (TRAILING.has(last)) url = url.slice(0, -1);
    else if (last === ")" && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
    else return url;
  }
}

function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

export function linkParts(s: string): TextPart[] {
  const out: TextPart[] = [];
  let text = "";
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const start = m.index ?? 0;
    text += s.slice(at, start);
    if (isWebUrl(url)) {
      if (text) out.push({ text });
      text = "";
      out.push({ url, text: url });
    } else {
      text += url;
    }
    at = start + url.length;
  }
  text += s.slice(at);
  if (text) out.push({ text });
  return out;
}
