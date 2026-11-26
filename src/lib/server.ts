// src/lib/server.ts — the Server page's data: what the health routes answer (server/health/api.ts),
// and the pure parts of the page (the line of a chart, the tone of a bar).
import type { HealthView, Use } from "../../server/health/monitor";
import type { Point } from "../../server/health/history";
import type { PlaceSize } from "../../server/health/places";
import type { Level } from "../../server/health/warn";
import { size as sizeWord } from "../../server/health/words";
import { chiefFetch } from "./chief";

export type { HealthView, Use, Point, PlaceSize, Level };

// "needs-pairing": the server refused this browser (it is not a paired device).
export type HealthAnswer = { ok: true; view: HealthView } | { ok: false; why: "needs-pairing" | "failed" };

export async function fetchHealth(deps: { fetch?: typeof chiefFetch } = {}): Promise<HealthAnswer> {
  try {
    const res = await (deps.fetch ?? chiefFetch)("/api/server/health");
    if (res.status === 403) return { ok: false, why: "needs-pairing" };
    if (!res.ok) return { ok: false, why: "failed" };
    return { ok: true, view: (await res.json()) as HealthView };
  } catch {
    return { ok: false, why: "failed" };
  }
}

// The dot of the sidebar row. Null: no answer (the row then shows no dot).
export async function fetchLevel(deps: { fetch?: typeof chiefFetch } = {}): Promise<Level | null> {
  try {
    const res = await (deps.fetch ?? chiefFetch)("/api/server/status");
    if (!res.ok) return null;
    const level = ((await res.json()) as { level?: unknown }).level;
    return level === "ok" || level === "warn" || level === "error" ? level : null;
  } catch {
    return null;
  }
}

export async function checkPlaces(deps: { fetch?: typeof chiefFetch } = {}): Promise<boolean> {
  try {
    return (await (deps.fetch ?? chiefFetch)("/api/server/places/check", { method: "POST" })).ok;
  } catch {
    return false;
  }
}

// The colour of a "how full" bar: the warning and the error colour only from the limits of the
// server's own warnings (server/health/warn.ts).
export function fullTone(percent: number, warn: number, error = 101): "ok" | "warn" | "err" {
  return percent >= error ? "err" : percent >= warn ? "warn" : "ok";
}

export type Range = "hour" | "day";
export type Series = { points: [number, number][]; from: number; to: number };

// One column of the history as a series over the whole range: the last hour of samples, or the
// last 24 hours of 5-minute means (with the samples of the step in progress at its end).
export function seriesOf(h: HealthView["history"], range: Range, col: 1 | 2, now: number): Series {
  const span = range === "hour" ? 60 * 60_000 : 24 * 60 * 60_000;
  const from = now - span;
  const rows: Point[] = range === "hour" ? h.fine : [...h.coarse, ...h.fine.filter((p) => p[0] > (h.coarse.at(-1)?.[0] ?? 0)).slice(-1)];
  return { points: rows.filter((p) => p[0] >= from).map((p) => [p[0], p[col]]), from, to: now };
}

// The SVG path of a series in a w × h box (0 to 100 % on the y axis). A pause longer than
// `gapMs` (the console was restarted) breaks the line: no line is drawn over a time with no data.
export function linePath(s: Series, w: number, h: number, gapMs: number): string {
  const x = (t: number) => ((t - s.from) / (s.to - s.from)) * w;
  const y = (v: number) => h - (Math.min(100, Math.max(0, v)) / 100) * h;
  let d = "";
  s.points.forEach(([t, v], i) => {
    const jump = i === 0 || t - s.points[i - 1][0] > gapMs;
    d += `${jump ? "M" : "L"}${x(t).toFixed(1)} ${y(v).toFixed(1)}`;
  });
  return d;
}

// The point of a series nearest to a time (the hover line).
export function nearest(s: Series, t: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const p of s.points) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
  return best;
}

// "14:05" in the browser's own time zone.
export function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "just now", "4 minutes ago", "2 hours ago".
export function ago(t: number, now: number): string {
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

// A place of the disk list: its name, and the line under it.
export function placeWords(p: PlaceSize): { name: string; note: string } {
  const parts = p.parts.map((x) => `${x.name} ${sizeWord(x.bytes)}`).join(" · ");
  const join = (a: string) => [a, parts].filter(Boolean).join(" · ");
  if (p.kind === "repo") return { name: p.name, note: join("Repo") };
  if (p.kind === "folder") return { name: p.name, note: join("Folder in the work folder") };
  if (p.kind === "agent") return { name: p.name, note: join(`Agent · its own copy of ${p.repo ?? "a repo"}`) };
  if (p.kind === "closed") return { name: p.name, note: join(`A copy of ${p.repo ?? "a repo"} that no agent uses`) };
  return { name: p.name, note: parts };
}
