// server/chief/queue/lines.ts — delivery lines and msgIds (spec §5.1, §5.4 step 1).
import type { Answer, QueueItem } from "./types.js";

export function nextAnswerSeq(item: QueueItem): number { return item.answerSeq + 1; }
export function answerMsgId(item: QueueItem, seq: number): string { return `${item.id}-${seq}`; }
export function withdrawalMsgId(item: QueueItem, undoneSeq: number): string { return `${item.id}-w${undoneSeq}`; }
// The inverse of withdrawalMsgId: the undone answer's seq, or null for any other id.
export function withdrawalSeq(item: QueueItem, msgId: string): number | null {
  const prefix = `${item.id}-w`;
  const seq = msgId.startsWith(prefix) ? msgId.slice(prefix.length) : "";
  return /^[1-9]\d*$/.test(seq) ? Number(seq) : null;
}

// The merged notice of a pr item (overview decision 60): the line its agent gets when the item
// closes because its PR was merged. Its msgId can never be an answer's (`-<seq>`) or a
// withdrawal's (`-w<seq>`).
export function mergedMsgId(item: Pick<QueueItem, "id">): string { return `${item.id}-m`; }
export function formatMergedLine(item: Pick<QueueItem, "id">): string { return `[queue ${item.id}] pr: merged — continue or finish`; }
// True for an item closed as merged whose `delivery` slot is that notice. Such an item has no
// `answer`: the slot is the only thing that says a line is owed (Deliverer, Resend).
export function isMergedNotice(item: QueueItem): boolean {
  return item.status === "withdrawn" && item.lastError === "merged" && item.delivery?.msgId === mergedMsgId(item);
}
// An open or snoozed pr item, closed because its PR is merged: `withdrawn` with `lastError:
// "merged"` (spec §5.1), a snooze ended, and the merged notice `pending`. Call under the item lock.
export function closedMerged(item: QueueItem, now: number): QueueItem {
  const { snoozedUntil: _ended, ...rest } = item;
  return { ...rest, status: "withdrawn", lastError: "merged", closedAt: now, delivery: { msgId: mergedMsgId(item), state: "pending", attempts: 0 } };
}

// Master-written text (auto answers, values, labels, rule ids): collapse every line break run
// to one space so it cannot start a second `[queue …]` line.
const flat = (s: string): string => s.replace(/[\r\n\u2028\u2029\u0085]+/g, " ");

// A user answer's text keeps its line breaks (overview decision 55): blank lines dropped,
// trailing whitespace trimmed; the first line stays on the header line and every further line
// follows as "\n  " + line. So no later line can start a `[queue …]` header and none is empty
// (the master inbox joins batched messages with a blank line). Only blank lines → no text.
function userText(s: string): string | undefined {
  const lines = s.split(/\r\n|[\r\n\u2028\u2029\u0085]/).map((l) => l.trimEnd()).filter((l) => l !== "");
  return lines.length ? lines.join("\n  ") : undefined;
}

// The approve line of a pr or preview goes out only for the exact value "approve" (fail closed):
// any other value, and any kind this switch does not know, throws, and the Deliverer fails that
// slot (spec §5.4 step 1; the values validateUserAnswer accepts). No new pr answer is `approve`
// (decision 60: the item closes on the merge, formatMergedLine); the pr line stays for an
// approve committed before that rule and still waiting to go out.
function reviewBody(kind: "pr" | "preview", a: Answer, text: string | undefined): string {
  if (a.value === "changes") return `${kind}: changes requested: ${text ?? ""}`;
  if (a.value === "approve") return kind === "pr" ? "pr: approved — the user merges; continue or finish" : "preview: looks good";
  throw new Error(`${kind} answer must be approve or changes, got ${JSON.stringify(a.value.slice(0, 40))}`);
}

// The images of a user's answer (answerImages.ts): one indented line each, the bare path as the
// composer puts it in a message (the path that the agent opens). With no text, the header says
// how many there are.
const imageCount = (n: number): string => `(${n} ${n === 1 ? "image" : "images"})`;
const imageLines = (a: Answer): string => (a.by === "user" ? (a.images ?? []).map((x) => `\n  ${flat(x.path)}`).join("") : "");

export function formatAnswerLine(item: QueueItem, a: Answer): string {
  // Fail closed: only a `by: "user"` answer keeps its lines; any other author is flattened.
  const said = a.text === undefined ? undefined : a.by === "user" ? userText(a.text) : flat(a.text);
  const n = a.by === "user" ? a.images?.length ?? 0 : 0;
  const text = said ?? (n > 0 ? imageCount(n) : undefined);
  const mark = a.by === "master" ? `auto (rule ${(a.ruleIds ?? []).map(flat).join(", ")}): ` : "";
  let body: string;
  const kind = item.kind;
  switch (kind) {
    case "choice": {
      if (a.value === "reply") body = `choice: other: ${text ?? ""}`;
      else {
        const label = item.choice?.options.find((o) => o.key === a.value)?.label;
        body = `choice: ${flat(a.value)}${label !== undefined ? ` (${flat(label)})` : ""}${text ? ` — ${text}` : ""}`;
      }
      break;
    }
    case "question": body = `question: ${text ?? ""}`; break;
    case "pr": case "preview": body = reviewBody(kind, a, text); break;
    // The console's own ticket has no agent and no answer: no line ever goes out for it.
    case "deploy": throw new Error("a deploy ticket has no answer line");
    case "limit": throw new Error("a usage-limit ticket has no answer line");
    default: {
      const never: never = kind;
      throw new Error(`unknown queue item kind ${JSON.stringify(String(never).slice(0, 40))}`);
    }
  }
  return `[queue ${item.id}] ${mark}${body}${imageLines(a)}`;
}

export function formatWithdrawalLine(item: QueueItem, undone: Answer): string {
  return `[queue ${item.id}] the earlier answer (${flat(undone.value)}) is withdrawn; wait for the user`;
}
