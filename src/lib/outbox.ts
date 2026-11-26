// src/lib/outbox.ts — what the user sent and the agent does not show as its
// own entry yet, for the end of the thread. Three sources, one list:
//   - the composer's queue (src/lib/composer.ts): not typed into the agent yet;
//   - the messages the composer sent (typed into the agent), until the agent's
//     session file has them: the bubble is on screen at once, and the entry of
//     the file takes its place with no second bubble;
//   - the agent's wait line, from the session file (queueView in thread.ts): a
//     message sent while the agent works, from this browser or another.
// Pure: the hook (useOutbox.ts) gives it the lists and applies `settle`.
import type { ComposerItem, SentItem } from "./composer";
import type { Message, Shown, Waiting } from "./thread";

// sending: on its way to the agent (shown after a moment only).
// retrying: not typed yet, and the composer tries again by itself.
// failed: not sent; the user decides (Retry, Remove).
// sent: typed into the agent; the session file does not have it yet.
// waiting: in the agent's wait line. taken: the agent took it this moment.
// stale: in the wait line of an agent that does not run (its session stopped).
export type OutState = "sending" | "retrying" | "failed" | "sent" | "waiting" | "taken" | "stale";
// `localId`: the composer's id of the message (Retry and Remove take it).
export type OutRow = { key: string; item: Message; state: OutState; note?: string; localId?: string };

export type OutboxInput = {
  items: readonly Shown[];
  waiting: readonly Waiting[];
  local: readonly ComposerItem[];
  sent: readonly SentItem[];
  claimed: readonly string[];
  status: string | null;
  // Server clock minus this browser's clock.
  skew: number;
  now: number;
};

// A file entry can be this much older than the send (two clocks, one request).
export const MATCH_SLACK_MS = 5_000;
// A sent message that the file still does not show after this long, while the
// thread went on, is dropped: its entry has another form there.
export const SENT_GIVE_UP_MS = 30_000;
// An idle agent takes a message at once: one that still waits after this long
// is in the line of a session that stopped.
export const STALE_AFTER_MS = 20_000;
// How far back the rows are searched for the entry of a sent message.
const LOOK_BACK = 80;

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

// The session file's text of a message the composer sent: the same text (the
// harness trims it), or with more around it (an image marker, text that was in
// the agent's input box already).
export function sameText(file: string, sent: string): boolean {
  const a = flat(file);
  const b = flat(sent);
  if (a === b) return true;
  return b.length >= 16 && a.includes(b);
}

const WHY: Record<string, string> = {
  starting: "Waits for the agent to start.",
  dialog: "The agent asks a question. Answer it in its card first.",
  "not-live": "The agent is stopped. Resume it to send.",
  offline: "No connection. Trying again.",
  server: "The server did not take it. Trying again.",
};

export function outbox(i: OutboxInput): { rows: OutRow[]; settle: { id: string; by?: string }[] } {
  const claimed = new Set(i.claimed);
  const used = new Set<string>();
  // What the composer sends is the user's own text: never a console line, a
  // reminder or a queue answer with the same words.
  const own = (m: Shown): m is Message => m.kind === "user" && (m.via === undefined || m.via === "command" || m.via === "shell");
  const recent = i.items.slice(-LOOK_BACK).filter(own);
  const lined = i.waiting.map((w) => w.item).filter(own);
  // The file's entry of a message sent at `at` (this browser's clock): a row
  // first (the agent has it), then the wait line.
  const entryOf = (text: string, at: number): Message | undefined => {
    const from = at + i.skew - MATCH_SLACK_MS;
    const fits = (m: Message): boolean => m.ts >= from && !claimed.has(m.id) && !used.has(m.id) && sameText(m.text, text);
    const hit = recent.find(fits) ?? lined.find(fits);
    if (hit) used.add(hit.id);
    return hit;
  };
  const newestRow = i.items.length ? i.items[i.items.length - 1].ts : 0;

  const rows: OutRow[] = [];
  const settle: { id: string; by?: string }[] = [];
  for (const w of i.waiting) {
    const stale = !w.taken && i.status !== "running" && i.now + i.skew - w.item.ts > STALE_AFTER_MS;
    rows.push({ key: `m:${w.item.id}`, item: w.item, state: w.taken ? "taken" : stale ? "stale" : "waiting" });
  }
  for (const m of i.sent) {
    const hit = entryOf(m.text, m.at);
    if (hit) { settle.push({ id: m.id, by: hit.id }); continue; }
    if (i.now - m.sentAt > SENT_GIVE_UP_MS && newestRow > m.sentAt + i.skew) { settle.push({ id: m.id }); continue; }
    rows.push({
      key: `o:${m.id}`, localId: m.id, item: { kind: "user", id: `o:${m.id}`, ts: m.at + i.skew, text: m.text },
      // The agent worked when the server typed it: it is in the wait line.
      // Said before the file says so. (Not from the status now: the message
      // of an idle agent starts a turn, and the status is "running" then.)
      state: m.busy ? "waiting" : "sent",
    });
  }
  for (const m of i.local) {
    // The request is still open and the file has the entry already: one bubble.
    if (m.state === "sending" && entryOf(m.text, m.at)) continue;
    const state: OutState = m.state === "failed" ? "failed" : m.state === "waiting" ? "retrying" : "sending";
    const note = state === "failed" ? (m.note ?? "").replace(/^failed: /, "") : state === "retrying" ? WHY[m.why ?? ""] ?? m.note : undefined;
    rows.push({
      key: `o:${m.id}`, localId: m.id, item: { kind: "user", id: `o:${m.id}`, ts: m.at + i.skew, text: m.text },
      state, ...(note ? { note } : {}),
    });
  }
  return { rows, settle };
}

// The words under a bubble, or null for none.
export function outLabel(r: Pick<OutRow, "state" | "note">): string | null {
  switch (r.state) {
    case "sending": return "Sending…";
    case "retrying": return r.note ?? "Not sent yet. Trying again.";
    case "failed": return r.note ? `Not sent: ${r.note}` : "Not sent";
    case "waiting": return "Waits. The agent reads it when it is ready.";
    case "stale": return "Not read. The session stopped first.";
    default: return null;
  }
}
