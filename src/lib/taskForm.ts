// src/lib/taskForm.ts — the "When" of the task form: what the user picks (a kind, days, a time)
// and the plain-words model that the server takes (server/cron/schedule.ts Schedule). Pure.
import type { Schedule } from "../../server/cron/schedule";

// keep: the task's own schedule stays (Change of a task with a custom schedule).
export type WhenKind = "day" | "weekdays" | "week" | "month" | "hours" | "keep";
export type WhenState = { kind: WhenKind; days: number[]; time: string; monthDay: number; every: number };

export const WHEN_KINDS: { kind: Exclude<WhenKind, "keep">; label: string }[] = [
  { kind: "day", label: "Every day" }, { kind: "weekdays", label: "Weekdays" }, { kind: "week", label: "Every week" },
  { kind: "month", label: "Every month" }, { kind: "hours", label: "Every few hours" },
];
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];
export const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const NEW_WHEN: WhenState = { kind: "day", days: [0], time: "09:00", monthDay: 1, every: 6 };
const ALL = [0, 1, 2, 3, 4, 5, 6], WEEK = [0, 1, 2, 3, 4];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The model of what the user picked; null: nothing to send (keep), or not complete yet. */
export function whenModel(w: WhenState): Schedule | null {
  const time = TIME_RE.test(w.time) ? w.time : null;
  switch (w.kind) {
    case "day": return time ? { kind: "days", days: ALL, times: [time] } : null;
    case "weekdays": return time ? { kind: "days", days: WEEK, times: [time] } : null;
    case "week": return time && w.days.length > 0 ? { kind: "days", days: [...new Set(w.days)].sort((a, b) => a - b), times: [time] } : null;
    case "month": return time ? { kind: "month", day: w.monthDay, time } : null;
    case "hours": return { kind: "hours", every: w.every, minute: 0 };
    case "keep": return null;
  }
}

/** Is the "When" of the form complete? (keep is: the server keeps the schedule.) */
export function whenReady(w: WhenState): boolean {
  return w.kind === "keep" || whenModel(w) !== null;
}

/**
 * What the form shows for a schedule that a task has. null (a custom schedule, or one that the
 * form cannot show as it is: two times a day, a minute of the hour, each few minutes): "keep".
 */
export function whenOf(s: Schedule | null): WhenState {
  const keep: WhenState = { ...NEW_WHEN, kind: "keep" };
  if (!s) return keep;
  if (s.kind === "days") {
    if (s.times.length !== 1) return keep;
    const base = { ...NEW_WHEN, time: s.times[0] };
    if (s.days.length === 7) return { ...base, kind: "day" };
    if (s.days.length === 5 && s.days.every((d, i) => d === i)) return { ...base, kind: "weekdays" };
    return { ...base, kind: "week", days: s.days };
  }
  if (s.kind === "month") return s.day <= 28 ? { ...NEW_WHEN, kind: "month", monthDay: s.day, time: s.time } : keep;
  if (s.kind === "hours") return s.minute === 0 && HOUR_STEPS.includes(s.every) ? { ...NEW_WHEN, kind: "hours", every: s.every } : keep;
  return keep;
}
