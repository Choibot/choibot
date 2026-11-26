// src/components/DocsPanel.tsx
// Agent-shared docs & artifacts: the worktree's .choibot/docs.json manifest names
// what the agent wants surfaced — markdown (rendered with marked + DOMPurify,
// hljs code blocks) or self-contained HTML artifacts (rendered in an
// opaque-origin sandboxed iframe). The panel polls the manifest so new shares
// appear and mtime bumps re-render the open doc live.
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_MAX, useRemembered, viewMemory } from "../lib/viewCache";
import DOMPurify from "dompurify";
import { docsParser as parser, escapeHtml } from "../lib/markdown";
import { allFiles, readFileContent, sharedDocs, type SharedDoc } from "../lib/files";
import { isHtmlPath, isMarkdownPath, resolveDocHref } from "../lib/docs";
import { requestElementFullscreen } from "../lib/fullscreen";
import { MOBILE_QUERY, useIsMobile } from "../lib/useIsMobile";
import { FileContent } from "./FileContent";
import { BackIcon, CodeIcon, ExpandIcon, FileIcon } from "./SideIcons";
import s from "./DocsPanel.module.css";

// Rewrite sanitized HTML for in-app behaviour: external links open a new tab
// natively (so middle-click works), links to repo docs get data-doc for the
// click handler, other relative links are neutralized (they'd resolve against
// the console origin and 404), and relative images — unservable, there is no
// raw-asset endpoint — become labelled placeholders instead of broken images.
function rewriteDocHtml(html: string, fromFile: string, files: string[]): string {
  const dom = new DOMParser().parseFromString(html, "text/html");
  for (const a of Array.from(dom.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:)?\/\//i.test(href) || href.toLowerCase().startsWith("mailto:")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      continue;
    }
    if (href.startsWith("#")) continue;
    const target = resolveDocHref(fromFile, href);
    if (target && files.includes(target)) a.setAttribute("data-doc", target);
    else a.removeAttribute("href");
  }
  for (const img of Array.from(dom.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (/^(https?:|data:)/i.test(src) || src.startsWith("//")) continue;
    const ph = dom.createElement("span");
    ph.setAttribute("data-img-placeholder", "");
    ph.textContent = `[image: ${img.getAttribute("alt") || src}]`;
    img.replaceWith(ph);
  }
  return dom.body.innerHTML;
}

type Doc = { content?: string; tooLarge?: boolean; binary?: boolean; size: number };

const POLL_MS = 5000;

// What the panel showed of each repo the last time (lib/viewCache): the list, the open page and
// its text are there on the first frame when Docs opens again, then read again.
const docsSeen = viewMemory<SharedDoc[] | null>(AGENT_MAX);
const mdSeen = viewMemory<string[]>(AGENT_MAX);
const selSeen = viewMemory<string | null>(AGENT_MAX);
const docSeen = viewMemory<Doc | null>(12);
const NO_MD: string[] = [];

export function DocsPanel({ root }: { root: string }) {
  const isMobile = useIsMobile();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [docs, setDocs] = useRemembered(docsSeen, root, null);
  const [repoMd, setRepoMd] = useRemembered(mdSeen, root, NO_MD);
  const [sel, setSel] = useRemembered(selSeen, root, null);
  const [doc, setDoc] = useRemembered(docSeen, sel ? `${root}/${sel}` : null, null);
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared-docs manifest: initial load + light polling, so new shares appear
  // and mtime bumps re-render the open doc while the panel is up.
  useEffect(() => {
    let live = true;
    let first = true;
    const load = async () => {
      try {
        const r = await sharedDocs(root);
        if (live) setDocs(r.docs);
      } catch {
        if (live && first) setError("Could not load shared docs.");
      }
      first = false;
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [root, setDocs]);

  // Full repo .md list — only for resolving relative links inside a rendered
  // doc; the left list shows shared entries exclusively.
  useEffect(() => {
    let live = true;
    void allFiles(root)
      .then((r) => { if (live) setRepoMd(r.files.filter(isMarkdownPath)); })
      .catch(() => { /* links degrade to plain text */ });
    return () => { live = false; };
  }, [root, setRepoMd]);

  // Open the first share by default on desktop; on mobile stay on the list so
  // the first screen is the index. Query the media directly — useIsMobile is
  // still false on the first render.
  useEffect(() => {
    if (!docs || docs.length === 0) return;
    if (!window.matchMedia(MOBILE_QUERY).matches) setSel((cur) => cur ?? docs[0].path);
  }, [docs, setSel]);

  // Selection change shows that page's remembered text (else nothing: useRemembered keys it); an
  // mtime bump alone refetches without clearing, so live edits swap content in place instead of
  // flashing Loading.
  const selMtime = docs?.find((d) => d.path === sel)?.mtime ?? 0;
  useEffect(() => { setError(null); setRaw(false); }, [root, sel]);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    void readFileContent(`${root}/${sel}`)
      .then((r) => { if (live) setDoc(r); })
      .catch(() => { if (live) setError(`Could not read ${sel}.`); });
    return () => { live = false; };
  }, [root, sel, selMtime, setDoc]);

  const selIsHtml = sel !== null && isHtmlPath(sel);

  const html = useMemo(() => {
    if (!doc?.content || !sel || selIsHtml || raw || typeof window === "undefined") return "";
    let parsed: string;
    try {
      parsed = parser.parse(doc.content, { async: false });
    } catch {
      parsed = `<pre>${escapeHtml(doc.content)}</pre>`;
    }
    return rewriteDocHtml(DOMPurify.sanitize(parsed), sel, repoMd);
  }, [doc, sel, selIsHtml, raw, repoMd]);

  // Left-click on a repo doc link navigates in place; anchor links scroll to
  // the heading; external links (target=_blank) keep native behaviour.
  const onDocClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || a.getAttribute("target") === "_blank") return;
    e.preventDefault();
    const target = a.getAttribute("data-doc");
    if (target) { setSel(target); return; }
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      (e.currentTarget as HTMLElement).querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  // Middle-click on an in-app doc link would open the repo-relative href
  // against the console origin (a 404) — suppress it; externals stay native.
  const onDocAuxClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (a && a.getAttribute("target") !== "_blank") e.preventDefault();
  }, []);

  const list = (
    <aside className={s.side}>
      <div className={s.head}>
        Shared docs <span className={s.count}>{docs?.length ?? "…"}</span>
      </div>
      {docs === null ? (
        <div className={`${s.empty} ${error ? "" : "late"}`}>{error ?? "Loading…"}</div>
      ) : docs.length === 0 ? (
        <div className={s.empty}>The agent hasn&apos;t shared any docs yet.</div>
      ) : (
        <ul className={s.list}>
          {docs.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                className={`${s.item} ${d.path === sel ? s.itemActive : ""}`}
                onClick={() => setSel(d.path)}
                title={d.path}
              >
                <span className={s.kind} aria-hidden>{d.kind === "html" ? <CodeIcon /> : <FileIcon />}</span>
                <span className={s.base}>{d.title}</span>
                <span className={s.dir}>{d.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );

  const viewer = (
    <section className={s.view}>
      <header className={s.viewHead}>
        {isMobile && (
          <button type="button" className={s.back} onClick={() => setSel(null)} aria-label="Back to docs list"><BackIcon size={16} /></button>
        )}
        <span className={s.path} title={sel ?? undefined}>{sel}</span>
        <div className={s.actions}>
          {selIsHtml && !raw && doc?.content !== undefined && (
            <button
              type="button"
              className={s.fullBtn}
              onClick={() => void requestElementFullscreen(frameRef.current)}
              title="Open artifact full screen"
            >
              <ExpandIcon size={12} /><span className={s.fullLabel}>Full screen</span>
            </button>
          )}
          <button type="button" className={s.rawBtn} onClick={() => setRaw((v) => !v)}>
            {raw ? "Rendered" : selIsHtml ? "Source" : "Raw"}
          </button>
        </div>
      </header>
      <div className={`${s.viewBody} ${selIsHtml && !raw && doc?.content !== undefined ? s.frameBody : ""}`}>
        {error ? (
          <div className={s.empty}>{error}</div>
        ) : !doc ? (
          <div className={`${s.empty} late`}>Loading…</div>
        ) : doc.tooLarge ? (
          <div className={s.empty}>File too large to preview ({doc.size} bytes).</div>
        ) : doc.binary || doc.content === undefined ? (
          <div className={s.empty}>Not a text file.</div>
        ) : raw ? (
          <FileContent path={sel ?? ""} content={doc.content} />
        ) : selIsHtml ? (
          // Opaque origin: allow-scripts WITHOUT allow-same-origin, so the
          // artifact's JS runs but can't reach console cookies or APIs.
          <iframe ref={frameRef} className={s.frame} sandbox="allow-scripts" srcDoc={doc.content} title={sel ?? "artifact"} />
        ) : (
          <article className={s.md} onClick={onDocClick} onAuxClick={onDocAuxClick} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </section>
  );

  if (isMobile) {
    return <div className={s.root}>{sel ? viewer : list}</div>;
  }
  return (
    <div className={s.root}>
      {list}
      {sel ? viewer : <div className={s.placeholder}>Select a document.</div>}
    </div>
  );
}
