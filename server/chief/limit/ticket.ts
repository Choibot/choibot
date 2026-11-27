// server/chief/limit/ticket.ts — the usage-limit ticket: its data and its words, one copy for the
// Queue view, the thread card and the Telegram card. Pure, and with no import at all: the Next
// client imports it. An agent's name is untrusted text: callers render every string as plain text.
//
// The console makes this ticket itself (agentId "console", like the deploy ticket): one ticket for
// all the agents that a usage limit of their Claude login blocks now. limit/service.ts keeps its
// rows true. Only the user presses its buttons (the route is behind gateUser, the Telegram tap
// counts only from the user's own account): an agent cannot add it, answer it or withdraw it.

// The ticket's repo and area (no repo of an agent): the card's head says "limit · logins".
export const LIMIT_REPO = "logins";
// A row that comes when the ticket's notice is older than this notifies again: the console closes
// the ticket and adds a new one with all the rows (one notice, never one per row). Inside it, the
// rows change in place, with no notice.
export const LIMIT_RENOTIFY_MS = 30 * 60_000;
// A ticket that closed with no row opens again, with no notice, when a block comes this soon after
// its close (a flap is not a new notice).
export const LIMIT_REOPEN_MS = 10 * 60_000;
// The rows that the Telegram card lists, each with its buttons; the others are "+N more".
export const LIMIT_CARD_ROWS = 8;

// Why the console closed a limit ticket (its lastError, the card's last line). A ticket that the
// user withdrew has none of these: no new ticket comes until a sync sees no row (its quietAt).
export const LIMIT_CLOSED = {
  none: "closed: no agent is blocked now",
  renotified: "closed: a newer ticket lists these agents",
  duplicate: "closed: a duplicate",
} as const;

// blocked           the limit cut its last turn, and it did not go on;
// waits-login       a new agent that has no session yet: each login was full when it was made;
// moves-when-quiet  the user moved it while it was busy: it moves when it is quiet (a lead, the
//                   fleet master, the Coordinator);
// answer-menu       Continue found a menu of Claude on its screen: the user answers it first;
// going-on          the console told it to go on (Continue): the row goes when it works again.
export type LimitRowState = "blocked" | "waits-login" | "moves-when-quiet" | "answer-menu" | "going-on";

export type LimitRow = {
  agentId: string;
  // The block that this row is for (`<agent id>@<time of the stop>`, `<agent id>@w<created>` for
  // an agent that waits for a login). A new block of the same agent is a new key.
  key: string;
  // 8 hex characters of the key: the row's handle on a button (an agent id can be too long for
  // Telegram's 64 bytes).
  tag: string;
  // The agent as the console names it ("Lead · console", "Fleet master", a worker's label).
  name: string;
  // The login that it is on: its id, and its name as the console shows it.
  login: string;
  loginName: string;
  // When its login has room again (epoch ms; null: not known).
  until: number | null;
  // Its own login has room now: the row has Continue.
  room: boolean;
  state: LimitRowState;
};

export type LimitLoginRef = { id: string; name: string };

export type LimitInfo = {
  rows: LimitRow[];
  // The login with the most room now (logged in, not signed out, its use known, not full): the
  // rows' Move buttons go to it. Absent: no login can take an agent now (or the use is not known).
  to?: LimitLoginRef;
  // Only on a ticket that the user withdrew: when a sync first saw no row. Until then the console
  // adds no limit ticket (the user's withdraw holds); it is in the store, so a restart keeps it.
  quietAt?: number;
};

// A press of a button: one row (its tag) or "all", and the login of a move.
export type LimitPress = { row: string; act: "move" | "continue"; to?: string };
export const LIMIT_ALL = "all";
export const LIMIT_TAG_RE = /^[0-9a-f]{8}$/;

export function limitTitle(n: number): string {
  return `Usage limit: ${n} agent${n === 1 ? "" : "s"} blocked`;
}

export const LIMIT_WORDS = {
  move: (login: string) => `Move to ${login}`,
  continue: "Continue",
  moveAll: (login: string) => `Move all to ${login}`,
  continueAll: "Continue all",
} as const;

const STATE_WORDS: Record<Exclude<LimitRowState, "blocked">, string> = {
  "waits-login": "Waits for a login",
  "moves-when-quiet": "Moves when quiet",
  "answer-menu": "Answer its menu first",
  "going-on": "Going on",
};

// The state of a row in a few words. `clock`: a time as the reader shows it ("14:00").
export function rowStateText(r: LimitRow, clock: (ms: number) => string): string {
  if (r.state !== "blocked") return STATE_WORDS[r.state];
  if (r.room) return "Login has room";
  return r.until !== null ? `Back at ${clock(r.until)}` : "Blocked";
}

// The buttons of a row now. Move: a login with room that is not the row's own. Continue: its own
// login has room. A row that goes on, or moves, has none (a second press does nothing new). A row
// with a menu of Claude on its screen has no Continue: the user answers the menu first (the
// console never types into it).
export function rowCanMove(r: LimitRow, to: LimitLoginRef | undefined): to is LimitLoginRef {
  return to !== undefined && to.id !== r.login && (r.state === "blocked" || r.state === "waits-login" || r.state === "answer-menu");
}
export function rowCanContinue(r: LimitRow): boolean {
  return r.room && r.state === "blocked";
}

// The answer to a press of "all", in one line.
export function allText(act: LimitPress["act"], done: number, skipped: number, to?: string): string {
  const n = (k: number) => `${k} agent${k === 1 ? "" : "s"}`;
  const head = act === "move" ? `Moved ${n(done)} to ${to ?? "the login"}.` : `Told ${n(done)} to go on.`;
  return skipped > 0 ? `${head} ${skipped} skipped: ${skipped === 1 ? "it" : "they"} did not fit.` : head;
}
