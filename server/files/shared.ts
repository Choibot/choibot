// server/files/shared.ts — pure parsing/validation for the shared-docs
// manifest (.choibot/docs.json). No filesystem access; the endpoint in api.ts
// does the realpath/stat work.

export type SharedDocEntry = { path: string; title?: string };

export const MAX_SHARED_DOCS = 50;

const EXT_RE = /\.(md|mdx|markdown|html|htm)$/i;

// "md" for markdown-ish files, "html" for artifacts, null for anything else.
export function sharedDocKind(path: string): "md" | "html" | null {
  const m = EXT_RE.exec(path);
  if (!m) return null;
  return /^htm/i.test(m[1]) ? "html" : "md";
}

// Parse the manifest: a JSON array whose items are either a repo-relative
// path string or { path, title? }. Anything malformed — bad JSON, non-array,
// junk items, absolute paths, ".." traversal, disallowed extensions,
// duplicates — degrades to "entry dropped" / "empty list", never an error:
// the manifest is agent-written and must fail soft.
export function parseDocsManifest(raw: string): SharedDocEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: SharedDocEntry[] = [];
  for (const item of data) {
    if (out.length >= MAX_SHARED_DOCS) break;
    let path: unknown;
    let title: unknown;
    if (typeof item === "string") path = item;
    else if (item && typeof item === "object") {
      path = (item as { path?: unknown }).path;
      title = (item as { title?: unknown }).title;
    }
    if (typeof path !== "string") continue;
    const p = path.replace(/^\.\//, "");
    if (!p || p.startsWith("/") || p.split("/").includes("..")) continue;
    if (sharedDocKind(p) === null) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    const t = typeof title === "string" ? title.trim() : "";
    out.push(t ? { path: p, title: t } : { path: p });
  }
  return out;
}
