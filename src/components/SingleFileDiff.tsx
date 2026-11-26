// src/components/SingleFileDiff.tsx
// Renders ONE file's diff (VS Code style: already selected in a tree, so always
// expanded) with a unified/split toggle and syntax highlighting. The old and
// new sides are highlighted independently (so multi-line tokens colour
// correctly), then mapped back per line. Reuses the DiffViewer stylesheet. The first row of each
// run of changed lines carries `data-change`: PrDiffPanel's "Next change" stops there.
"use client";
import { useMemo, useState } from "react";
import { toSplitRows, type LineKind, type ChangeType, type FileDiff, type DiffLine } from "../lib/diff";
import { highlightToLines, langFor } from "../lib/highlight";
import { changeStarts } from "../lib/prDiffNav";
import s from "./DiffViewer.module.css";

const TYPE_LABEL: Record<ChangeType, string> = { add: "added", modify: "modified", delete: "deleted", rename: "renamed" };
const LINE_CAP = 12000; // full-file diffs are large by design

function gutterMark(kind: LineKind): string {
  return kind === "add" ? "+" : kind === "del" ? "−" : " ";
}

// Map each DiffLine to its highlighted HTML by reconstructing the full old
// (context + deletions) and new (context + additions) sides and highlighting
// each as a whole.
function useLineHtml(file: FileDiff): Map<DiffLine, string> {
  return useMemo(() => {
    const newLines: string[] = [];
    const oldLines: string[] = [];
    const where: { line: DiffLine; side: "new" | "old"; idx: number }[] = [];
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.kind === "del") { where.push({ line: l, side: "old", idx: oldLines.length }); oldLines.push(l.text); }
        else if (l.kind === "add") { where.push({ line: l, side: "new", idx: newLines.length }); newLines.push(l.text); }
        else { where.push({ line: l, side: "new", idx: newLines.length }); newLines.push(l.text); oldLines.push(l.text); }
      }
    }
    const lang = langFor(file.path);
    const newH = highlightToLines(newLines.join("\n"), lang);
    const oldH = highlightToLines(oldLines.join("\n"), lang);
    const map = new Map<DiffLine, string>();
    for (const w of where) map.set(w.line, (w.side === "new" ? newH : oldH)[w.idx] ?? "");
    return map;
  }, [file]);
}

export function SingleFileDiff({ file }: { file: FileDiff }) {
  const [split, setSplit] = useState(false);
  const totalLines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const capped = totalLines > LINE_CAP;
  const html = useLineHtml(capped ? { ...file, hunks: [] } : file);

  const cell = (l: DiffLine | null) =>
    l ? <span dangerouslySetInnerHTML={{ __html: html.get(l) || " " }} /> : null;

  return (
    <section className={s.file}>
      <header className={s.fileHead}>
        <span className={s.fileTitle} style={{ cursor: "default" }}>
          <span className={s.badge}>{TYPE_LABEL[file.type]}</span>
          <span className={s.path}>
            {file.type === "rename" && file.oldPath ? <span className={s.renameOld}>{file.oldPath} → </span> : null}
            {file.path}
          </span>
        </span>
        <div className={s.headRight}>
          <span className={s.counts}>
            {file.additions > 0 && <span className={s.add}>+{file.additions}</span>}
            {file.deletions > 0 && <span className={s.del}>−{file.deletions}</span>}
          </span>
          {!file.binary && file.hunks.length > 0 && (
            <button type="button" className={s.toggle} data-active={split} onClick={() => setSplit((v) => !v)} title="Toggle side-by-side view">
              {split ? "Unified" : "Split"}
            </button>
          )}
        </div>
      </header>
      {file.binary ? (
        <div className={s.empty}>Binary file not shown.</div>
      ) : file.hunks.length === 0 ? (
        <div className={s.empty}>{capped ? `File too large to render (${totalLines} lines).` : "No textual changes."}</div>
      ) : split ? (
        <div className={s.code}>
          {file.hunks.map((h, hi) => {
            const rows = toSplitRows(h.lines);
            const starts = new Set(changeStarts(rows.map((r) => (!!r.left && r.left.kind !== "context") || (!!r.right && r.right.kind !== "context"))));
            return (
              <div key={hi}>
                <div className={s.hunkHead}>{h.header}</div>
                {rows.map((r, ri) => (
                  <div key={ri} className={s.splitRow} data-change={starts.has(ri) ? "" : undefined}>
                    <span className={`${s.lno} ${s.splitLno}`}>{r.left?.oldNo ?? ""}</span>
                    <span className={`${s.cell} ${r.left ? s[`row_${r.left.kind}`] : s.cellEmpty}`}>{cell(r.left)}</span>
                    <span className={`${s.lno} ${s.splitLno}`}>{r.right?.newNo ?? ""}</span>
                    <span className={`${s.cell} ${r.right ? s[`row_${r.right.kind}`] : s.cellEmpty}`}>{cell(r.right)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={s.code}>
          {file.hunks.map((h, hi) => {
            const starts = new Set(changeStarts(h.lines.map((l) => l.kind !== "context")));
            return (
              <div key={hi}>
                <div className={s.hunkHead}>{h.header}</div>
                {h.lines.map((l, li) => (
                  <div key={li} className={`${s.row} ${s[`row_${l.kind}`]}`} data-change={starts.has(li) ? "" : undefined}>
                    <span className={s.lno}>{l.oldNo ?? ""}</span>
                    <span className={s.lno}>{l.newNo ?? ""}</span>
                    <span className={s.mark}>{gutterMark(l.kind)}</span>
                    <span className={s.text} dangerouslySetInnerHTML={{ __html: html.get(l) || " " }} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
