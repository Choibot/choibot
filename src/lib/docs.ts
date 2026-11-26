// src/lib/docs.ts — pure helpers for the agent Docs (markdown) viewer.

// Markdown-ish extensions the Docs list picks up from the repo file list.
const MD_RE = /\.(md|mdx|markdown)$/i;

export function isMarkdownPath(rel: string): boolean {
  return MD_RE.test(rel);
}

// Shared HTML artifacts (rendered in a sandboxed iframe by the Docs view).
const HTML_RE = /\.(html|htm)$/i;

export function isHtmlPath(rel: string): boolean {
  return HTML_RE.test(rel);
}

// Resolve a link found inside a rendered doc to a repo-relative path.
// `fromFile` is the repo-relative path of the doc being viewed. Returns null
// for links that aren't repo-relative (absolute URLs, mailto, pure anchors).
// A leading "/" is treated as repo-root-relative (common in docs). ".."
// segments are folded and cannot climb above the repo root.
export function resolveDocHref(fromFile: string, href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return null;
  }
  let clean = href.split("#")[0].split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* keep the raw form */
  }
  if (!clean) return null;
  const baseDir = clean.startsWith("/")
    ? ""
    : fromFile.includes("/")
      ? fromFile.slice(0, fromFile.lastIndexOf("/") + 1)
      : "";
  const out: string[] = [];
  for (const part of (baseDir + clean).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.length > 0 ? out.join("/") : null;
}
