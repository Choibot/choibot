// server/guide/types.ts — the guide's thread as data. Types only: the browser imports them.
//
// The thread is the console's own file, not a session of a model. Each line of it is one typed
// item. A card is an item that names a step: the thread view draws the same form or button as
// the row of that step in the Set-up list, and a press goes to the same route as the row's.
import type { StepId, StepState } from "../setup/steps";
import type { SecretKind } from "./secret";

export type GuideItem =
  // What the user wrote. A message that the secret guard stopped is never an item of this kind.
  | { kind: "user"; id: string; ts: number; text: string }
  // What the guide says. `fixed`: a line the console wrote from the list (the welcome, the
  // next step), with no model.
  | { kind: "guide"; id: string; ts: number; text: string; fixed?: true }
  // The result of the check of a step, as the server has it. Never the guide's own words.
  | { kind: "check"; id: string; ts: number; step: StepId; state: StepState; text: string }
  // The last error of a step, as the server has it.
  | { kind: "error"; id: string; ts: number; step: StepId; text: string }
  // The form or the button of a step. The user presses it; the guide cannot.
  | { kind: "card"; id: string; ts: number; step: StepId }
  // A message the secret guard stopped. It holds the kind of the secret, never the text.
  | { kind: "stopped"; id: string; ts: number; secret: SecretKind; text: string }
  // A line of the console about the guide itself (it did not answer).
  | { kind: "note"; id: string; ts: number; text: string };

// login: Claude is not logged in on the server. limit: the Claude plan is at its limit.
// down: the model did not answer.
export type GuideOff = { why: "login" | "limit" | "down"; text: string; until?: number };

export type GuideView = {
  items: GuideItem[];
  // The guide writes an answer now.
  busy: boolean;
  // Absent: the guide can answer.
  off?: GuideOff;
};

// The three typed actions of the guide. The server runs each one; nothing else that the guide
// writes does anything.
export type GuideAction =
  | { do: "check"; step: StepId }
  | { do: "error"; step: StepId }
  | { do: "card"; step: StepId };

// One reply of the guide, cut into what it says and what it asks the server to do, in order.
export type GuideBlock = { say: string } | GuideAction;
