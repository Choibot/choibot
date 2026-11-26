// src/lib/prompt.ts — client side of the prompt card: the requests for
// GET /api/agents/:id/prompt and POST /api/agents/:id/keys
// (server/agents/prompt-api.ts), and the pure rules the card renders from.
import type { PromptKey } from "../../server/agents/prompt"; // type-only
import type { PromptState } from "../../server/agents/prompt-watch"; // type-only
import { chiefFetch } from "./chief";

export type { PromptKey, PromptState };

// The prompt on the agent's screen now. `live` false: no terminal process.
export type PromptRes = { live: boolean; prompt: PromptState | null };

const EMPTY: PromptRes = { live: false, prompt: null };

// An agent that is gone has no prompt: the card goes away.
export async function fetchPrompt(id: string, signal?: AbortSignal): Promise<PromptRes> {
  const r = await chiefFetch(`/api/agents/${encodeURIComponent(id)}/prompt`, { signal });
  if (r.status === 404) return EMPTY;
  if (!r.ok) throw new Error(`prompt failed (${r.status})`);
  const body = (await r.json()) as Partial<PromptRes>;
  return { live: body.live === true, prompt: body.prompt ?? null };
}

export type KeysOutcome =
  | { kind: "sent" }
  // The card was not the prompt on screen. `prompt` is what shows now.
  | { kind: "stale"; prompt: PromptState | null }
  | { kind: "not-live" }
  | { kind: "gone" }
  | { kind: "failed"; status: number };

// The answer of the keys route as one value. Split from the request for tests.
export function keysOutcome(status: number, body: unknown): KeysOutcome {
  const b = (body ?? {}) as { reason?: unknown; prompt?: unknown };
  if (status === 200) return { kind: "sent" };
  if (status === 404) return { kind: "gone" };
  if (status === 409 && b.reason === "stale") return { kind: "stale", prompt: (b.prompt as PromptState | null | undefined) ?? null };
  if (status === 409) return { kind: "not-live" };
  return { kind: "failed", status };
}

// With `rev` the server types the keys only while that exact card is still on
// the screen. Without it (the four keys of an unknown prompt, Interrupt) there
// is no check.
export async function sendKeys(id: string, keys: PromptKey[], rev?: string): Promise<KeysOutcome> {
  let r: Response;
  try {
    r = await chiefFetch(`/api/agents/${encodeURIComponent(id)}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rev === undefined ? { keys } : { keys, rev }),
    });
  } catch {
    return { kind: "failed", status: 0 };
  }
  return keysOutcome(r.status, await r.json().catch(() => null));
}

// What the card says after a key request that did not go through.
export function outcomeNote(o: KeysOutcome): string | null {
  switch (o.kind) {
    case "sent": return null;
    case "stale": return o.prompt ? "The prompt changed. Read it again, then choose." : "The prompt is gone. Nothing was sent.";
    case "not-live": return "The agent has no live terminal. Nothing was sent.";
    case "gone": return "The agent is gone.";
    case "failed": return o.status === 403 ? "Not allowed from this device." : "The keys were not sent. Try again.";
  }
}

// The option that gets the filled button: the "yes" answer of a yes/no dialog
// (trust, permission). A list of equal choices (login method, a model) has none.
export function primaryOption(p: Pick<PromptState, "kind" | "options">): number | null {
  if (p.kind === "unknown" || p.kind === "login-method") return null;
  const yes = p.options.findIndex((o) => /^yes\b/i.test(o.label.trim()));
  return yes >= 0 ? yes : null;
}

// Short answers sit in a row; long ones, or many, in a column of full-width buttons.
export const ROW_MAX_OPTIONS = 3;
export const ROW_MAX_LABEL = 32;
export function optionsLayout(p: Pick<PromptState, "options">): "row" | "column" {
  return p.options.length <= ROW_MAX_OPTIONS && p.options.every((o) => o.label.length <= ROW_MAX_LABEL) ? "row" : "column";
}

// The screen text of an unknown prompt, line by line. `pointed`: the line the
// dialog's pointer is on (shown strong, as the terminal does).
export function screenLines(text: string): { text: string; pointed: boolean }[] {
  return text.split("\n").map((line) => ({ text: line, pointed: /^[\s│|]*❯/.test(line) }));
}

// The four keys of an unknown prompt, in the order the card shows them.
export const UNKNOWN_KEYS: { key: PromptKey; label: string; name: string }[] = [
  { key: "up", label: "↑", name: "Up" },
  { key: "down", label: "↓", name: "Down" },
  { key: "enter", label: "Enter", name: "Enter" },
  { key: "esc", label: "Esc", name: "Esc" },
];
