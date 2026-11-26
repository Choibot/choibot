// server/widgets/history.ts — history.jsonl, status.json and data.json of one
// widget folder, and the ingest of agent-written data.json (spec "History").
// Callers hold the widget's KeyedLock (store.ts), so these never race.
import { join } from "node:path";
import { WidgetError } from "./errors.js";
import { mtimeOf, readCapped, readJsonSoft, writeAtomic } from "./files.js";
import { LIMITS } from "./paths.js";

export type HistoryEntry = { at: number; data: unknown };
export type WidgetStatus = { at: number; ok: boolean; mode: "script" | "agent"; error?: string };
// ingestedMtime = the data.json mtime last put in history.
export type StatusFile = { last: WidgetStatus | null; ingestedMtime: number | null };

const HISTORY = "history.jsonl";
const STATUS = "status.json";
const DATA = "data.json";
// A data.json younger than this that does not parse may still be mid-write.
export const SETTLE_MS = 2000;

// Append, then cut to the last historyMax lines, then drop the oldest lines
// until the file is at most 2 MB. Data over 64 KB is not added (false).
export async function appendHistory(dir: string, entry: HistoryEntry, historyMax: number): Promise<boolean> {
  const dataJson = JSON.stringify(entry.data);
  if (dataJson === undefined || Buffer.byteLength(dataJson) > LIMITS.historyEntry) return false;
  let lines: string[] = [];
  try {
    lines = ((await readCapped(join(dir, HISTORY), LIMITS.history)) ?? "").split("\n").filter(Boolean);
  } catch {
    lines = []; // a damaged or oversized file starts over
  }
  lines.push(JSON.stringify({ at: entry.at, data: entry.data }));
  lines = lines.slice(-historyMax);
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
  while (bytes > LIMITS.history && lines.length > 1) {
    bytes -= Buffer.byteLength(lines[0]) + 1;
    lines.shift();
  }
  await writeAtomic(join(dir, HISTORY), lines.join("\n") + "\n");
  return true;
}

// Entries with at > since (all when since is undefined). Over 2 MB → 413.
export async function readHistory(dir: string, since?: number): Promise<HistoryEntry[]> {
  const text = await readCapped(join(dir, HISTORY), LIMITS.history);
  if (text === null) return [];
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { at?: unknown; data?: unknown };
      if (typeof e?.at === "number" && (since === undefined || e.at > since)) out.push({ at: e.at, data: e.data });
    } catch { /* skip a damaged line */ }
  }
  return out;
}

export async function readStatus(dir: string): Promise<StatusFile> {
  const v = (await readJsonSoft(join(dir, STATUS), LIMITS.small)) as
    { last?: Record<string, unknown> | null; ingestedMtime?: unknown } | null;
  const l = v?.last;
  const last: WidgetStatus | null = l && typeof l.at === "number" && typeof l.ok === "boolean"
    ? { at: l.at, ok: l.ok, mode: l.mode === "agent" ? "agent" : "script", ...(typeof l.error === "string" ? { error: l.error } : {}) }
    : null;
  return { last, ingestedMtime: typeof v?.ingestedMtime === "number" ? v.ingestedMtime : null };
}

export async function writeStatus(dir: string, s: StatusFile): Promise<void> {
  await writeAtomic(join(dir, STATUS), JSON.stringify(s));
}

// data.json parsed; null when missing or not JSON. Over 256 KB → 413.
export async function readData(dir: string): Promise<unknown> {
  const raw = await readCapped(join(dir, DATA), LIMITS.data);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Write data.json (script mode) and return its new mtime for ingestedMtime.
export async function writeData(dir: string, value: unknown): Promise<number | null> {
  await writeAtomic(join(dir, DATA), JSON.stringify(value));
  return mtimeOf(join(dir, DATA));
}

export type IngestResult = "none" | "same" | "skipped" | "bad" | "added";

// Agent mode (spec "History"): a data.json mtime that is not ingestedMtime is
// read and parsed. Parse fails and the file is under 2 s old → skip this scan.
// Parse fails and older (or the file is too large) → error status, and the
// mtime is marked so the next scans do not repeat the work. Ok → append.
export async function ingestAgentData(dir: string, historyMax: number, now = Date.now()): Promise<IngestResult> {
  const path = join(dir, DATA);
  const mtime = await mtimeOf(path);
  if (mtime === null) return "none";
  const status = await readStatus(dir);
  if (status.ingestedMtime === mtime) return "same";
  let value: unknown;
  let error: string | null = null;
  try {
    const raw = await readCapped(path, LIMITS.data);
    if (raw === null) return "none";
    if ((await mtimeOf(path)) !== mtime) return "skipped"; // written again while we read
    value = JSON.parse(raw);
  } catch (e) {
    if (e instanceof WidgetError) error = "data.json is over 256 KB";
    else if (now - mtime < SETTLE_MS) return "skipped";
    else error = "data.json is not valid JSON";
  }
  if (error !== null) {
    await writeStatus(dir, { last: { at: now, ok: false, mode: "agent", error }, ingestedMtime: mtime });
    return "bad";
  }
  // The entry is stamped with the write time, not the (later) scan time.
  await appendHistory(dir, { at: Math.floor(mtime), data: value }, historyMax);
  await writeStatus(dir, { last: { at: now, ok: true, mode: "agent" }, ingestedMtime: mtime });
  return "added";
}
