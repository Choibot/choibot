// src/lib/usePrompt.ts — the terminal dialog an agent waits on, kept live.
// The prompt is read when the pane opens and each time the server says it
// changed (the `agent-prompt` event). There is no poll: a dialog that appears
// or goes away always sends an event, and a reconnect of the event stream or
// a tab that comes back reads again.
// The last card of each agent is remembered (lib/viewCache), so a pane that opens again has the
// card in place on its first frame (the composer does not move when the read lands). Until the
// first read of this pane answers, a press reads the card again first: a remembered card that is
// gone or changed sends nothing.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPrompt, outcomeNote, sendKeys, type KeysOutcome, type PromptKey, type PromptState } from "./prompt";
import type { ConsoleEvent } from "./useEvents";
import { agentMemory } from "./viewCache";

const prompts = agentMemory<PromptState | null>();

// The warm-up (lib/warmup): remember the agent's card before its pane opens. The pane still reads
// it again, and a press before that read checks it first.
export async function prefetchPrompt(agentId: string): Promise<void> {
  if (prompts.has(agentId)) return;
  const res = await fetchPrompt(agentId);
  if (!prompts.has(agentId)) prompts.set(agentId, res.prompt);
}

// After keys went through, the dialog repaints and the server sends an event.
// This second look is for a key the dialog ignored (no repaint, no event).
export const AFTER_KEYS_MS = 700;

export type PromptHandle = {
  prompt: PromptState | null;
  // Keys are on their way, or the answer to them is not on screen yet.
  busy: boolean;
  // Why the last keys did not go through; null otherwise.
  note: string | null;
  // `rev` given: the keys of an option button, valid only for that card.
  press: (keys: PromptKey[], rev?: string) => Promise<KeysOutcome>;
  // For the pane's one event stream (useThread's tap).
  onEvent: (e: ConsoleEvent) => void;
  refresh: () => void;
};

// `enabled` false (the raw terminal is the user's choice) reads nothing and
// shows no card.
export function usePrompt(agentId: string, enabled: boolean): PromptHandle {
  const [prompt, setPromptState] = useState<PromptState | null>(() => prompts.get(agentId) ?? null);
  // The card on screen came from this pane's own read (not only from the memory).
  const confirmed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const setPrompt = useCallback((p: PromptState | null): void => {
    prompts.set(agentRef.current, p);
    setPromptState(p);
  }, []);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // Only the newest read may publish: answers can arrive out of order.
  const seq = useRef(0);
  // The rev of the card the note is about: another card drops the note.
  const noteRev = useRef("");

  const refresh = useCallback((): void => {
    if (!enabledRef.current) return;
    const id = agentRef.current;
    const mine = ++seq.current;
    void fetchPrompt(id).then(
      (res) => { if (mine === seq.current && agentRef.current === id) { confirmed.current = true; setPrompt(res.prompt); } },
      () => { /* a failed read keeps what is shown; the next event reads again */ },
    );
  }, [setPrompt]);

  useEffect(() => {
    seq.current++;
    confirmed.current = false;
    setPromptState(prompts.get(agentId) ?? null); setBusy(false); setNote(null);
    if (!enabled) return;
    refresh();
    const onVisible = (): void => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [agentId, enabled, refresh]);

  const onEvent = useCallback((e: ConsoleEvent): void => {
    if (e.type !== "agent-prompt" || e.agentId !== agentRef.current) return;
    // Gone: no request needed. Else the event has no text: read the card.
    if (e.kind === null) { seq.current++; confirmed.current = true; setPrompt(null); setBusy(false); setNote(null); return; }
    refresh();
  }, [refresh, setPrompt]);

  // A new card (another rev) is a new question: the old note does not apply,
  // and the answer to the last keys is on screen.
  const rev = prompt?.rev ?? "";
  const shownRev = useRef(rev);
  useEffect(() => {
    if (shownRev.current === rev) return;
    shownRev.current = rev;
    setBusy(false);
    if (noteRev.current !== rev) setNote(null);
  }, [rev]);

  const press = useCallback(async (keys: PromptKey[], withRev?: string): Promise<KeysOutcome> => {
    const id = agentRef.current;
    setBusy(true);
    setNote(null);
    // The card is still the remembered one: read it first, and send only while it is the same.
    if (!confirmed.current) {
      const was = shownRev.current;
      const fresh = await fetchPrompt(id).catch(() => null);
      if (agentRef.current !== id) return { kind: "stale", prompt: null };
      if (!fresh || (fresh.prompt?.rev ?? "") !== was) {
        // No answer: nothing is sent either (the card may be gone).
        const out: KeysOutcome = fresh ? { kind: "stale", prompt: fresh.prompt } : { kind: "failed", status: 0 };
        seq.current++;
        confirmed.current = fresh !== null;
        setBusy(false);
        noteRev.current = fresh?.prompt?.rev ?? was;
        setNote(outcomeNote(out));
        if (fresh) setPrompt(fresh.prompt);
        return out;
      }
      confirmed.current = true;
    }
    const out = await sendKeys(id, keys, withRev);
    if (agentRef.current !== id) return out;
    if (out.kind === "sent") {
      // An option button stays off until the dialog answers (a new rev ends
      // `busy` above) or the second look finds the same card. A lone key of an
      // unknown prompt is free again at once: Up and Down are pressed in a row.
      if (withRev === undefined) setBusy(false);
      setTimeout(() => {
        if (agentRef.current !== id) return;
        refresh();
        setBusy(false);
      }, AFTER_KEYS_MS);
      return out;
    }
    setBusy(false);
    // On a stale card the note goes with the prompt that shows now.
    noteRev.current = out.kind === "stale" ? out.prompt?.rev ?? "" : shownRev.current;
    setNote(outcomeNote(out));
    if (out.kind === "stale") { seq.current++; setPrompt(out.prompt); }
    else refresh();
    return out;
  }, [refresh, setPrompt]);

  return { prompt: enabled ? prompt : null, busy, note, press, onEvent, refresh };
}
