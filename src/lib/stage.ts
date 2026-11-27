// src/lib/stage.ts — the stage of the Set-up page (direction B): one step in the middle, a rail
// with one part for each required step over it, and the full list in a fold under it. Pure: the
// part is components/setup/Stage.tsx.
//
// One count: the rail, the head line, the fold and the guide use progress() of lib/setup.ts.
import type { StepId } from "../../server/setup/steps";
import { firstTurn, progress, type SetupRow } from "./setup";
import { SLOW_MS, type FirstView } from "./setupActions";
import { applyPage, liveStep, type ThreadRes } from "./thread";

// What the stage shows: a step, the end card (every required step is done), or the wait for the
// first answer of the step list.
export type StageShown = { kind: "step"; row: SetupRow; picked: boolean } | { kind: "end" } | { kind: "checking" };

// A row the user can put on the stage from the fold or from the end card: one that is done, open,
// or optional. A row that waits for a step before it, or has no answer yet, stays where it is.
export const canStage = (r: SetupRow): boolean => r.state === "done" || r.state === "turn" || r.state === "optional";

/**
 * The step on the stage. `picked`: the step the user put there (a done step, to change it; an
 * optional step from the end card). Else the step to do now, else the end card. A required step
 * with no answer yet keeps the stage at "checking", so the stage never shows the end too early.
 */
export function stageStep(rows: SetupRow[], picked: StepId | null): StageShown {
  if (rows.length === 0 || rows.every((r) => r.state === "checking")) return { kind: "checking" };
  const pick = picked ? rows.find((r) => r.id === picked) : undefined;
  const turn = firstTurn(rows);
  if (pick && canStage(pick)) return { kind: "step", row: pick, picked: pick.id !== turn?.id };
  if (turn) return { kind: "step", row: turn, picked: false };
  const { done, total } = progress(rows);
  if (total > 0 && done === total) return { kind: "end" };
  const open = rows.find((r) => !r.optional && r.state !== "done");
  return open && open.state !== "checking" ? { kind: "step", row: open, picked: false } : { kind: "checking" };
}

// The key of what is on the stage: a new key is a new card (the old one leaves, the new one comes).
export const stageKey = (s: StageShown): string => (s.kind === "step" ? s.row.id : s.kind);

export type RailPart = { id: StepId; state: "done" | "cur" | "todo" };

// One part for each required step: done, the step to do now, or later. The optional steps are not
// in the rail.
export function railParts(rows: SetupRow[]): RailPart[] {
  const cur = firstTurn(rows)?.id;
  return rows.filter((r) => !r.optional).map((r) => ({ id: r.id, state: r.state === "done" ? "done" : r.id === cur ? "cur" : "todo" }));
}

// The note at the right of a row of the fold and of the end card: the line of a done step, the
// time an optional step takes ("1 minute", from its why), "Waits". null: the step to do now (the
// row shows "Your turn").
export function rowNote(r: SetupRow): string | null {
  if (r.state === "done") return r.text;
  if (r.state === "turn") return null;
  if (r.state === "waits") return "Waits";
  if (r.state === "optional") return minutesOf(r.why);
  return "Checking…";
}

export function minutesOf(why: string): string | null {
  const m = /(\d+ minutes?)\.?\s*$/.exec(why);
  return m ? m[1] : null;
}

// The optional steps on the end card: `max` of them, and how many more.
export function endOptions(rows: SetupRow[], max = 3): { shown: SetupRow[]; more: number } {
  const extra = rows.filter((r) => r.optional);
  return { shown: extra.slice(0, max), more: Math.max(0, extra.length - max) };
}

// The band of time of the first agent: an axis of 8 minutes, the usual zone (3 to 6 minutes) on it,
// and a mark at the time that passed. A band of time, not a progress bar: the console does not
// know how far the agent is.
export const BAND_MS = SLOW_MS;
export const BAND_ZONE = { from: 3 / 8, width: 3 / 8 };

export function bandAt(view: FirstView | null): number | null {
  const a = view?.agent;
  if (!view || !a || a.state !== "working" || a.noSession || view.ticket) return null;
  return Math.min(1, Math.max(0, (view.now - a.startedAt) / BAND_MS));
}

// The marks of the first agent: started, its pull request, its ticket in the Queue.
export function milestones(view: FirstView | null): { label: string; done: boolean }[] {
  const a = view?.agent ?? null;
  const ticket = view?.ticket ?? null;
  return [
    { label: "Started", done: a !== null },
    { label: "Pull request", done: a?.pullRequest === true || ticket !== null },
    { label: "Ticket in the Queue", done: ticket !== null },
  ];
}

// The open step of the agent's thread, from its last page: "Edit …/README.md". null when the agent
// does not run, while the model writes, or when the console has no thread for it.
export function threadNow(res: ThreadRes | null): string | null {
  if (!res || !res.ok) return null;
  return liveStep(applyPage(null, res, "tail").items, res.status)?.label ?? null;
}

// "Now: Edit …/README.md": the open step of the agent's thread (lib/thread liveStep), while it works.
export function nowLine(label: string | null | undefined): string | null {
  const t = label?.trim();
  return t ? `Now: ${t}` : null;
}
