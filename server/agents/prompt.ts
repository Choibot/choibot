// server/agents/prompt.ts — find a terminal dialog on an agent's screen.
// The thread view shows an agent from its Claude session file, and that file
// holds no terminal dialog: the folder trust question, the login method
// picker, a permission or option picker. detectPrompt reads the screen text
// (agents/screen.ts) and gives the dialog as data, so the prompt card can show
// one button for each option.
//
// Pure: screen text in, a Prompt or null out. A false positive is worse than a
// miss (a card with buttons that type into a working agent), so every rule
// below needs structure that only a dialog has:
//   - the normal input box on screen means "no prompt", always. A dialog
//     replaces the input box; a typed numbered list or the slash menu does not;
//   - a picker is a numbered block ("1." to "N." at one column, in order) with
//     the `❯` pointer on one of its lines. A pointer at column 0 is the input
//     box or a user message in the transcript: it counts only with a dialog
//     hint under the block;
//   - a list with no numbers gets buttons only as the folder trust dialog,
//     which its text identifies. Any other one is "unknown": its rows can be
//     two-line items or a scrolling list (the Rewind menu), and a button made
//     from the wrong row is worse than the plain screen with four keys;
//   - anything else is "unknown" only with a dialog's key hint as a footer
//     ("Esc to cancel", "Press Enter to continue") in the last lines and no
//     spinner.
// The fixtures in testdata/screens are real screens of Claude Code 2.1.322.
import { createHash } from "node:crypto";
import { keySeq } from "../../src/lib/term-keys.js";

// The only keys a browser may send through the keys route (agents/keys.ts).
export const PROMPT_KEYS = ["up", "down", "enter", "esc", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
export type PromptKey = (typeof PROMPT_KEYS)[number];

export function isPromptKey(v: unknown): v is PromptKey {
  return typeof v === "string" && (PROMPT_KEYS as readonly string[]).includes(v);
}

// The bytes one key writes to the PTY.
export function promptKeySeq(k: PromptKey): string {
  return k.length === 1 ? k : keySeq(k as "up" | "down" | "enter" | "esc" | "tab");
}

export type PromptKind = "folder-trust" | "login-method" | "picker" | "unknown";

export type PromptOption = {
  label: string;
  // The keys that choose this option from the selection the screen shows now:
  // arrow moves, then Enter. Valid only for the `rev` they came with.
  keys: PromptKey[];
};

export type Prompt = {
  kind: PromptKind;
  // The dialog's question; "" for kind "unknown".
  question: string;
  // What the question is about, when the dialog shows it: the folder of a
  // trust dialog, the command of a permission dialog. Lines joined by \n.
  detail?: string;
  // One per option, top first; empty for kind "unknown".
  options: PromptOption[];
  // Index in `options` of the highlighted option; null for kind "unknown".
  selected: number | null;
  // The screen, without its leading and trailing blank lines.
  screenText: string;
};

export type PromptStatus = "running" | "idle" | "done" | "error";

const MAX_OPTIONS = 12;
const MAX_LABEL = 200;
const MAX_DETAIL_LINES = 20;

// A horizontal rule: the input box borders, a dialog's top line.
const RULE_RE = /^\s*[╭╰┌└]?[─━▔]{10,}[╮╯┐┘]?\s*$/;
const RULE_RUN_RE = /[─━]{10,}/;
const DASH_RULE_RE = /^\s*[╌┄┈╍═─━▔]{10,}\s*$/;
// The prompt character of the input box, at column 0 (`!` is bash mode).
const INPUT_RE = /^[❯>!](?:[  ]|$)/;
const BOXED_INPUT_RE = /^[│┃] [❯>!](?:[  ]|$)/;
const POINTER_RE = /^(\s*)❯\s+(\S.*)$/;
const NUMBERED_RE = /^(\d{1,2})\.\s+(\S.*)$/;
// A list where Enter may toggle and not confirm: never a button card.
const CHECKBOX_RE = /^(?:\[[ xX✓✔]\]|[☐☑☒◯◉○])\s/;
const SPINNER_RE = /\besc to interrupt\b/i;
// A dialog's key hint: a footer line made of segments such as "Enter to
// confirm · Esc to cancel". Each pattern must START a segment, capital first,
// as Claude Code writes it: "…paste the token and press Enter." in an agent's
// own text is not a hint.
const HINT_RES = [
  /^(?:Enter|Return) to [a-z]/,
  /^Esc(?:ape)? to [a-z]/,
  /^Press (?:Enter|Return|any key)\b/,
  /^↑\s*\/?\s*↓ to [a-z]/,
];
// The shape of every segment of such a footer: "<key> to <verb>".
const KEY_SEGMENT_RE = /^(?:Press \S+|\S{1,12}(?:\s?\/\s?\S{1,12})? to [a-z])/;
// How many of the last non-blank lines may hold the hint of an unknown dialog.
const HINT_TAIL = 3;

const isBlank = (l: string): boolean => l.trim() === "";
function isHint(l: string): boolean {
  if (SPINNER_RE.test(l)) return false;
  const segs = l.trim().split(/\s+·\s+/);
  return segs.every((seg) => KEY_SEGMENT_RE.test(seg)) && segs.some((seg) => HINT_RES.some((re) => re.test(seg)));
}
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const indentOf = (l: string): number => l.length - l.trimStart().length;

// A line inside an old boxed dialog, without its side borders (the inner
// indent stays). Any other line is returned as it is.
function unbox(line: string): string {
  const m = /^\s*[│┃](.*)[│┃]\s*$/.exec(line);
  return m ? m[1].replace(/\s+$/, "") : line;
}

// The input box: its prompt character at column 0, right under its top
// border. The border can carry a title ("──── Session name ─"), so a run of
// rule characters anywhere in that line counts.
function hasInputBox(raw: string[]): boolean {
  for (let i = 0; i + 1 < raw.length; i++) {
    if (!RULE_RUN_RE.test(raw[i])) continue;
    if (INPUT_RE.test(raw[i + 1]) || BOXED_INPUT_RE.test(raw[i + 1])) return true;
  }
  return false;
}

type Block = {
  first: number; // index of the block's first line
  last: number;
  labels: string[];
  selected: number;
  numbered: boolean;
  pointerCol: number;
};

// The numbered options around the pointer line p: "N." at one column, numbers
// 1..N in order. A deeper-indented line under an option continues its label
// (a wrapped label or a description).
function numberedBlock(lines: string[], p: number, pointerCol: number, numCol: number, num: number, text: string): Block | null {
  // An option line with number `want` at numCol, or null. A list that scrolls
  // marks its edge rows with ↑ or ↓ in the pointer's place.
  const optionAt = (i: number, want: number): string | null => {
    const l = lines[i]?.replace(/^(\s*)[↑↓]/, "$1 ");
    if (l === undefined || indentOf(l) !== numCol) return null;
    const m = NUMBERED_RE.exec(l.slice(numCol));
    return m && Number(m[1]) === want ? m[2] : null;
  };
  const isCont = (i: number): boolean => lines[i] !== undefined && !isBlank(lines[i]) && indentOf(lines[i]) > numCol && !POINTER_RE.test(lines[i]);

  const items: { at: number; text: string }[] = [{ at: p, text }];
  // Up: number num-1, num-2, …, each at most 3 continuation lines above.
  let at = p;
  for (let want = num - 1; want >= 1; want--) {
    let i = at - 1;
    let skipped = 0;
    while (skipped < 3 && isCont(i)) { i--; skipped++; }
    const t = optionAt(i, want);
    if (t === null) return null; // the list does not start at 1
    items.unshift({ at: i, text: t });
    at = i;
  }
  // Down: num+1, … while they follow.
  at = p;
  for (let want = num + 1; want <= 99; want++) {
    let i = at + 1;
    let skipped = 0;
    while (skipped < 3 && isCont(i)) { i++; skipped++; }
    const t = optionAt(i, want);
    if (t === null) break;
    items.push({ at: i, text: t });
    at = i;
  }
  // Continuation lines join their option's label.
  const labels: string[] = [];
  let last = items[items.length - 1].at;
  items.forEach((it, k) => {
    const end = k + 1 < items.length ? items[k + 1].at : it.at + 4;
    let label = it.text;
    for (let i = it.at + 1; i < end && isCont(i); i++) { label += " " + lines[i].trim(); last = Math.max(last, i); }
    labels.push(squash(label));
  });
  return { first: items[0].at, last, labels, selected: num - 1, numbered: true, pointerCol };
}

// The plain options around the pointer line p: touching lines whose label
// starts at the pointer line's label column. A `✔` before a label marks the
// current value (the theme picker) and is not part of the label.
function plainBlock(lines: string[], p: number, pointerCol: number): Block | null {
  const labelOf = (l: string): { col: number; label: string } | null => {
    const m = /^(\s*(?:❯\s+)?(?:[✔✓]\s+)?)(\S.*)$/.exec(l);
    return m ? { col: m[1].length, label: m[2] } : null;
  };
  const own = labelOf(lines[p]);
  if (!own) return null;
  const rowAt = (i: number): string | null => {
    const l = lines[i];
    if (l === undefined || isBlank(l) || POINTER_RE.test(l) || DASH_RULE_RE.test(l)) return null;
    const x = labelOf(l);
    return x && x.col === own.col ? x.label : null;
  };
  const labels = [own.label];
  let first = p;
  let last = p;
  for (let i = p - 1, t = rowAt(i); t !== null; t = rowAt(--i)) { labels.unshift(t); first = i; }
  const selected = labels.length - 1;
  for (let i = p + 1, t = rowAt(i); t !== null; t = rowAt(++i)) { labels.push(t); last = i; }
  return { first, last, labels: labels.map(squash), selected, numbered: false, pointerCol };
}

// The option block of the lowest pointer line on screen, or null.
function findBlock(lines: string[]): Block | null {
  let p = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (POINTER_RE.test(lines[i])) { p = i; break; }
  }
  if (p < 0) return null;
  const m = POINTER_RE.exec(lines[p])!;
  const pointerCol = m[1].length;
  const numCol = lines[p].length - m[2].length;
  const n = NUMBERED_RE.exec(m[2]);
  return n ? numberedBlock(lines, p, pointerCol, numCol, Number(n[1]), n[2]) : plainBlock(lines, p, pointerCol);
}

// The paragraph right above line `from`: at most 2 blank lines are skipped,
// then at most 3 text lines are taken. `top` is the index of its first line.
function paragraphAbove(lines: string[], from: number): { text: string; top: number } {
  let i = from - 1;
  for (let skipped = 0; i >= 0 && isBlank(lines[i]) && skipped < 2; skipped++) i--;
  const out: string[] = [];
  while (i >= 0 && out.length < 3 && !isBlank(lines[i]) && !RULE_RE.test(lines[i]) && !DASH_RULE_RE.test(lines[i])) {
    out.unshift(lines[i].trim());
    i--;
  }
  return { text: squash(out.join(" ")), top: i + 1 };
}

// The dialog body between its top rule and its question: what a permission
// dialog asks about. Undefined when no rule opens the dialog.
function bodyAbove(lines: string[], questionTop: number): string | undefined {
  let top = -1;
  for (let i = questionTop - 1; i >= 0; i--) {
    if (RULE_RE.test(lines[i])) { top = i; break; }
  }
  if (top < 0) return undefined;
  const body = lines.slice(top + 1, questionTop)
    .filter((l) => !isBlank(l) && !DASH_RULE_RE.test(l))
    .map((l) => l.trim())
    .slice(0, MAX_DETAIL_LINES);
  return body.length ? body.join("\n") : undefined;
}

// The folder a trust dialog names: the lines under "Accessing workspace:".
// A long path wraps, so its lines join with no space.
function trustFolder(lines: string[], before: number): string | undefined {
  const at = lines.findIndex((l, i) => i < before && /accessing workspace:/i.test(l));
  if (at < 0) return undefined;
  let i = at + 1;
  while (i < before && isBlank(lines[i])) i++;
  let path = "";
  for (; i < before && !isBlank(lines[i]); i++) path += lines[i].trim();
  return path || undefined;
}

function optionKeys(selected: number, target: number): PromptKey[] {
  const move: PromptKey = target > selected ? "down" : "up";
  return [...Array<PromptKey>(Math.abs(target - selected)).fill(move), "enter"];
}

export function detectPrompt(screen: { lines: readonly string[] }, ctx: { status?: PromptStatus } = {}): Prompt | null {
  // A stopped agent has no dialog to answer.
  if (ctx.status === "done" || ctx.status === "error") return null;
  const raw = screen.lines.map((l) => l.replace(/\s+$/, ""));
  let end = raw.length;
  while (end > 0 && isBlank(raw[end - 1])) end--;
  let start = 0;
  while (start < end && isBlank(raw[start])) start++;
  if (start === end) return null;
  if (hasInputBox(raw)) return null;

  const lines = raw.map(unbox);
  const screenText = raw.slice(start, end).join("\n");
  const tail = lines.slice(0, end).filter((l) => !isBlank(l)).slice(-HINT_TAIL);
  const hinted = tail.some(isHint);
  const unknown = (): Prompt => ({ kind: "unknown", question: "", options: [], selected: null, screenText });

  const block = findBlock(lines);
  if (block && block.labels.length >= 2 && block.labels.length <= MAX_OPTIONS && block.labels.every((l) => l.length <= MAX_LABEL)) {
    if (block.labels.some((l) => CHECKBOX_RE.test(l))) return unknown();
    // A pointer at column 0 is how the input box and a user message start.
    const trusted = block.pointerCol >= 1 || (block.numbered && lines.slice(block.last + 1, end).some(isHint));
    if (trusted) {
      const above = lines.slice(0, block.first).join("\n");
      const para = paragraphAbove(lines, block.first);
      const options = block.labels.map((label, i) => ({ label, keys: optionKeys(block.selected, i) }));
      const base = { options, selected: block.selected, screenText };
      if (/\btrust\b/i.test(above) && block.labels.some((l) => /\btrust\b/i.test(l))) {
        const q = /([A-Z][^.?!:]*\btrust\b[^.?!]*\?)/.exec(squash(above));
        const detail = trustFolder(lines, block.first);
        return { kind: "folder-trust", question: q ? q[1] : "Do you trust this folder?", ...(detail ? { detail } : {}), ...base };
      }
      // Any other list without numbers: a dialog, but not one to cut into buttons.
      if (!block.numbered) return unknown();
      const login = lines.slice(0, block.first).find((l) => /select login method/i.test(l));
      if (login) return { kind: "login-method", question: login.trim(), ...base };
      const detail = bodyAbove(lines, para.top);
      return { kind: "picker", question: para.text, ...(detail ? { detail } : {}), ...base };
    }
  }
  // Not a known shape. A dialog hint near the bottom and no spinner: the
  // agent waits on something; show the screen and the four keys.
  if (hinted && !lines.some((l) => SPINNER_RE.test(l))) return unknown();
  return null;
}

// A short id of what the card shows. For a picker the screen text is left
// out: a spinner or an animated banner above a dialog repaints all the time
// and must not make the card look new.
export function promptRev(p: Prompt | null): string {
  if (!p) return "";
  const parts = [p.kind, p.question, p.detail ?? "", p.options.map((o) => o.label), p.selected, p.kind === "unknown" ? p.screenText : ""];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
