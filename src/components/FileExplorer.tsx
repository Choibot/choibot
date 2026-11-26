"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_MAX, useRemembered, viewMemory } from "../lib/viewCache";
import hljs from "highlight.js/lib/common";
// Dark theme for highlight.js output. Importing a third-party stylesheet from
// node_modules is the one global-CSS import Next allows outside the root layout.
import {
  listDir,
  readFileContent,
  fileChanges,
  allFiles,
  searchFiles,
  findDefinition,
  type FileEntry,
  type Change,
  type SearchHit,
} from "../lib/files";
import { BackIcon, ChevronIcon, CloseIcon, ExternalIcon, RefreshIcon } from "./SideIcons";
import s from "./FileExplorer.module.css";

// File extension → highlight.js language. hljs/lib/common bundles the common
// languages; anything not here falls back to highlightAuto (or plain text).
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

function langFor(name: string): string | undefined {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  return EXT_LANG[ext];
}

function relPath(root: string, p: string): string {
  if (p === root) return p;
  if (p.startsWith(root + "/")) return p.slice(root.length + 1);
  return p;
}

function join(root: string, rel: string): string {
  return root.endsWith("/") ? root + rel : `${root}/${rel}`;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Split a rel path into directory prefix + emphasized basename.
function PathLabel({ rel }: { rel: string }) {
  const i = rel.lastIndexOf("/");
  const dir = i >= 0 ? rel.slice(0, i + 1) : "";
  const base = i >= 0 ? rel.slice(i + 1) : rel;
  return (
    <span className={s.pathLabel}>
      {dir && <span className={s.pathDir}>{dir}</span>}
      <span className={s.pathBase}>{base}</span>
    </span>
  );
}

type ContentState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "tooLarge"; size: number }
  | { status: "binary"; size: number }
  | { status: "text"; content: string; size: number; lang?: string };

// A request to navigate to a file (and optionally a line). `nonce` makes every
// open distinct so the viewer re-scrolls even when re-opening the same line.
type NavTarget = { line: number; nonce: number } | null;

// ---- fuzzy match (subsequence with simple quality scoring) ----
// Returns a score (higher = better) or -1 for no match. Contiguous runs and a
// basename hit are rewarded so e.g. "fe" ranks FileExplorer above filenames
// where the chars are scattered.
function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevIdx = -2;
  let lastSlash = t.lastIndexOf("/");
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === prevIdx + 1) score += 3; // contiguous run
      if (ti > lastSlash) score += 1; // in the basename
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === "-" || t[ti - 1] === "_" || t[ti - 1] === ".") {
        score += 2; // word boundary
      }
      prevIdx = ti;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  // Prefer shorter targets when scores tie.
  return score - t.length * 0.01;
}

// ---- lazy tree ----
function TreeNode(props: {
  entry: FileEntry;
  depth: number;
  selected: string | null;
  onSelectFile: (path: string) => void;
  childrenCache: Map<string, FileEntry[]>;
  loadChildren: (path: string) => Promise<FileEntry[]>;
}) {
  const { entry, depth, selected, onSelectFile, childrenCache, loadChildren } = props;
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(childrenCache.get(entry.path) ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (children === null) {
      setLoading(true);
      try {
        setChildren(await loadChildren(entry.path));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  }, [open, children, entry.path, loadChildren]);

  const pad = { paddingLeft: 8 + depth * 14 } as const;

  if (entry.type === "file") {
    const isSel = selected === entry.path;
    return (
      <button
        type="button"
        className={`${s.row} ${s.file} ${isSel ? s.selected : ""}`}
        style={pad}
        onClick={() => onSelectFile(entry.path)}
        title={entry.name}
      >
        <span className={s.fileGlyph}>·</span>
        <span className={s.name}>{entry.name}</span>
      </button>
    );
  }

  return (
    <>
      <button type="button" className={`${s.row} ${s.dir}`} style={pad} onClick={toggle} title={entry.name}>
        <span className={s.caret}><ChevronIcon open={open} /></span>
        <span className={s.name}>{entry.name}</span>
      </button>
      {open && (
        <div>
          {loading && <div className={s.muted} style={{ paddingLeft: 8 + (depth + 1) * 14 }}>…</div>}
          {children?.map((c) => (
            <TreeNode
              key={c.path}
              entry={c}
              depth={depth + 1}
              selected={selected}
              onSelectFile={onSelectFile}
              childrenCache={childrenCache}
              loadChildren={loadChildren}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ---- Changes section ----
const STATUS_GLYPH: Record<string, { glyph: string; cls: string; label: string }> = {
  M: { glyph: "M", cls: s.stM, label: "modified" },
  A: { glyph: "A", cls: s.stA, label: "added" },
  D: { glyph: "D", cls: s.stD, label: "deleted" },
  R: { glyph: "R", cls: s.stR, label: "renamed" },
  "?": { glyph: "?", cls: s.stU, label: "untracked" },
};

function ChangesSection({
  root,
  selected,
  onOpen,
}: {
  root: string;
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [git, setGit] = useState(false);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    let live = true;
    setBusy(true);
    void fileChanges(root)
      .then((r) => {
        if (!live) return;
        setGit(r.git);
        setChanges(r.changes);
      })
      .catch(() => { if (live) { setGit(false); setChanges([]); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [root]);

  useEffect(() => refresh(), [refresh]);

  if (!git || !changes || changes.length === 0) return null;

  return (
    <div className={s.section}>
      <div className={s.sectionHead}>
        <button type="button" className={s.sectionToggle} onClick={() => setOpen((o) => !o)}>
          <span className={s.caret}><ChevronIcon open={open} /></span>
          <span className={s.sectionTitle}>Changes</span>
          <span className={s.count}>{changes.length}</span>
        </button>
        <button
          type="button"
          className={s.miniBtn}
          onClick={refresh}
          title="Refresh changes"
          aria-label="Refresh changes"
        >
          {busy ? "…" : <RefreshIcon size={12} />}
        </button>
      </div>
      {open && (
        <div className={s.sectionBody}>
          {changes.map((c) => {
            const st = STATUS_GLYPH[c.status] ?? STATUS_GLYPH["?"];
            return (
              <button
                key={c.path + c.status}
                type="button"
                className={`${s.changeRow} ${selected === c.path ? s.selected : ""}`}
                onClick={() => onOpen(c.path)}
                title={`${st.label}: ${c.rel}`}
              >
                <span className={`${s.statusGlyph} ${st.cls}`}>{st.glyph}</span>
                <PathLabel rel={c.rel} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Search section ----
function SearchSection({
  root,
  selected,
  onOpen,
}: {
  root: string;
  selected: string | null;
  onOpen: (path: string, line?: number) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      void searchFiles(root, term)
        .then((r) => {
          if (seq.current !== id) return;
          setResults(r.results);
        })
        .catch(() => { if (seq.current === id) setResults([]); })
        .finally(() => { if (seq.current === id) setLoading(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [q, root]);

  // Group hits by rel path, preserving order.
  const groups = useMemo(() => {
    if (!results) return [];
    const map = new Map<string, { path: string; rel: string; hits: SearchHit[] }>();
    for (const h of results) {
      let g = map.get(h.rel);
      if (!g) { g = { path: h.path, rel: h.rel, hits: [] }; map.set(h.rel, g); }
      g.hits.push(h);
    }
    return [...map.values()];
  }, [results]);

  const term = q.trim();

  return (
    <div className={`${s.section} ${s.searchSection}`}>
      <div className={s.sectionHead}>
        <span className={s.sectionTitle}>Search</span>
        {results && <span className={s.count}>{results.length}</span>}
      </div>
      <div className={s.searchInputWrap}>
        <input
          className={s.searchInput}
          placeholder="Find in files…"
          value={q}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" className={s.clearBtn} onClick={() => setQ("")} aria-label="Clear search"><CloseIcon size={12} /></button>
        )}
      </div>
      <div className={s.searchResults}>
        {loading && <div className={s.muted}>Searching…</div>}
        {!loading && term.length >= 2 && results && results.length === 0 && (
          <div className={s.muted}>No results.</div>
        )}
        {!loading && groups.map((g) => (
          <div key={g.rel} className={s.searchGroup}>
            <div className={s.searchFileHead} title={g.rel}>
              <PathLabel rel={g.rel} />
              <span className={s.count}>{g.hits.length}</span>
            </div>
            {g.hits.map((h, i) => (
              <button
                key={`${h.line}:${i}`}
                type="button"
                className={`${s.matchRow} ${selected === h.path ? s.selectedFaint : ""}`}
                onClick={() => onOpen(h.path, h.line)}
                title={`Line ${h.line}`}
              >
                <span className={s.matchLine}>{h.line}</span>
                <span className={s.matchText}>{renderMatch(h.text, term)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Highlight the matched substring (case-insensitive, literal) inside a line.
function renderMatch(text: string, term: string) {
  const trimmed = text.length > 240 ? text.slice(0, 240) + "…" : text;
  if (!term) return trimmed;
  const lower = trimmed.toLowerCase();
  const lq = term.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < trimmed.length) {
    const at = lower.indexOf(lq, i);
    if (at < 0) { out.push(trimmed.slice(i)); break; }
    if (at > i) out.push(trimmed.slice(i, at));
    out.push(<mark key={key++} className={s.hit}>{trimmed.slice(at, at + term.length)}</mark>);
    i = at + term.length;
  }
  return out;
}

// ---- Quick Open palette ----
function QuickOpen({
  root,
  filesPromise,
  onClose,
  onOpen,
}: {
  root: string;
  filesPromise: Promise<string[]>;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void filesPromise.then((f) => { if (live) setFiles(f); }).catch(() => { if (live) setFiles([]); });
    return () => { live = false; };
  }, [filesPromise]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = useMemo(() => {
    if (!files) return [];
    const term = q.trim();
    if (!term) return files.slice(0, 50).map((rel) => ({ rel, score: 0 }));
    const scored: { rel: string; score: number }[] = [];
    for (const rel of files) {
      const sc = fuzzyScore(term, rel);
      if (sc >= 0) scored.push({ rel, score: sc });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50);
  }, [files, q]);

  useEffect(() => { setActive(0); }, [q]);

  // Keep the active row visible.
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = useCallback((rel: string) => {
    onOpen(join(root, rel));
    onClose();
  }, [root, onOpen, onClose]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, matches.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const m = matches[active];
      if (m) choose(m.rel);
    }
  }, [matches, active, choose, onClose]);

  return (
    <div className={s.overlay} onMouseDown={onClose}>
      <div className={s.palette} onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={s.paletteInput}
          placeholder={files === null ? "Loading files…" : "Go to file…"}
          value={q}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
        />
        <div className={s.paletteList} ref={listRef}>
          {files !== null && matches.length === 0 && <div className={s.muted}>No matching files.</div>}
          {matches.map((m, i) => (
            <button
              key={m.rel}
              type="button"
              className={`${s.paletteRow} ${i === active ? s.paletteActive : ""}`}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(m.rel)}
            >
              <PathLabel rel={m.rel} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- definition popup (for >1 candidate) ----
type DefPopup = { x: number; y: number; symbol: string; candidates: SearchHit[] } | null;
// Inline note for 0-candidate / loading feedback.
type DefNote = { text: string; symbol?: string } | null;

// editorOff: a hardened deployment has no /editor (overview decision 45), so
// the VS Code button hides.
// The top listing of each root seen last (lib/viewCache): the tree is there on the first frame
// when the editor opens again, then read again.
const topSeen = viewMemory<FileEntry[] | null>(AGENT_MAX);

// file: a file of the root to show when the explorer opens (the Server page's "Open in the code explorer").
export function FileExplorer({ root, editorOff = false, file }: { root: string; editorOff?: boolean; file?: string }) {
  const [topItems, setTopItems] = useRemembered(topSeen, root, null);
  const [treeError, setTreeError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<ContentState>({ status: "idle" });
  const [navTarget, setNavTarget] = useState<NavTarget>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [defPopup, setDefPopup] = useState<DefPopup>(null);
  const [defNote, setDefNote] = useState<DefNote>(null);
  // Per-path children cache, keyed on the directory's absolute path. Reset when
  // root changes so a new worktree doesn't show stale children.
  const cacheRef = useRef<Map<string, FileEntry[]>>(new Map());
  // Cache of the flat file list per root (for Quick Open).
  const allFilesRef = useRef<{ root: string; promise: Promise<string[]> } | null>(null);

  const loadChildren = useCallback(async (path: string) => {
    const cached = cacheRef.current.get(path);
    if (cached) return cached;
    const { items } = await listDir(path);
    cacheRef.current.set(path, items);
    return items;
  }, []);

  // THE unifying primitive: load a file, select it, optionally scroll to `line`.
  const openFile = useCallback((absPath: string, line?: number) => {
    setDefPopup(null);
    setDefNote(null);
    if (absPath === selected && content.status === "text") {
      // Already loaded — just (re)trigger the scroll/flash.
      if (line) setNavTarget({ line, nonce: Date.now() });
      return;
    }
    setSelected(absPath);
    setContent({ status: "loading" });
    setNavTarget(line ? { line, nonce: Date.now() } : null);
    void readFileContent(absPath)
      .then((r) => {
        if (r.tooLarge) { setContent({ status: "tooLarge", size: r.size }); return; }
        if (r.binary) { setContent({ status: "binary", size: r.size }); return; }
        setContent({
          status: "text",
          content: r.content ?? "",
          size: r.size,
          lang: langFor(basename(absPath)),
        });
      })
      .catch(() => setContent({ status: "error" }));
  }, [selected, content.status]);

  // (Re)load the root listing and reset everything whenever root changes.
  useEffect(() => {
    let live = true;
    cacheRef.current = new Map();
    allFilesRef.current = null;
    setTreeError(false);
    setSelected(null);
    setContent({ status: "idle" });
    setNavTarget(null);
    setQuickOpen(false);
    setDefPopup(null);
    setDefNote(null);
    void listDir(root)
      .then(({ items }) => {
        if (!live) return;
        cacheRef.current.set(root, items);
        setTopItems(items);
      })
      .catch(() => { if (live) setTreeError(true); });
    return () => { live = false; };
  }, [root, setTopItems]);

  // After the reset above: the file that the caller asked for.
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => { if (file) openRef.current(file); }, [root, file]);

  // Cmd/Ctrl+P opens Quick Open while the explorer is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setQuickOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const getAllFiles = useCallback((): Promise<string[]> => {
    const cached = allFilesRef.current;
    if (cached && cached.root === root) return cached.promise;
    const promise = allFiles(root).then((r) => r.files).catch(() => []);
    allFilesRef.current = { root, promise };
    return promise;
  }, [root]);

  // Cmd/Ctrl+click on an identifier in the viewer → go to definition.
  const onDefinitionClick = useCallback((symbol: string, x: number, y: number) => {
    setDefPopup(null);
    setDefNote({ text: `Looking up ${symbol}…`, symbol });
    void findDefinition(root, symbol)
      .then((r) => {
        const c = r.candidates;
        if (c.length === 0) {
          setDefNote({ text: `No definition found for ${symbol}`, symbol });
        } else if (c.length === 1) {
          setDefNote(null);
          openFile(c[0].path, c[0].line);
        } else {
          setDefNote(null);
          setDefPopup({ x, y, symbol, candidates: c });
        }
      })
      .catch(() => setDefNote({ text: `Lookup failed for ${symbol}`, symbol }));
  }, [root, openFile]);

  const openInVsCode = useCallback(() => {
    window.open(`/editor/?folder=${encodeURIComponent(root)}`, "_blank");
  }, [root]);

  return (
    <div className={s.wrap} data-open={selected ? "true" : "false"}>
      <div className={s.tree}>
        <div className={s.treeHead}>
          <span className={s.treeRoot} title={root}>{root.split("/").pop() || root}</span>
          <div className={s.headActions}>
            <button type="button" className={s.vscode} onClick={() => setQuickOpen(true)} title="Go to file (Ctrl/Cmd+P)">
              Go to file
            </button>
            {!editorOff && (
              <button type="button" className={s.vscode} onClick={openInVsCode} title="Open this folder in the full VS Code editor">
                VS Code <ExternalIcon size={10} />
              </button>
            )}
          </div>
        </div>
        <div className={s.treeBody}>
          <ChangesSection root={root} selected={selected} onOpen={openFile} />
          <SearchSection root={root} selected={selected} onOpen={openFile} />
          <div className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionTitle}>Files</span>
            </div>
            <div className={s.treeNodes}>
              {treeError && <div className={s.muted}>Failed to load folder.</div>}
              {!treeError && topItems === null && <div className={`${s.muted} late`}>Loading…</div>}
              {topItems?.map((e) => (
                <TreeNode
                  key={e.path}
                  entry={e}
                  depth={0}
                  selected={selected}
                  onSelectFile={openFile}
                  childrenCache={cacheRef.current}
                  loadChildren={loadChildren}
                />
              ))}
              {topItems?.length === 0 && <div className={s.muted}>Empty folder.</div>}
            </div>
          </div>
        </div>
      </div>
      <Viewer
        root={root}
        selected={selected}
        content={content}
        navTarget={navTarget}
        defPopup={defPopup}
        defNote={defNote}
        onDefinitionClick={onDefinitionClick}
        onChooseCandidate={(c) => openFile(c.path, c.line)}
        onDismissPopup={() => { setDefPopup(null); setDefNote(null); }}
        onBack={() => setSelected(null)}
      />
      {quickOpen && (
        <QuickOpen
          root={root}
          filesPromise={getAllFiles()}
          onClose={() => setQuickOpen(false)}
          onOpen={openFile}
        />
      )}
    </div>
  );
}

// Expand the token under (textNode, offset) to a JS-ish identifier.
function tokenAt(node: Text, offset: number): string | null {
  const text = node.data;
  const isId = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  if (text.length === 0) return null;
  let start = Math.min(offset, text.length);
  let end = start;
  // If we landed just past the word, step back onto it.
  if (start > 0 && (start >= text.length || !isId(text[start])) && isId(text[start - 1])) {
    start -= 1;
    end = start;
  }
  if (start >= text.length || !isId(text[start])) return null;
  while (start > 0 && isId(text[start - 1])) start -= 1;
  while (end < text.length && isId(text[end])) end += 1;
  const token = text.slice(start, end);
  // Must start with a valid identifier head.
  if (!/^[A-Za-z_$]/.test(token)) return null;
  return token;
}

// Resolve the word under a click point via the caret-position APIs.
function wordAtPoint(x: number, y: number): string | null {
  // Standards: caretPositionFromPoint; WebKit/legacy: caretRangeFromPoint.
  type Doc = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const d = document as Doc;
  let textNode: Node | null = null;
  let offset = 0;
  if (typeof d.caretPositionFromPoint === "function") {
    const pos = d.caretPositionFromPoint(x, y);
    if (pos) { textNode = pos.offsetNode; offset = pos.offset; }
  } else if (typeof d.caretRangeFromPoint === "function") {
    const range = d.caretRangeFromPoint(x, y);
    if (range) { textNode = range.startContainer; offset = range.startOffset; }
  }
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return null;
  return tokenAt(textNode as Text, offset);
}

function Viewer({
  root,
  selected,
  content,
  navTarget,
  defPopup,
  defNote,
  onDefinitionClick,
  onChooseCandidate,
  onDismissPopup,
  onBack,
}: {
  root: string;
  selected: string | null;
  content: ContentState;
  navTarget: NavTarget;
  defPopup: DefPopup;
  defNote: DefNote;
  onDefinitionClick: (symbol: string, x: number, y: number) => void;
  onChooseCandidate: (c: SearchHit) => void;
  onDismissPopup: () => void;
  onBack: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [flashLine, setFlashLine] = useState<number | null>(null);

  const highlighted = useMemo(() => {
    if (content.status !== "text") return null;
    try {
      if (content.lang && hljs.getLanguage(content.lang)) {
        return hljs.highlight(content.content, { language: content.lang }).value;
      }
      return hljs.highlightAuto(content.content).value;
    } catch {
      return null;
    }
  }, [content]);

  const lineCount = content.status === "text" ? content.content.split("\n").length : 0;

  // Scroll to + transiently flash the target line whenever navTarget changes
  // (nonce makes repeat-opens distinct) and the content is ready.
  useEffect(() => {
    if (!navTarget || content.status !== "text") return;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    raf = requestAnimationFrame(() => {
      const container = scrollRef.current;
      const el = container?.querySelector<HTMLElement>(`[data-line="${navTarget.line}"]`);
      if (el && container) {
        const top = el.offsetTop - container.clientHeight / 2 + el.offsetHeight / 2;
        container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      }
      setFlashLine(navTarget.line);
      timer = setTimeout(() => setFlashLine(null), 1600);
    });
    return () => { cancelAnimationFrame(raf); if (timer) clearTimeout(timer); };
  }, [navTarget, content.status]);

  const onViewerClick = useCallback((e: React.MouseEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return; // only Cmd/Ctrl+click navigates
    const token = wordAtPoint(e.clientX, e.clientY);
    if (!token) return;
    e.preventDefault();
    onDefinitionClick(token, e.clientX, e.clientY);
  }, [onDefinitionClick]);

  if (!selected) return <div className={s.viewer}><div className={s.placeholder}>Select a file to view.</div></div>;

  return (
    <div className={s.viewer}>
      <div className={s.viewerHead}>
        <button type="button" className={s.back} onClick={onBack} aria-label="Back to files"><BackIcon size={14} />Files</button>
        <span className={s.viewerPath} title={selected}>{relPath(root, selected)}</span>
        {(content.status === "text" || content.status === "tooLarge" || content.status === "binary") && (
          <span className={s.viewerSize}>{fmtSize(content.size)}</span>
        )}
      </div>
      <div className={s.viewerBody}>
        {content.status === "loading" && <div className={s.placeholder}>Loading…</div>}
        {content.status === "error" && <div className={s.placeholder}>Failed to read file.</div>}
        {content.status === "tooLarge" && <div className={s.placeholder}>File too large to preview.</div>}
        {content.status === "binary" && <div className={s.placeholder}>Binary file.</div>}
        {content.status === "text" && content.content.length === 0 && <div className={s.placeholder}>Empty file.</div>}
        {content.status === "text" && content.content.length > 0 && (
          <div className={`${s.codeScroll} ${s.navHint}`} ref={scrollRef} onClick={onViewerClick}>
            <pre className={s.gutter} aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => `${i + 1}`).join("\n")}
            </pre>
            <pre className={s.code}>
              <CodeLines html={highlighted} raw={content.content} flashLine={flashLine} />
            </pre>
          </div>
        )}
      </div>
      {defNote && (
        <div className={s.defNote} role="status">{defNote.text}</div>
      )}
      {defPopup && (
        <DefPopupView popup={defPopup} root={root} onChoose={onChooseCandidate} onDismiss={onDismissPopup} />
      )}
    </div>
  );
}

// Render code split into per-line rows so a target line can be scrolled to and
// flashed. The highlighted HTML is split on newlines; hljs spans can wrap across
// lines, but for scroll/flash purposes a per-line wrapper with the raw text is
// reliable, so we use the raw text per line and keep highlighting on the whole
// block when no flash/scroll is needed.
function CodeLines({ html, raw, flashLine }: { html: string | null; raw: string; flashLine: number | null }) {
  // Split highlighted HTML by line, balancing open hljs spans across line breaks
  // so each line is independently valid HTML.
  const lines = useMemo(() => splitHighlighted(html, raw), [html, raw]);
  return (
    <code className="hljs">
      {lines.map((lineHtml, i) => {
        const n = i + 1;
        const isFlash = flashLine === n;
        return (
          <span
            key={n}
            data-line={n}
            className={`${s.codeLine} ${isFlash ? s.flash : ""}`}
            dangerouslySetInnerHTML={{ __html: lineHtml.length ? lineHtml : "​" }}
          />
        );
      })}
    </code>
  );
}

// Split highlight.js output into per-line HTML strings, re-opening any spans
// that were left open at a line boundary so each line stands alone. Falls back
// to escaped raw text when there is no highlighted HTML.
function splitHighlighted(html: string | null, raw: string): string[] {
  if (html === null) {
    return raw.split("\n").map(escapeHtml);
  }
  const out: string[] = [];
  const openStack: string[] = [];
  let buf = "";
  let i = 0;
  // Walk the highlighted HTML, tracking open <span> tags, breaking on '\n'.
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
  // trailing line
  let line = buf;
  for (let k = 0; k < openStack.length; k++) line += "</span>";
  out.push(line);
  return out;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function DefPopupView({
  popup,
  root,
  onChoose,
  onDismiss,
}: {
  popup: NonNullable<DefPopup>;
  root: string;
  onChoose: (c: SearchHit) => void;
  onDismiss: () => void;
}) {
  // Position near the click, clamped into the viewport.
  const left = Math.min(popup.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 320);
  const top = Math.min(popup.y + 8, (typeof window !== "undefined" ? window.innerHeight : 9999) - 240);
  return (
    <>
      <div className={s.popupBackdrop} onMouseDown={onDismiss} />
      <div className={s.defPopup} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
        <div className={s.defPopupHead}>
          {popup.candidates.length} definitions for <code>{popup.symbol}</code>
        </div>
        <div className={s.defPopupList}>
          {popup.candidates.map((c, i) => (
            <button
              key={`${c.rel}:${c.line}:${i}`}
              type="button"
              className={s.defPopupRow}
              onClick={() => onChoose(c)}
              title={c.text.trim()}
            >
              <PathLabel rel={c.rel} />
              <span className={s.matchLine}>:{c.line}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
