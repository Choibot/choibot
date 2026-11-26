// src/components/PrFileTree.tsx
// A VS Code-style tree of every file at the PR head (not just changed ones).
// Folders are collapsible and single-child chains are compressed. Changed files
// carry a status letter + add/del counts; unchanged files are dimmed and still
// openable so you can read any file and see how the code is organised. PrChangedList is the
// short form: only the changed files, flat, in the PR's order.
"use client";
import { useMemo, useState } from "react";
import type { ChangeType } from "../lib/diff";
import { ChevronIcon } from "./SideIcons";
import s from "./PrDiffPanel.module.css";

export interface TreeEntry {
  path: string;
  change?: { type: ChangeType; additions: number; deletions: number };
}

interface DirNode {
  name: string;
  path: string; // full path from root, e.g. "src/components"
  dirs: Map<string, DirNode>;
  files: { name: string; entry: TreeEntry }[];
}

function emptyDir(name: string, path: string): DirNode { return { name, path, dirs: new Map(), files: [] }; }

function buildTree(entries: TreeEntry[]): DirNode {
  const root = emptyDir("", "");
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const fileName = parts.pop() as string;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) { next = emptyDir(part, node.path ? `${node.path}/${part}` : part); node.dirs.set(part, next); }
      node = next;
    }
    node.files.push({ name: fileName, entry });
  }
  return root;
}

// Every directory that (transitively) contains a changed file — used to
// pre-expand exactly the folders leading to modifications.
function changedDirSet(entries: TreeEntry[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (!e.change) continue;
    const parts = e.path.split("/");
    parts.pop(); // drop filename
    let acc = "";
    for (const p of parts) { acc = acc ? `${acc}/${p}` : p; set.add(acc); }
  }
  return set;
}

// Compress a folder with exactly one sub-folder and no files into "parent/child".
function compress(dir: DirNode): { label: string; node: DirNode } {
  let label = dir.name;
  let node = dir;
  while (node.files.length === 0 && node.dirs.size === 1) {
    const only = [...node.dirs.values()][0];
    label = label ? `${label}/${only.name}` : only.name;
    node = only;
  }
  return { label, node };
}

const STATUS_CLASS: Record<ChangeType, string> = {
  add: s.stAdd, modify: s.stModify, delete: s.stDelete, rename: s.stRename,
};
const STATUS_CHAR: Record<ChangeType, string> = { add: "A", modify: "M", delete: "D", rename: "R" };

function FileRow({ entry, selected, onSelect }: { entry: TreeEntry; selected: string; onSelect: (p: string) => void }) {
  const active = entry.path === selected;
  const ch = entry.change;
  return (
    <button
      type="button"
      className={`${s.fileRow} ${active ? s.fileRowActive : ""} ${ch ? "" : s.fileRowPlain}`}
      onClick={() => onSelect(entry.path)}
      title={entry.path}
    >
      <span className={`${s.status} ${ch ? STATUS_CLASS[ch.type] : ""}`}>{ch ? STATUS_CHAR[ch.type] : ""}</span>
      <span className={s.fileName}>{entry.path.split("/").pop()}</span>
      {ch && (
        <span className={s.rowCounts}>
          {ch.additions > 0 && <span className={s.add}>+{ch.additions}</span>}
          {ch.deletions > 0 && <span className={s.del}>−{ch.deletions}</span>}
        </span>
      )}
    </button>
  );
}

function Folder({ dir, depth, selected, onSelect, changedDirs }: { dir: DirNode; depth: number; selected: string; onSelect: (p: string) => void; changedDirs: Set<string> }) {
  const { label, node } = compress(dir);
  // Open by default iff this folder leads to a changed file.
  const [open, setOpen] = useState(() => changedDirs.has(node.path));
  const childDirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const childFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div>
      <button type="button" className={s.dirRow} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={s.caret} data-open={open}><ChevronIcon dir="right" /></span>
        <span className={s.dirName}>{label}</span>
      </button>
      {open && (
        <>
          {childDirs.map((d) => <Folder key={d.name} dir={d} depth={depth + 1} selected={selected} onSelect={onSelect} changedDirs={changedDirs} />)}
          <div style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
            {childFiles.map((f) => <FileRow key={f.entry.path} entry={f.entry} selected={selected} onSelect={onSelect} />)}
          </div>
        </>
      )}
    </div>
  );
}

// The changed files only, one row each (state, path, plus and minus), in the PR's order. A press
// shows that file's change. `current` is marked (aria-current).
export function PrChangedList({ files, current, onPick }: { files: Required<TreeEntry>[]; current: string; onPick: (p: string) => void }) {
  return (
    <div className={s.tree} role="group" aria-label="Changed files">
      {files.map(({ path, change: ch }) => {
        const cut = path.lastIndexOf("/") + 1;
        const active = path === current;
        return (
          <button
            key={path} type="button" className={`${s.fileRow} ${active ? s.fileRowActive : ""}`} title={path}
            aria-current={active ? "true" : undefined} onClick={() => onPick(path)}
          >
            <span className={`${s.status} ${STATUS_CLASS[ch.type]}`}>{STATUS_CHAR[ch.type]}</span>
            <span className={s.listPath}><bdi>{path.slice(0, cut)}<b>{path.slice(cut)}</b></bdi></span>
            <span className={s.rowCounts}>
              {ch.additions > 0 && <span className={s.add}>+{ch.additions}</span>}
              {ch.deletions > 0 && <span className={s.del}>−{ch.deletions}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function PrFileTree({ entries, selected, onSelect }: { entries: TreeEntry[]; selected: string; onSelect: (p: string) => void }) {
  const root = useMemo(() => buildTree(entries), [entries]);
  // Pre-expand the folders that contain modifications; leave the rest closed.
  // Keyed on the change set so a new PR load re-initialises each folder's state.
  const changedDirs = useMemo(() => changedDirSet(entries), [entries]);
  const treeKey = useMemo(() => [...changedDirs].sort().join("|"), [changedDirs]);
  const rootDirs = [...root.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const rootFiles = [...root.files].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className={s.tree} key={treeKey}>
      {rootDirs.map((d) => <Folder key={d.name} dir={d} depth={0} selected={selected} onSelect={onSelect} changedDirs={changedDirs} />)}
      <div style={{ paddingLeft: 20 }}>
        {rootFiles.map((f) => <FileRow key={f.entry.path} entry={f.entry} selected={selected} onSelect={onSelect} />)}
      </div>
    </div>
  );
}
