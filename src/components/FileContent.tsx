// src/components/FileContent.tsx
// Read-only full-file view for an unchanged file (no diff). Line-numbered and
// syntax-highlighted; reuses the DiffViewer stylesheet so it matches the panes.
"use client";
import { useMemo } from "react";
import { highlightToLines, langFor } from "../lib/highlight";
import s from "./DiffViewer.module.css";

const LINE_CAP = 12000;
// Any control char except tab (09), newline (0A), carriage return (0D) → binary.
const BINARY_RE = new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]");

export function FileContent({ path, content }: { path: string; content: string }) {
  const isBinary = BINARY_RE.test(content);
  const lines = useMemo(() => {
    if (isBinary) return [];
    const ls = content.split("\n");
    if (ls.length > 1 && ls[ls.length - 1] === "") ls.pop();
    return ls;
  }, [content, isBinary]);
  const tooLarge = lines.length > LINE_CAP;
  const htmlLines = useMemo(
    () => (isBinary || tooLarge ? [] : highlightToLines(lines.join("\n"), langFor(path))),
    [lines, path, isBinary, tooLarge],
  );

  if (isBinary) return <div className={s.empty}>Binary file not shown: {path}</div>;
  if (tooLarge) return <div className={s.empty}>File too large to render ({lines.length} lines): {path}</div>;

  return (
    <section className={s.file}>
      <header className={s.fileHead}>
        <span className={s.fileTitle} style={{ cursor: "default" }}>
          <span className={s.path}>{path}</span>
        </span>
        <div className={s.headRight}>
          <span className={s.counts}>{lines.length} lines</span>
        </div>
      </header>
      <div className={s.code}>
        {lines.map((_, i) => (
          <div key={i} className={`${s.row} ${s.row_context}`}>
            <span className={s.lno}>{i + 1}</span>
            <span className={s.mark}> </span>
            <span className={s.text} dangerouslySetInnerHTML={{ __html: htmlLines[i] || " " }} />
          </div>
        ))}
      </div>
    </section>
  );
}
