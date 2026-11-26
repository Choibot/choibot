// src/lib/diff.ts — pure unified git-diff parser shared by the diff views.

export type LineKind = "context" | "add" | "del";
export interface DiffLine {
  kind: LineKind;
  text: string; // content without the leading +/-/space marker
  oldNo: number | null;
  newNo: number | null;
}
export interface Hunk {
  header: string; // the @@ ... @@ line
  lines: DiffLine[];
}
export type ChangeType = "add" | "modify" | "delete" | "rename";
export interface FileDiff {
  path: string; // display path (new path for renames)
  oldPath: string | null;
  type: ChangeType;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = patch.split("\n");
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;

  const push = () => { if (cur) files.push(cur); };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith("diff --git ")) {
      push();
      // diff --git a/<old> b/<new>
      const m = ln.match(/^diff --git a\/(.+) b\/(.+)$/);
      const old = m ? m[1] : null;
      const neu = m ? m[2] : (old ?? "?");
      cur = { path: neu ?? "?", oldPath: old, type: "modify", hunks: [], additions: 0, deletions: 0, binary: false };
      continue;
    }
    if (!cur) continue;
    if (ln.startsWith("new file mode")) { cur.type = "add"; continue; }
    if (ln.startsWith("deleted file mode")) { cur.type = "delete"; continue; }
    if (ln.startsWith("rename from ")) { cur.oldPath = ln.slice("rename from ".length); cur.type = "rename"; continue; }
    if (ln.startsWith("rename to ")) { cur.path = ln.slice("rename to ".length); cur.type = "rename"; continue; }
    if (ln.startsWith("Binary files")) { cur.binary = true; continue; }
    if (ln.startsWith("--- ")) {
      const p = ln.slice(4);
      if (p !== "/dev/null") cur.oldPath = p.replace(/^a\//, "");
      continue;
    }
    if (ln.startsWith("+++ ")) {
      const p = ln.slice(4);
      if (p !== "/dev/null") cur.path = p.replace(/^b\//, "");
      continue;
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      cur.hunks.push({ header: ln, lines: [] });
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) continue; // skip index/mode lines between header and first hunk
    if (ln.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = ln[0];
    const body = ln.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: body, oldNo: null, newNo: newNo++ });
      cur.additions++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: body, oldNo: oldNo++, newNo: null });
      cur.deletions++;
    } else if (marker === " " || ln === "") {
      hunk.lines.push({ kind: "context", text: body, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  push();
  return files;
}

// Pair adjacent del/add runs within a hunk into side-by-side rows.
export interface SplitRow { left: DiffLine | null; right: DiffLine | null; }
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === "context") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    // gather a run of dels then a run of adds
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
