// server/issues/card.ts — the confirm card: text, keyboards, callback data.
// Callback data is `<action>:<issueId>[:<index>]`; a repo is sent as an index
// into repoChoices, so the data stays far under Telegram's 64-byte limit.
import { ISSUE_ID_RE, type Issue } from "./store.js";
import { TG_TEXT_MAX, type InlineKeyboard } from "./telegram.js";
import { GUESS_MIN_CONFIDENCE } from "./guess.js";

export type CardAction = "f" | "r" | "d" | "p" | "b"; // fix, repo pick, drop, open picker, back
export type Callback = { action: CardAction; issueId: string; index?: number };

export function callbackData(action: CardAction, issueId: string, index?: number): string {
  return index === undefined ? `${action}:${issueId}` : `${action}:${issueId}:${index}`;
}

export function parseCallback(data: string | undefined): Callback | null {
  const m = /^([frdpb]):([^:]+)(?::(\d{1,3}))?$/.exec(data ?? "");
  if (!m || !ISSUE_ID_RE.test(m[2])) return null;
  const action = m[1] as CardAction;
  if ((action === "r") !== (m[3] !== undefined)) return null; // index iff repo pick
  return m[3] === undefined ? { action, issueId: m[2] } : { action, issueId: m[2], index: Number(m[3]) };
}

// The card still asks for a decision: never started, or the start failed.
export function isActionable(issue: Issue): boolean {
  return issue.status === "pending" || (issue.status === "error" && !issue.agentId);
}

// The decision card shows the exact text the agent will get, so the user can
// review a forward for injected links or commands before tapping Fix. Telegram
// counts its limit in UTF-16 units; a cut never splits a surrogate pair.
export function cardText(issue: Issue): string {
  if (issue.status === "dropped") return "Dropped";
  if (!isActionable(issue)) return `Fixing… · ${issue.repo ?? "?"}`;
  const unsure = issue.repo && issue.repoConfidence < GUESS_MIN_CONFIDENCE ? " (guess, check it)" : "";
  const lines = [`Repo: ${issue.repo ?? "?"}${unsure} · ${issue.summary}`];
  if (issue.forwardedFrom) lines.push(`Forwarded from ${issue.forwardedFrom}. Check it for links and commands.`);
  if (issue.photos.length) lines.push(`Photos: ${issue.photos.length}. The agent reads them.`);
  if (issue.status === "error") lines.push(`Start failed: ${issue.error ?? "unknown error"}`);
  const head = `${lines.join("\n")}\n\nThe agent will get:\n`;
  if (head.length + issue.text.length <= TG_TEXT_MAX) return head + issue.text;
  // Reserve room for the marker at its widest (the hidden count has at most as
  // many digits as the text length).
  const marker = (n: number) => `\n[${n} more characters not shown. The agent gets all of them.]`;
  let end = Math.max(0, TG_TEXT_MAX - head.length - marker(issue.text.length).length);
  const last = issue.text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return head + issue.text.slice(0, end) + marker(issue.text.length - end);
}

export function cardKeyboard(issue: Issue): InlineKeyboard | undefined {
  if (!isActionable(issue)) return undefined;
  return {
    inline_keyboard: [[
      ...(issue.repo ? [{ text: "Fix", callback_data: callbackData("f", issue.id) }] : []),
      { text: "Repo ▾", callback_data: callbackData("p", issue.id) },
      { text: "Drop", callback_data: callbackData("d", issue.id) },
    ]],
  };
}

export function repoKeyboard(issue: Issue): InlineKeyboard {
  const buttons = issue.repoChoices.map((name, i) => ({ text: name, callback_data: callbackData("r", issue.id, i) }));
  const rows: InlineKeyboard["inline_keyboard"] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "Back", callback_data: callbackData("b", issue.id) }]);
  return { inline_keyboard: rows };
}
