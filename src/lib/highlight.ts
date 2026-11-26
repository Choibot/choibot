// src/lib/highlight.ts — syntax highlighting shared by the diff/file views.
// Mirrors FileExplorer's approach (highlight.js common bundle + a per-line
// span-balancing splitter) so colours match across the app. The colours of the
// hljs classes are the console's own (globals.css, both themes).
import hljs from "highlight.js/lib/common";

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", less: "less",
  html: "xml", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rs: "rust", go: "go", rb: "ruby", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  sql: "sql", graphql: "graphql", gql: "graphql", dockerfile: "dockerfile",
};

export function langFor(name: string): string | undefined {
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : base.toLowerCase();
  return EXT_LANG[ext];
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Highlight `code` and return one HTML string per line, re-opening any hljs
// spans left open at a line boundary so each line is independently valid HTML.
// `lang` from langFor(); falls back to highlightAuto for modest files, else to
// plain escaped text. Always escapes, so the output is safe to inject.
export function highlightToLines(code: string, lang: string | undefined): string[] {
  const lineCount = code.length - code.replace(/\n/g, "").length + 1;
  let html: string | null = null;
  try {
    if (lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } else if (lineCount <= 3000) {
      html = hljs.highlightAuto(code).value;
    }
  } catch {
    html = null;
  }
  if (html === null) return code.split("\n").map(escapeHtml);

  const out: string[] = [];
  const openStack: string[] = [];
  let buf = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === "<") {
      const close = html.indexOf(">", i);
      if (close < 0) { buf += html.slice(i); break; }
      const tag = html.slice(i, close + 1);
      if (/^<span\b/i.test(tag)) openStack.push(tag);
      else if (/^<\/span>/i.test(tag)) openStack.pop();
      buf += tag;
      i = close + 1;
    } else if (ch === "\n") {
      let line = buf;
      for (let k = 0; k < openStack.length; k++) line += "</span>";
      out.push(line);
      buf = openStack.join("");
      i += 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  let line = buf;
  for (let k = 0; k < openStack.length; k++) line += "</span>";
  out.push(line);
  return out;
}
