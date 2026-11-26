"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch, toSplitRows, type LineKind, type ChangeType, type FileDiff } from "../lib/diff";
import { openAtFirst } from "../lib/prDiffNav";
import { ChevronIcon, ExpandIcon } from "./SideIcons";
import s from "./DiffViewer.module.css";

// ---- rendering ---------------------------------------------------------------

const TYPE_LABEL: Record<ChangeType, string> = { add: "added", modify: "modified", delete: "deleted", rename: "renamed" };
// Cap the per-file line count rendered upfront for very large files.
const LINE_CAP = 1500;

// Inside a box marked `data-diff-scroll` (PrDiffPanel), scroll only that box, not the panes
// around it: the Queue ticket's file list over its diff stays in view. Elsewhere (the agent's
// Review) every box scrolls as before.
function scrollToFile(el: HTMLElement, smooth: boolean) {
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  const box = el.parentElement?.closest<HTMLElement>("[data-diff-scroll]");
  if (!box) { el.scrollIntoView({ behavior, block: "start" }); return; }
  box.scrollTo({ top: box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top, behavior });
}

function FileSection({
  file,
  defaultOpen,
  focused,
  scrollNonce,
  onFull,
}: {
  file: FileDiff;
  defaultOpen: boolean;
  focused: boolean;
  scrollNonce: number;
  onFull?: (path: string) => void;
}) {
  // The focused file starts open: opened by the effect below, it grew one frame after the
  // first paint and pushed the files under it down.
  const [open, setOpen] = useState(defaultOpen || focused);
  const [split, setSplit] = useState(false);
  const totalLines = useMemo(() => file.hunks.reduce((n, h) => n + h.lines.length, 0), [file]);
  const capped = totalLines > LINE_CAP;
  const ref = useRef<HTMLElement | null>(null);

  // When this file becomes the focus target, force it open and scroll to it.
  // `scrollNonce` re-fires the effect even if focusFile is re-selected.
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    // The first scroll (the view opens on this file) is instant; a later press glides.
    if (ref.current) scrollToFile(ref.current, scrollNonce > 1);
  }, [focused, scrollNonce]);

  return (
    <section className={s.file} ref={ref}>
      <header className={s.fileHead}>
        <button type="button" className={s.fileTitle} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={s.caret} data-open={open}><ChevronIcon dir="right" /></span>
          <span className={s.badge}>{TYPE_LABEL[file.type]}</span>
          <span className={s.path}>
            <bdi>
              {file.type === "rename" && file.oldPath ? <span className={s.renameOld}>{file.oldPath} → </span> : null}
              {file.path}
            </bdi>
          </span>
        </button>
        <div className={s.headRight}>
          <span className={s.counts}>
            {file.additions > 0 && <span className={s.add}>+{file.additions}</span>}
            {file.deletions > 0 && <span className={s.del}>−{file.deletions}</span>}
          </span>
          {open && !file.binary && file.hunks.length > 0 && (
            <button
              type="button"
              className={s.toggle}
              data-active={split}
              onClick={() => setSplit((v) => !v)}
              title="Toggle side-by-side view"
            >
              {split ? "Unified" : "Split"}
            </button>
          )}
          {onFull && !file.binary && (
            <button type="button" className={`${s.toggle} ${s.fullBtn}`} onClick={() => onFull(file.path)} title="Show the whole file with this change in it">
              <ExpandIcon size={11} /> Full file
            </button>
          )}
        </div>
      </header>
      {open && (
        file.binary ? (
          <div className={s.empty}>Binary file not shown.</div>
        ) : file.hunks.length === 0 ? (
          <div className={s.empty}>No textual changes.</div>
        ) : capped ? (
          <div className={s.empty}>File too large to render ({totalLines} lines). Open in editor to view.</div>
        ) : split ? (
          <SplitView file={file} />
        ) : (
          <UnifiedView file={file} />
        )
      )}
    </section>
  );
}

function gutterMark(kind: LineKind): string {
  return kind === "add" ? "+" : kind === "del" ? "−" : " ";
}

function UnifiedView({ file }: { file: FileDiff }) {
  return (
    <div className={s.code}>
      {file.hunks.map((h, hi) => (
        <div key={hi}>
          <div className={s.hunkHead}>{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li} className={`${s.row} ${s[`row_${l.kind}`]}`}>
              <span className={s.lno}>{l.oldNo ?? ""}</span>
              <span className={s.lno}>{l.newNo ?? ""}</span>
              <span className={s.mark}>{gutterMark(l.kind)}</span>
              <span className={s.text}>{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function SplitView({ file }: { file: FileDiff }) {
  return (
    <div className={s.code}>
      {file.hunks.map((h, hi) => {
        const rows = toSplitRows(h.lines);
        return (
          <div key={hi}>
            <div className={s.hunkHead}>{h.header}</div>
            {rows.map((r, ri) => (
              <div key={ri} className={s.splitRow}>
                <span className={`${s.lno} ${s.splitLno}`}>{r.left?.oldNo ?? ""}</span>
                <span className={`${s.cell} ${r.left ? s[`row_${r.left.kind}`] : s.cellEmpty}`}>
                  {r.left ? (r.left.text || " ") : ""}
                </span>
                <span className={`${s.lno} ${s.splitLno}`}>{r.right?.newNo ?? ""}</span>
                <span className={`${s.cell} ${r.right ? s[`row_${r.right.kind}`] : s.cellEmpty}`}>
                  {r.right ? (r.right.text || " ") : ""}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// `focusSeq`: a new number scrolls to `focusFile` again (a second press of the same file).
// `foldLarge` (a PR's change view): every file starts open but the large ones and those past a
// line budget (lib/prDiffNav openAtFirst); else all start folded when there are more than 5.
// `onFullFile` adds a "Full file" button to each file's head.
export function DiffViewer({ patch, focusFile, focusSeq, foldLarge, onFullFile }: {
  patch: string; focusFile?: string; focusSeq?: number; foldLarge?: boolean; onFullFile?: (path: string) => void;
}) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const opens = useMemo(
    () => (foldLarge ? openAtFirst(files.map((f) => f.hunks.reduce((n, h) => n + h.lines.length, 0))) : null),
    [files, foldLarge],
  );
  // Bump a nonce whenever focusFile changes so a re-click of the same file still
  // re-scrolls. Match on new path or (for deletes/renames) the old path.
  const [nonce, setNonce] = useState(0);
  useEffect(() => { if (focusFile) setNonce((n) => n + 1); }, [focusFile, focusSeq]);

  if (!patch.trim() || files.length === 0) {
    return <div className={s.none}>No changes.</div>;
  }
  // Collapse by default when many files to keep large diffs snappy.
  const defaultOpen = files.length <= 5;
  const isFocused = (f: FileDiff) =>
    !!focusFile && (f.path === focusFile || f.oldPath === focusFile);
  return (
    <div className={s.root}>
      <div className={s.summary}>
        {files.length} file{files.length === 1 ? "" : "s"} changed
      </div>
      {files.map((f, i) => (
        <FileSection
          key={`${f.path}-${i}`}
          file={f}
          defaultOpen={opens ? opens[i] : defaultOpen}
          focused={isFocused(f)}
          scrollNonce={nonce}
          {...(onFullFile ? { onFull: onFullFile } : {})}
        />
      ))}
    </div>
  );
}
