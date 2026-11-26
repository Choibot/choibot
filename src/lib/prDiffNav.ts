// src/lib/prDiffNav.ts — which file a PR's diff shows and how its change view folds and moves
// (the Queue ticket's file list, PrDiffPanel, DiffViewer). Pure, for the tests.

// A press on a file row of the ticket: that file's change opens. A second press on the file
// that is open closes the diff. `open` is null while the diff is closed.
export function toggleFile(open: string | null, pressed: string): string | null {
  return open === pressed ? null : pressed;
}

// A press on the "+N −M in K files" pill: it closes an open diff, else it opens on the first
// changed file ("" while the file list is not known yet: the diff then shows the first file).
export function pillFile(open: string | null, files: readonly { path: string }[]): string | null {
  return open !== null ? null : files[0]?.path ?? "";
}

// The file the diff shows: the asked one, else the first changed file. Never the empty
// "select a file" state while the PR changes a file.
export function shownFile(asked: string | null | undefined, changed: readonly string[]): string {
  return asked || changed[0] || "";
}

// A file with more diff lines starts folded; it renders when the user opens it.
export const FOLD_FILE_LINES = 400;
// The files open at first show at most this many diff lines in all: a large PR stays fast.
export const OPEN_BUDGET_LINES = 2500;

// Which files of the change view start open, from each file's diff line count, in the PR's
// order: a file opens if it is under the file limit and the open files stay under the budget.
export function openAtFirst(lines: readonly number[], fileMax = FOLD_FILE_LINES, budget = OPEN_BUDGET_LINES): boolean[] {
  let used = 0;
  return lines.map((n) => {
    if (n > fileMax || used + n > budget) return false;
    used += n;
    return true;
  });
}

// The rows where a run of changed lines starts: the stops of "Next change".
export function changeStarts(changed: readonly boolean[]): number[] {
  const out: number[] = [];
  changed.forEach((c, i) => { if (c && (i === 0 || !changed[i - 1])) out.push(i); });
  return out;
}

// The scroll top that puts the next change `pad` px under the top of the box (a few lines of
// context over it). `tops` are the change starts in the box's content, top to bottom; `maxTop`
// is the box's last scroll top. After the last change, and at the end of the box, it goes back
// to the first. With scrollTop -Infinity it gives the first stop. Null when there is no change.
export function nextStop(tops: readonly number[], scrollTop: number, pad: number, maxTop: number): number | null {
  if (tops.length === 0) return null;
  const atEnd = scrollTop >= maxTop - 1;
  const next = atEnd ? undefined : tops.find((t) => t - pad > scrollTop + 1);
  return Math.min(Math.max(0, (next ?? tops[0]) - pad), Math.max(0, maxTop));
}
