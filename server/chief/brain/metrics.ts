import { namedAts, type ClassifiedEntry, type DecisionLine } from "./store.js";

export type Counts = { decisions: number; corrections: number };
export type Metrics = { weeks: ({ week: string } & Counts)[]; byPr: ({ prUrl: string } & Counts)[];
  byAgent: ({ agentId: string } & Counts)[] };

const DAY = 86_400_000;

// ISO-8601 week (Monday start, week 1 holds the year's first Thursday), UTC.
export function isoWeek(at: number): string {
  const d = new Date(at);
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (3 - day) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const bump = (c: Counts, correction: boolean): void => {
  c.decisions += 1;
  if (correction) c.corrections += 1;
};

// Spec §6.5. Correction value = latest classified entry for the line's `at`,
// else the raw `correction`; null counts in neither number. A line named by a
// master line's `refAt` (namedAts) is excluded (the master line counts it
// once); a master-chat hit on that line still counts (another brain add). Lines
// outside the last `o.weeks` ISO weeks are ignored. byPr and byAgent are
// sorted by decisions, then corrections (both descending), then key.
export function foldMetrics(lines: DecisionLine[], classified: ClassifiedEntry[],
  o: { weeks: number; now: number }): Metrics {
  const latest = new Map<number, ClassifiedEntry>();
  for (const e of classified) latest.set(e.at, e);
  const named = namedAts(lines, latest);

  const weeks = new Map<string, Counts>();
  for (let i = 0; i < Math.max(0, o.weeks); i++) {
    weeks.set(isoWeek(o.now - i * 7 * DAY), { decisions: 0, corrections: 0 });
  }
  const byPr = new Map<string, Counts>();
  const byAgent = new Map<string, Counts>();
  const slot = (m: Map<string, Counts>, k: string): Counts => {
    let c = m.get(k);
    if (!c) m.set(k, (c = { decisions: 0, corrections: 0 }));
    return c;
  };
  for (const l of lines) {
    if (named.has(l.at)) continue;
    const w = weeks.get(isoWeek(l.at));
    if (!w) continue;
    const v = latest.get(l.at)?.correction ?? l.correction;
    if (typeof v !== "boolean") continue;
    bump(w, v);
    if (l.prUrl) bump(slot(byPr, l.prUrl), v);
    if (l.agentId) bump(slot(byAgent, l.agentId), v);
  }
  const rank = <K extends string>(m: Map<string, Counts>, key: K) =>
    [...m].map(([k, c]) => ({ [key]: k, ...c }) as { [P in K]: string } & Counts)
      .sort((a, b) => b.decisions - a.decisions || b.corrections - a.corrections
        || (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
  return {
    weeks: [...weeks].map(([week, c]) => ({ week, ...c })),
    byPr: rank(byPr, "prUrl"),
    byAgent: rank(byAgent, "agentId"),
  };
}
