// src/components/PrDiffPanel.tsx
// A PR's review. By default it shows the change: every changed file as its hunks (the patch
// GitHub shows, 3 lines of context), stacked in the PR's order (DiffViewer), with the list of
// the changed files at the left to jump to one. Two more views open only on a press: one file in
// full ("Full file" on a file's head, with "Next change"), and the tree of every file at the
// head ("All files", off each time the panel opens).
"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DiffViewer } from "./DiffViewer";
import { SingleFileDiff } from "./SingleFileDiff";
import { FileContent } from "./FileContent";
import { PrChangedList, PrFileTree, type TreeEntry } from "./PrFileTree";
import { parsePatch } from "../lib/diff";
import { fetchPrRepos, fetchPrDiff, fetchPrFile, parsePrRef, type PrRepo, type PrDiff } from "../lib/pr";
import { changeStarts, nextStop, shownFile } from "../lib/prDiffNav";
import { useRemembered, viewMemory } from "../lib/viewCache";
import { ArrowDownIcon, ChevronIcon, CloseIcon } from "./SideIcons";
import { CiBadge } from "./CiBadge";
import s from "./PrDiffPanel.module.css";

type FileState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "diff"; patch: string }
  | { status: "content"; content: string };

// What a review showed the last time, drawn again on its first frame (lib/viewCache): the PR's
// diff by repo#pr (refreshed in the background), a file in full by head sha + path (final).
const diffs = viewMemory<PrDiff | null>(8);
const bodies = viewMemory<FileState | null>(40);
// "Next change" puts the change about three lines under the top of the box.
const CONTEXT_PX = 56;

// `focus`: the file to show (the Queue ticket's file row): the change view scrolls to it.
// `list`: the changed-files list at the left (off where the page lists the files itself).
// `onClose`: a close button in the head. `meta={false}`: no repo · PR · base line (the phone
// header of the Queue's diff screen says it).
export function PrDiffPanel({ repo: repoProp, pr: prProp, focus, list = true, onClose, meta = true }: {
  repo?: string; pr?: number; focus?: string; list?: boolean; onClose?: () => void; meta?: boolean;
} = {}) {
  const embedded = repoProp != null && prProp != null;
  const [repos, setRepos] = useState<PrRepo[]>([]);
  const [repo, setRepo] = useState(repoProp ?? "");
  const [prText, setPrText] = useState(prProp != null ? String(prProp) : "");
  const [base, setBase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useRemembered(diffs, embedded ? `${repoProp}#${prProp}` : null, null);
  const [pick, setPick] = useState({ path: "", seq: 0 }); // the last press in the changed-files list
  const [allFiles, setAllFiles] = useState(false); // the tree of every file: only on a press
  const [full, setFull] = useState<string | null>(null); // the file shown in full
  const bodyKey = data && full ? `${data.headSha}\n${full}` : null;
  const [fileState, setFileState] = useRemembered(bodies, bodyKey, null);
  const fullRef = useRef<HTMLDivElement>(null);

  // Standalone mode populates the repo picker; embedded mode skips it.
  useEffect(() => {
    if (embedded) return;
    void fetchPrRepos()
      .then((rs) => { setRepos(rs); setRepo((cur) => cur || rs[0]?.name || ""); })
      .catch(() => setError("Could not load repositories."));
  }, [embedded]);

  const files = useMemo(() => (data ? parsePatch(data.diff) : []), [data]);
  const changed = useMemo<Required<TreeEntry>[]>(
    () => files.map((f) => ({ path: f.path, change: { type: f.type, additions: f.additions, deletions: f.deletions } })),
    [files],
  );

  // Tree = every file at head, plus changed paths not in the tree (deletes).
  const entries = useMemo<TreeEntry[]>(() => {
    if (!data) return [];
    const byPath = new Map<string, TreeEntry>(data.tree.map((path) => [path, { path }]));
    for (const c of changed) byPath.set(c.path, c);
    return [...byPath.values()];
  }, [data, changed]);

  // The page asks for another file (the ticket's row): back to the change view, on that file.
  useEffect(() => { setFull(null); }, [focus]);

  // Load the file shown in full (a full-context diff if changed, else its content), once per head.
  useEffect(() => {
    if (!data || !full || !bodyKey) return;
    const have = bodies.get(bodyKey);
    if (have?.status === "diff" || have?.status === "content") return;
    setFileState({ status: "loading" });
    void fetchPrFile({
      repo: data.repo, path: full, headSha: data.headSha, mergeBase: data.mergeBase,
      changed: changed.some((c) => c.path === full),
    }).then((res) => {
      if (!res.ok) setFileState({ status: "error", error: res.error });
      else if (res.data.changed) setFileState({ status: "diff", patch: res.data.patch });
      else setFileState({ status: "content", content: res.data.content });
    });
  }, [data, full, bodyKey, changed, setFileState]);

  const fullFile = useMemo(() => (fileState?.status === "diff" ? parsePatch(fileState.patch)[0] ?? null : null), [fileState]);
  const blocks = useMemo(
    () => (fullFile ? fullFile.hunks.reduce((n, h) => n + changeStarts(h.lines.map((l) => l.kind !== "context")).length, 0) : 0),
    [fullFile],
  );

  // The change starts of the file in full (SingleFileDiff marks them), in its box's content.
  const stops = () => {
    const box = fullRef.current;
    if (!box) return null;
    const top0 = box.getBoundingClientRect().top - box.scrollTop;
    const tops = [...box.querySelectorAll<HTMLElement>("[data-change]")].map((m) => m.getBoundingClientRect().top - top0);
    return { box, tops, max: box.scrollHeight - box.clientHeight };
  };
  // A file in full opens on its first change, not on line 1.
  useLayoutEffect(() => {
    const st = full ? stops() : null;
    if (st) st.box.scrollTop = fileState?.status === "diff" ? nextStop(st.tops, -Infinity, CONTEXT_PX, st.max) ?? 0 : 0;
  }, [full, fileState]);
  const nextChange = () => {
    const st = stops();
    const top = st && nextStop(st.tops, st.box.scrollTop, CONTEXT_PX, st.max);
    if (st && top !== null) st.box.scrollTo({ top, behavior: "smooth" });
  };

  // Load a specific repo+pr (shared by the button and the embedded auto-load). Embedded, the
  // remembered diff stays on screen while the new one loads.
  const loadDiff = async (repoArg: string, pr: number, baseArg: string) => {
    setLoading(true); setError(""); setFull(null);
    if (!embedded) { setData(null); setPick((p) => ({ path: "", seq: p.seq })); }
    const res = await fetchPrDiff({ repo: repoArg, pr, base: baseArg.trim() || undefined });
    setLoading(false);
    if (res.ok) setData(res.data);
    else setError(res.error);
  };

  // Embedded: auto-load whenever the target PR changes.
  useEffect(() => {
    if (embedded) void loadDiff(repoProp!, prProp!, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, repoProp, prProp]);

  const onPrText = (value: string) => {
    const { slug, pr } = parsePrRef(value);
    if (slug) { const match = repos.find((r) => r.slug === slug); if (match) setRepo(match.name); }
    setPrText(pr && /github\.com/i.test(value) ? String(pr) : value);
  };

  const load = async () => {
    const { pr } = parsePrRef(prText);
    if (!repo) { setError("Pick a repository."); return; }
    if (!pr) { setError("Enter a PR number or URL."); return; }
    await loadDiff(repo, pr, base);
  };

  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter") void load(); };
  // The file the change view is on: the asked one, else the first changed file.
  const asked = list ? pick.path : focus ?? "";
  const current = full ?? shownFile(asked, files.map((f) => f.path));
  const side = list || allFiles;
  const onList = (path: string) => { setFull(null); setPick((p) => ({ path, seq: p.seq + 1 })); };

  return (
    <div className={s.root}>
      <div className={s.controls}>
        {!embedded && (
          <>
            <select className={s.select} value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository">
              {repos.length === 0 && <option value="">(no GitHub repos)</option>}
              {repos.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
            <input className={s.input} placeholder="PR number or URL" value={prText} onChange={(e) => onPrText(e.target.value)} onKeyDown={onKeyDown} aria-label="PR number or URL" />
            <input className={`${s.input} ${s.baseInput}`} placeholder="base (default branch)" value={base} onChange={(e) => setBase(e.target.value)} onKeyDown={onKeyDown} aria-label="Base branch" />
            <button className={s.load} onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Load diff"}</button>
          </>
        )}
        {data && meta && (
          <span className={s.meta}>
            <span className={s.slug}>{data.slug}</span> #{data.pr} · base <code>{data.base}</code> · {files.length} changed {files.length === 1 ? "file" : "files"}
            <CiBadge repo={data.slug} pr={data.pr} />
          </span>
        )}
        {(data || onClose) && (
          <span className={s.tools}>
            {data && (
              <button type="button" className={s.tool} aria-pressed={allFiles} onClick={() => setAllFiles((v) => !v)} title={allFiles ? "Hide the tree of every file" : "Show the tree of every file at the PR head"}>
                All files
              </button>
            )}
            {onClose && <button type="button" className={`${s.tool} ${s.toolIcon}`} onClick={onClose} aria-label="Close the diff" title="Close the diff"><CloseIcon size={12} /></button>}
          </span>
        )}
      </div>

      {error && <div className={s.error}>{error}</div>}
      {loading && !data && <div className={s.hint}>Loading diff…</div>}

      {data ? (
        <div className={s.split} data-side={side ? "" : undefined}>
          {side && (
            <aside className={s.treePane}>
              {allFiles
                ? <PrFileTree entries={entries} selected={full ?? ""} onSelect={setFull} />
                : <PrChangedList files={changed} current={current} onPick={onList} />}
            </aside>
          )}
          {/* The change view stays mounted under a file in full: its folds and its place stay. */}
          <div className={s.diffPane} hidden={full !== null} data-diff-scroll="">
            <DiffViewer patch={data.diff} focusFile={asked || undefined} focusSeq={pick.seq} foldLarge onFullFile={setFull} />
          </div>
          {full !== null && (
            <div className={s.fullPane}>
              <div className={s.fullBar}>
                <button type="button" className={s.tool} onClick={() => setFull(null)} title="Back to the changes of every file">
                  <ChevronIcon dir="left" size={10} /> Changes
                </button>
                <span className={s.fullPath} title={full}>{full}</span>
                {blocks > 1 && (
                  <button type="button" className={s.tool} onClick={nextChange} title={`Go to the next change (${blocks} in this file)`}>
                    <ArrowDownIcon size={11} /> Next change
                  </button>
                )}
              </div>
              <div className={s.diffPane} ref={fullRef}>
                {fileState?.status === "loading" && <div className={s.hint}>Loading {full}…</div>}
                {fileState?.status === "error" && <div className={s.error}>{fileState.error}</div>}
                {fileState?.status === "diff" && (fullFile ? <SingleFileDiff key={full} file={fullFile} /> : <div className={s.hint}>No changes.</div>)}
                {fileState?.status === "content" && <FileContent key={full} path={full} content={fileState.content} />}
              </div>
            </div>
          )}
        </div>
      ) : (
        !loading && !error && !embedded && <div className={s.hint}>Pick a repo and enter a PR number to review its diff.</div>
      )}
    </div>
  );
}
