// server/audit/ai.ts — the AI step of the clean-up audit: better words for the rows that code
// found. The model has NO tool and sees no file: it gets one table (a short path, the kind, the
// size and the age as words, the notes of code) and gives back, for each id, a group, two plain
// sentences and how sure it is.
//
// The server trusts nothing of the answer:
//   - a row whose id is not in the server's own table is dropped,
//   - a group can only get more careful (a "check" of code never becomes "safe"),
//   - a text that holds a size, a share, a link or a command is not used (the fixed words stay),
//   - no number of the answer is shown: every size and the total are the server's own.
import { size, span } from "../health/words.js";
import type { ModelAnswer } from "../guide/model.js";
import type { Candidate } from "./scan.js";
import type { Row, Sure } from "./words.js";

// The biggest rows go to the model; the others keep the fixed words.
export const AI_MAX_ROWS = 60;
const TEXT_MAX = 220;

export const AUDIT_SYSTEM = [
  "You help the owner of a small server. A program looked at the disk and made a list of things that could be removed to free space. You see the list as a JSON array. You cannot look at the server and you have no tool.",
  "Each item has: id, where (a short path), kind, floor (\"safe\" or \"check\"), size, age, madeBy, repo, notes.",
  "For EACH item give back one object: {\"id\": the same id, \"group\": \"safe\" or \"check\", \"what\": one short sentence that says what this is, \"effect\": one short sentence that says what happens after it is removed, \"sure\": \"high\", \"medium\" or \"low\"}.",
  "group \"safe\": a tool makes the thing again and nothing of the person is lost. group \"check\": the person must look first. When floor is \"check\", the group is \"check\". When a note says that work is not saved, the group is \"check\".",
  "Write for a person who does not know the tools: plain words, short sentences, active voice. Say what the thing is for, not only its name.",
  "Do not write a size, a number of bytes or a percent. Do not write a command or a link. Do not add an item. Do not change an id.",
  "Answer with the JSON array and nothing else.",
].join("\n");

export function tableFor(candidates: Candidate[]): string {
  return JSON.stringify(candidates.slice(0, AI_MAX_ROWS).map((c) => ({
    id: c.id, where: c.where, kind: c.kind, floor: c.floor, size: size(c.bytes),
    age: c.ageDays === null ? "not known" : `last changed ${span(c.ageDays * 86400)} ago`,
    ...(c.madeBy ? { madeBy: c.madeBy } : {}), ...(c.repo ? { repo: c.repo } : {}), ...(c.agent ? { agent: c.agent } : {}), notes: c.notes,
  })));
}

// A text of the model that may be shown: one line of sane length with no size, share, link or command in it.
const NOT_SHOWN = /\d\s?(bytes?|[KMGT]i?B|%)(?![A-Za-z])|https?:|www\.|`|\$\(|\b(rm|sudo|del|rmdir)\s+-?\S/i;
export function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (t.length < 3 || t.length > TEXT_MAX || /[\x00-\x1f\x7f<>]/.test(t) || NOT_SHOWN.test(t)) return null;
  return t;
}

const SURE = new Set<Sure>(["high", "medium", "low"]);

export type Merged = { rows: Row[]; used: number; dropped: number };

/** The rows with the model's words where they pass. `text`: the model's answer. */
export function mergeAnswer(rows: Row[], floors: Map<string, Candidate["floor"]>, text: string): Merged {
  let items: unknown;
  try {
    const from = text.indexOf("[");
    const to = text.lastIndexOf("]");
    items = from >= 0 && to > from ? JSON.parse(text.slice(from, to + 1)) : null;
  } catch { items = null; }
  if (!Array.isArray(items)) return { rows, used: 0, dropped: 0 };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const next = new Map<string, Row>();
  let dropped = 0;
  for (const it of items) {
    const o = (typeof it === "object" && it !== null ? it : {}) as Record<string, unknown>;
    const row = typeof o.id === "string" ? byId.get(o.id) : undefined;
    // A path or an id that the server did not send: not a row.
    if (!row || next.has(row.id)) { dropped += 1; continue; }
    const what = cleanText(o.what);
    const effect = cleanText(o.effect);
    // The group only gets more careful: code's "check" stays, the model's "check" is taken.
    const group = floors.get(row.id) === "check" || o.group === "check" ? "check" : "safe";
    const words = what && effect;
    next.set(row.id, {
      ...row, group,
      ...(words ? { what, effect, byAi: true } : {}),
      ...(words && typeof o.sure === "string" && SURE.has(o.sure as Sure) ? { sure: o.sure as Sure } : {}),
    });
  }
  return { rows: rows.map((r) => next.get(r.id) ?? r), used: [...next.values()].filter((r) => r.byAi).length, dropped };
}

// Why the AI step gave no words: for the one line of the page.
export type AiState = "ok" | "login" | "limit" | "down" | "none";
export const aiStateOf = (a: ModelAnswer): AiState => (a.ok ? "ok" : a.why);

