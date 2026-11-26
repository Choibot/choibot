// src/lib/rail.ts — pure parts of the Changes rail (the inspector on the right
// of an agent's panel): the file sections, the one-line checks summary, and
// whether the rail starts open in this browser.
import type { ChangedFile } from "./agents";
import type { PrCi } from "./gh";

// The rail is open by default on a screen at least this wide; below it the
// thread keeps the width until the user opens the rail.
export const RAIL_WIDE_PX = 1200;
export const RAIL_OPEN_KEY = "rail.open";

// The stored choice ("1" open, "0" closed) or, with none, the default for the
// screen width. `storage` null: the browser blocks storage.
export function readRailOpen(storage: Pick<Storage, "getItem"> | null, width: number): boolean {
  let v: string | null = null;
  try { v = storage?.getItem(RAIL_OPEN_KEY) ?? null; } catch { v = null; }
  if (v === "1") return true;
  if (v === "0") return false;
  return width >= RAIL_WIDE_PX;
}

export type FileSection = { label: "Uncommitted" | "Committed"; files: ChangedFile[] };

// Work in the tree first (edits not committed and new files), then what the
// branch already committed. Empty sections are left out.
export function fileSections(files: ChangedFile[]): FileSection[] {
  const open = files.filter((f) => f.state !== "committed");
  const done = files.filter((f) => f.state === "committed");
  const out: FileSection[] = [];
  if (open.length) out.push({ label: "Uncommitted", files: open });
  if (done.length) out.push({ label: "Committed", files: done });
  return out;
}

export type ChecksTone = "ok" | "err" | "run";

// The checks line of the open PR. Failing beats running beats green; with no
// check runs the latest deployment speaks. null: nothing to show.
export function checksLine(ci: PrCi): { tone: ChecksTone; text: string } | null {
  const runs = ci.checkRuns;
  if (runs.length > 0) {
    const n = runs.length;
    const passed = runs.filter((r) => r.status === "passed").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const pending = runs.filter((r) => r.status === "pending").length;
    if (failed > 0) return { tone: "err", text: `Checks ${failed} failing · ${passed} of ${n} pass` };
    if (pending > 0) return { tone: "run", text: `Checks ${passed} of ${n} pass · ${pending} running` };
    return { tone: "ok", text: `Checks ${n} of ${n} pass` };
  }
  const d = ci.deployments[0];
  if (!d) return null;
  if (d.state === "success") return { tone: "ok", text: `Preview ready · ${d.environment}` };
  if (d.state === "failure" || d.state === "error") return { tone: "err", text: `Preview failed · ${d.environment}` };
  return { tone: "run", text: `Preview building · ${d.environment}` };
}
