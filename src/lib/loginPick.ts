// src/lib/loginPick.ts — the login control of one agent on its pane (components/LoginPick.tsx):
// the fleet master, a lead and the helper for tickets. A worker has its control in the Changes
// rail (AccountBar). The move is POST /api/agents/:id/account (the paired user only for these
// agents): a lead and the fleet master move through the relaunch of the chief of staff and keep
// their conversations.
import { DEFAULT_ACCOUNT, limitText, loginName, moveChoices, type AccountInfo, type SwitchOutcome } from "./accounts";

// One login in the control: its name, and its state in a few words (the row shows them on two
// lines, so the state always shows). `current`: the login of the agent now. `pick`: the user can
// move the agent to it (logged in, not the agent's own).
export type LoginPickRow = { id: string; name: string; state: string; current: boolean; pick: boolean };

// The state of a login in a few words, for its row (the words of the pick in moveChoices).
function stateOf(a: AccountInfo, now: number): string {
  if (!a.loggedIn) return a.signedOut ? "signed out" : "not logged in";
  if (!a.use) return "use not known";
  if (a.use.atLimit) return limitText(a.use, now).replace(/^At/, "at");
  return a.use.session !== null ? `5-hour window ${a.use.session}%` : a.use.week !== null ? `week ${a.use.week}%` : "has room";
}

// The rows of the control: the agent's own login first, then each other login that is logged in
// (the ones with room first, the most room first; then the full ones), then the ones that are not
// logged in (shown, but not a pick). Empty: no control. That is so with one login only, and with
// strong protection's second sign-in: these agents are on it only.
export function loginPickRows(accounts: AccountInfo[], current: string, now: number): LoginPickRow[] {
  if (accounts.some((a) => a.persistent)) return [];
  if (accounts.length < 2 && accounts.some((a) => a.id === current)) return [];
  const mine = accounts.find((a) => a.id === current);
  const row = (a: AccountInfo, current: boolean, pick: boolean): LoginPickRow => ({ id: a.id, name: loginName(a), state: stateOf(a, now), current, pick });
  const own: LoginPickRow = mine ? row(mine, true, false) : { id: current, name: current, state: "not known", current: true, pick: false };
  const others = moveChoices(accounts, current, [], now).map((c) => row(accounts.find((x) => x.id === c.id)!, false, true));
  const out = accounts.filter((a) => a.id !== current && !a.loggedIn).map((a) => row(a, false, false));
  return [own, ...others, ...out];
}

// Can the user move the agent now, and the note of the list. On a login that cannot work (signed
// out, not logged in, at its limit) yes, also while the agent works: a turn cannot go on there
// (the rule of "Move all" in Settings). On a login that works not while the agent works: a move
// then would cut its turn. `own`: the agent's login (undefined: not known).
export function moveGate(status: string, own: AccountInfo | undefined): { on: boolean; note: string | null } {
  if (own && !own.loggedIn) return { on: true, note: `This login is ${own.signedOut ? "signed out" : "not logged in"}. Move the agent to a login that works.` };
  if (own?.use?.atLimit) return { on: true, note: "This login is at its limit. Move the agent to a login with room." };
  if (status === "running") return { on: false, note: "The agent works now. Wait until it is quiet: a move now would cut its turn." };
  return { on: true, note: null };
}

// The name of a login on the button: the first part of its e-mail, else "Main login" or its id.
export function loginShort(a: Pick<AccountInfo, "id" | "email" | "isDefault"> | undefined, id = DEFAULT_ACCOUNT): string {
  if (!a) return id;
  return a.email ? a.email.split("@")[0] : a.isDefault ? "Main login" : a.id;
}

// The line after a move of one agent. `to`: the name of the login.
export function movedOneText(outcome: SwitchOutcome, to: string): string {
  if (outcome === "waits") return `The agent is busy now. It moves to ${to} when it is quiet.`;
  if (outcome === "unchanged") return `The agent is on ${to} already.`;
  return `Moved to ${to}. The agent keeps its conversation.`;
}
