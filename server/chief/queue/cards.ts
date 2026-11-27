// server/chief/queue/cards.ts — queue card text, keyboards and the item
// callback grammar (spec §8 "Queue cards", "Callback grammar"). Pure: no
// Telegram call, no store access. All text is plain (no parse_mode).
import { clip, TG_TEXT_MAX, type InlineButton, type InlineKeyboard } from "../../issues/telegram.js";
import { isPersistentAgentId } from "../kinds.js";
import { CONSOLE_AGENT_ID, DEPLOY_CLOSED, isRunning, ticketLine, updateVersions } from "../deploy/ticket.js";
import {
  LIMIT_ALL, LIMIT_CARD_ROWS, LIMIT_TAG_RE, LIMIT_WORDS, rowCanContinue, rowCanMove, rowStateText,
  type LimitPress,
} from "../limit/ticket.js";
import { COORDINATOR_ID } from "../../coordinator/paths.js";
import { hasImages, type QueueItem } from "./types.js";

export const QUEUE_GLYPH: Record<QueueItem["kind"], string> = { choice: "▸", pr: "⇄", preview: "▣", question: "?", deploy: "⟳", limit: "◷" };

const flat = (s: string): string => s.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");
// A line of agent text that starts (after blanks or invisible format
// characters) with ★ or ✓ would read as the card's own star or answer line:
// it gets a neutral prefix.
const FAKE_MARK = /(^|[\r\n\u2028\u2029\u0085])((?:[^\S\r\n\u2028\u2029\u0085]|\p{Cf})*[★✓])/gu;
const unmark = (s: string): string => s.replace(FAKE_MARK, "$1· $2");

// The card's own age format ("12 min"), not the "12m" of /queue.
function cardAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
}

// A persistent agent's item never carries a recommendation mark (decision 39).
const recommended = (item: QueueItem): QueueItem["recommend"] =>
  isPersistentAgentId(item.agentId) ? undefined : item.recommend;

type TextOpts = { now: number; ruleText?: (id: string) => string | undefined; consoleUrl?: string; tz?: string };

type Parts = { head: string; body: string; note: string; star: string };

// The preview images Telegram refused (or that could not be read): the card
// went without them, so it says where they are.
function mediaNote(item: QueueItem): string {
  const n = hasImages(item) && item.telegram?.mediaFailed === true ? item.preview?.images.length ?? 0 : 0;
  return n > 0 ? `${n} image${n === 1 ? "" : "s"} — see the Queue tab` : "";
}

// The rich part of an item is shown only in the console: the card is the plain body, and says so.
export const PAGE_NOTE = "This ticket has a page: open it in the console";
function pageNote(item: QueueItem, consoleUrl: string | undefined): string {
  if (!item.html) return "";
  return isHttps(consoleUrl) ? `${PAGE_NOTE} — ${consoleUrl.replace(/\/+$/, "")}` : PAGE_NOTE;
}

// An open pr item has no Approve (overview decision 60): the card says what closes it.
export const PR_WAIT_NOTE = "Not merged yet — merge the PR, then this closes.";
export const PR_WAIT_NOTE_LOCAL = "Not merged yet — merge the branch, then this closes.";
function waitNote(item: QueueItem): string {
  if (item.kind !== "pr" || (item.status !== "open" && item.status !== "snoozed")) return "";
  return item.pr && "local" in item.pr ? PR_WAIT_NOTE_LOCAL : PR_WAIT_NOTE;
}

// The console's own deploy ticket (spec §5.7): what Deploy would hit, then the run's state
// (progress, or the error and the end of the failed command's output).
const DEPLOY_TAIL_MAX = 600;
function deployNote(item: QueueItem): string {
  const d = item.deploy;
  if (item.kind !== "deploy" || !d) return "";
  const run = d.run;
  const tail = run?.phase === "failed" && run.tail ? `…${run.tail.slice(-DEPLOY_TAIL_MAX)}` : "";
  // The release variant: the versions while it waits for the press, then the press's line.
  const versions = d.release && !d.update ? updateVersions(d.release) : "";
  return [run?.phase === "running" ? "" : d.note ?? "", versions, ticketLine(d), tail].filter(Boolean).join("\n");
}

// The usage-limit ticket (chief/limit): one numbered line for each blocked agent (the buttons
// carry the same number), at most LIMIT_CARD_ROWS, then how many more. A login shows by its name
// on the page (never an e-mail address). A time says its zone ("Back at 14:00 UTC"): no card has
// the user's own zone, and the server's zone can be another one.
const NAME_MAX = 40;
function limitNote(item: QueueItem, o: TextOpts): string {
  const rows = item.kind === "limit" ? item.limit?.rows ?? [] : [];
  if (rows.length === 0) return "";
  const shown = rows.slice(0, LIMIT_CARD_ROWS).map((r, i) =>
    `${i + 1}. ${clip(flat(r.name), NAME_MAX)} · ${clip(flat(r.loginName), NAME_MAX)} · ${rowStateText(r, (ms) => hhmm(ms, o.tz, true))}`);
  const more = rows.length - shown.length;
  return [...shown, ...(more > 0 ? [`+${more} more — open the Queue`] : [])].join("\n");
}

function parts(item: QueueItem, o: TextOpts): Parts {
  // The console's own items (the deploy ticket, a rule suggestion) have no agent: the head names none.
  const who = item.agentId === CONSOLE_AGENT_ID ? "" : item.agentId === COORDINATOR_ID ? " · Coordinator" : ` · agent-${item.agentId.slice(0, 8)}`;
  const head = `${QUEUE_GLYPH[item.kind]} ${item.kind} · ${flat(item.repo)}${who} · ${cardAge(o.now - item.createdAt)}\n${unmark(flat(item.title))}`;
  const rec = recommended(item);
  let star = "";
  if (rec) {
    const ids = rec.ruleIds.map(flat);
    const text = ids.length ? o.ruleText?.(rec.ruleIds[0]) : undefined;
    // Who suggests: the Coordinator reads the tickets since the fleet master split; a suggestion
    // from before it, or one the fleet master makes when the user asks, keeps "Master".
    const by = rec.by === COORDINATOR_ID ? "Coordinator" : "Master";
    star = ids.length
      ? `★ ${by} suggests ${flat(rec.value)} — rule ${ids.join(", ")}${text !== undefined ? `: "${flat(text)}"` : ""}`
      : `★ ${by} suggests ${flat(rec.value)} — ${flat(rec.why)}`;
  }
  const note = [[waitNote(item), mediaNote(item)].filter(Boolean).join(" · ") || deployNote(item) || limitNote(item, o), pageNote(item, o.consoleUrl)].filter(Boolean).join("\n");
  return { head, body: unmark(item.body), note, star };
}

// Fit head + body + note + star line + tail into one message: only the body is cut.
function assemble(p: Parts, tail = ""): string {
  const fixed = [p.head, p.note, p.star].filter(Boolean).join("\n").length + tail.length + 2;
  const room = Math.max(0, TG_TEXT_MAX - fixed);
  const body = p.body.trim() === "" ? "" : clip(p.body, Math.max(room, 1));
  return clip([p.head, body, p.note, p.star].filter(Boolean).join("\n") + tail);
}

export function queueCardText(item: QueueItem, o: TextOpts): string {
  return assemble(parts(item, o));
}

function hhmm(at: number, tz?: string, zone = false): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz, ...(zone ? { timeZoneName: "short" as const } : {}) }).format(at);
}

// What the card shows for an answer value: a choice option key as is; the words
// below for the review kinds and the free-text replies.
function valueWord(item: QueueItem, value: string): string {
  if (value === "reply") return "replied";
  if (item.kind === "pr") return value === "approve" ? "approved" : value === "changes" ? "changes" : value;
  if (item.kind === "preview") return value === "approve" ? "looks good" : value === "changes" ? "changes" : value;
  return value;
}

// An item closed without an answer says why (lastError: merged, closed,
// agent-gone); a withdrawal by the user or the agent has none.
export function answeredCardText(item: QueueItem, o: TextOpts & { tz?: string }): string {
  const p = parts(item, o);
  if (item.kind === "deploy" && item.status === "withdrawn") {
    // The run line (in the note) is the result of a deployed ticket.
    if (item.lastError === DEPLOY_CLOSED.deployed) return assemble(p, "\n✓ deployed");
    if (item.lastError === DEPLOY_CLOSED.live) return assemble({ ...p, note: "" }, `\nclosed: ${item.deploy?.release ? "this console runs the newest version" : "the running build has all of main"}`);
    // An update's end: its line is in the note.
    if (item.lastError === DEPLOY_CLOSED.updated) return assemble(p, "\n✓ updated");
    if (item.lastError === DEPLOY_CLOSED.updateFailed) return assemble(p, "\n× update failed");
  }
  // A closed usage-limit ticket: its rows are old, so the card shows the close only.
  if (item.kind === "limit" && item.status === "withdrawn") return assemble({ ...p, note: "" }, `\n${item.lastError ? flat(item.lastError) : "withdrawn"}`);
  if (item.status === "withdrawn") return assemble(p, `\n${item.lastError ? flat(item.lastError) : "withdrawn"}`);
  const a = item.answer;
  if (!a) return assemble(p);
  return assemble(p, `\n✓ ${flat(valueWord(item, a.value))} · ${a.by === "user" ? "you" : "auto"} · ${hhmm(a.at, o.tz)}`);
}

const isHttps = (u: string | undefined): u is string => {
  if (!u) return false;
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

const cb = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const BTN_MAX = 60;

export function queueCardKeyboard(item: QueueItem, consoleUrl: string): InlineKeyboard {
  const id = item.id;
  const rows: InlineButton[][] = [];
  switch (item.kind) {
    case "pr": {
      // No Approve (decision 60): the user merges, and the merge closes the item.
      const row = [cb("Changes…", `q:c:${id}`)];
      const pr = item.pr;
      if (pr && "url" in pr) { if (isHttps(pr.url)) row.push({ text: "Open PR", url: pr.url }); }
      else if (pr && isHttps(consoleUrl)) {
        row.push({ text: "Reconcile", url: `${consoleUrl.replace(/\/+$/, "")}/#agent=${item.agentId}&reconcile` });
      }
      rows.push(row);
      break;
    }
    case "choice": {
      const rec = recommended(item)?.value;
      (item.choice?.options ?? []).forEach((opt, i) => {
        rows.push([cb(clip(`${opt.key === rec ? "★ " : ""}${flat(opt.label)}`, BTN_MAX), `q:o:${id}:${i}`)]);
      });
      // A rule suggestion's free reply is its new text (brain/suggest.ts).
      rows.push([cb(item.rule ? "Edit…" : "Other…", `q:r:${id}`)]);
      break;
    }
    case "preview": {
      const row = [cb("Looks good", `q:a:${id}`), cb("Changes…", `q:c:${id}`)];
      if (isHttps(item.preview?.url)) row.push({ text: "Open", url: item.preview.url });
      rows.push(row);
      break;
    }
    case "question": rows.push([cb("Reply…", `q:r:${id}`)]); break;
    case "deploy":
      // A run that goes shows no button: a second press does nothing (spec §5.7).
      if (isRunning(item.deploy)) return { inline_keyboard: [] };
      rows.push([cb(item.deploy?.release ? "Update" : "Deploy", `q:y:${id}`)]);
      break;
    case "limit": return { inline_keyboard: limitKeyboard(item) };
  }
  rows.push([cb("Snooze 1h", `q:s:${id}`)]);
  return { inline_keyboard: rows };
}

// The buttons of the usage-limit ticket: for each row on the card, its number with Move and
// Continue, two in a line; then Move all and Continue all when two rows or more can take them.
// No Snooze: the ticket closes by itself when no agent is blocked. Each press is checked again
// at the server (limit/service.ts press).
function limitKeyboard(item: QueueItem): InlineButton[][] {
  const id = item.id;
  const info = item.limit;
  if (!info) return [];
  const to = info.to;
  const out: InlineButton[] = [];
  info.rows.slice(0, LIMIT_CARD_ROWS).forEach((r, i) => {
    if (rowCanMove(r, to)) out.push(cb(clip(`${i + 1} · ${LIMIT_WORDS.move(flat(to.name))}`, BTN_MAX), `q:l:${id}:m:${r.tag}:${to.id}`));
    if (rowCanContinue(r)) out.push(cb(`${i + 1} · ${LIMIT_WORDS.continue}`, `q:l:${id}:c:${r.tag}`));
  });
  const rows: InlineButton[][] = [];
  for (let i = 0; i < out.length; i += 2) rows.push(out.slice(i, i + 2));
  const all: InlineButton[] = [];
  if (to && info.rows.filter((r) => rowCanMove(r, to)).length > 1) all.push(cb(clip(LIMIT_WORDS.moveAll(flat(to.name)), BTN_MAX), `q:l:${id}:M:${to.id}`));
  if (info.rows.filter(rowCanContinue).length > 1) all.push(cb(LIMIT_WORDS.continueAll, `q:l:${id}:C`));
  if (all.length) rows.push(all);
  return rows;
}

export function autoLineText(item: QueueItem): string {
  const a = item.answer;
  return `auto · ${item.id} · ${flat(a?.value ?? "")} · ${(a?.ruleIds ?? []).map(flat).join(", ")}`;
}

export function autoKeyboard(item: QueueItem): InlineKeyboard {
  return { inline_keyboard: [[cb("Undo", `q:u:${item.id}:${item.answerSeq}`)]] };
}

// `y`: Deploy, on the console's own deploy ticket only (spec §5.7). `l`: a button of the
// usage-limit ticket, with its press (chief/limit).
export type ItemCallback = { action: "a" | "c" | "o" | "r" | "s" | "u" | "x" | "y" | "l"; itemId: string; idx?: number; seq?: number; limit?: LimitPress };

const NUM = "(0|[1-9]\\d{0,5})";
const PLAIN = /^q:([acrsxy]):(q[0-9a-z]{8})$/;
const OPTION = new RegExp(`^q:o:(q[0-9a-z]{8}):${NUM}$`);
const UNDO = new RegExp(`^q:u:(q[0-9a-z]{8}):${NUM}$`);
// q:l:<item>:m:<tag>:<login>  Move one     q:l:<item>:M:<login>  Move all
// q:l:<item>:c:<tag>          Continue one q:l:<item>:C          Continue all
// A login id as accounts.ts allows it (at most 32 characters): at most 57 bytes in all.
const LOGIN = "([a-z0-9][a-z0-9_-]{0,31})";
const LIMIT_CB = new RegExp(`^q:l:(q[0-9a-z]{8}):(?:m:([0-9a-f]{8}):${LOGIN}|c:([0-9a-f]{8})|M:${LOGIN}|(C))$`);

export function parseItemCallback(data: string | undefined): ItemCallback | null {
  if (!data) return null;
  let m = PLAIN.exec(data);
  if (m) return { action: m[1] as ItemCallback["action"], itemId: m[2] };
  if ((m = OPTION.exec(data))) return { action: "o", itemId: m[1], idx: Number(m[2]) };
  if ((m = UNDO.exec(data))) return { action: "u", itemId: m[1], seq: Number(m[2]) };
  if ((m = LIMIT_CB.exec(data))) {
    const press: LimitPress = m[2] ? { row: m[2], act: "move", to: m[3] }
      : m[4] ? { row: m[4], act: "continue" }
      : m[5] ? { row: LIMIT_ALL, act: "move", to: m[5] }
      : { row: LIMIT_ALL, act: "continue" };
    if (press.row !== LIMIT_ALL && !LIMIT_TAG_RE.test(press.row)) return null;
    return { action: "l", itemId: m[1], limit: press };
  }
  return null;
}

// Every Telegram message of the item's card: the card, its media, then extras.
export function cardIdsOf(item: QueueItem): number[] {
  const t = item.telegram;
  const all = [t?.cardMessageId, ...(t?.mediaMessageIds ?? []), ...(t?.extraMessageIds ?? [])];
  return [...new Set(all.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n)))];
}
