// src/lib/viewCache.ts — what each view showed the last time, so a view that opens again draws
// it on its first frame and refreshes in the background (stale-while-revalidate). Without it,
// each move between agents, the Queue, GitHub or a cron job built the new view from nothing: an
// empty pane or "Loading…" for one round trip, then the content jumped in.
//
// The memory is only a first frame. Every view still asks the server when it opens and replaces
// the remembered data with the answer; an action never trusts it (the server re-checks a prompt
// card's rev, a ticket's state, a PR's state before it acts).
//
// Each store is bounded (least recently used goes first). A store keyed by agent id drops the
// agent's entries when the agent is deleted (forgetAgent).
"use client";
import { useCallback, useState, type UIEvent } from "react";

// Agents remembered per store: a user moves between a handful of agents.
export const AGENT_MAX = 20;

export class Remembered<V> {
  private readonly map = new Map<string, V>();
  constructor(readonly max: number) {
    if (!(max >= 1)) throw new Error("a store holds at least one entry");
  }
  get size(): number { return this.map.size; }
  has(key: string): boolean { return this.map.has(key); }
  // A read counts as a use: the entry becomes the newest.
  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
  delete(key: string): void { this.map.delete(key); }
  // Every key that `match` accepts (forgetAgent).
  deleteWhere(match: (key: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (match(k)) this.map.delete(k);
  }
  clear(): void { this.map.clear(); }
}

const agentStores: Remembered<unknown>[] = [];

// A store keyed by agent id, or by agentKey(id, part) for more than one entry per agent.
export function agentMemory<V>(max = AGENT_MAX): Remembered<V> {
  const store = new Remembered<V>(max);
  agentStores.push(store as Remembered<unknown>);
  return store;
}

// A store keyed by something else (a repo root, a cron job, one fixed key for a whole view).
export function viewMemory<V>(max: number): Remembered<V> {
  return new Remembered<V>(max);
}

// One agent's entry for one part (a widget of the agent, say).
export function agentKey(agentId: string, part: string): string {
  return `${agentId}\n${part}`;
}

// The agent was deleted: nothing of it is shown again.
export function forgetAgent(agentId: string): void {
  const sub = `${agentId}\n`;
  for (const store of agentStores) store.deleteWhere((k) => k === agentId || k.startsWith(sub));
}

export type SetRemembered<V> = (next: V | ((prev: V) => V)) => void;

// What a hook shows: the value and the key it belongs to.
export type Shown<V> = { key: string | null; value: V };

// One set of the hook (pure, for the tests): the new value goes to the store under the setter's
// key, and on screen only while that key is still the one shown. A setter made for an old key
// (a late answer for the agent the user left) only updates that key's entry.
export function applySet<V>(store: Remembered<V>, prev: Shown<V>, key: string | null, next: V | ((prev: V) => V)): Shown<V> {
  const mine = prev.key === key;
  let value: V;
  if (typeof next === "function") {
    if (!mine && (key === null || !store.has(key))) return prev; // nothing to apply the change to
    value = (next as (p: V) => V)(mine ? prev.value : (store.get(key as string) as V));
  } else {
    value = next;
  }
  if (key !== null) store.set(key, value);
  return !mine || Object.is(prev.value, value) ? prev : { key, value };
}

// useState that starts from the store's entry for `key` (else `fallback`) and writes each new
// value back. A new key shows its own entry in the same render (no frame with the old key's
// data).
export function useRemembered<V>(store: Remembered<V>, key: string | null, fallback: V): [V, SetRemembered<V>] {
  const read = (k: string | null): V => (k !== null && store.has(k) ? (store.get(k) as V) : fallback);
  const [box, setBox] = useState<Shown<V>>(() => ({ key, value: read(key) }));
  let shown = box;
  if (box.key !== key) {
    shown = { key, value: read(key) };
    setBox(shown); // own state during render: React renders again at once, before anything paints
  }
  const set = useCallback<SetRemembered<V>>((next) => {
    // A plain value is remembered at once, even when the view is gone before React applies it.
    if (typeof next !== "function" && key !== null) store.set(key, next);
    setBox((prev) => applySet(store, prev, key, next));
  }, [store, key]);
  return [shown.value, set];
}

// Where each remembered scroll box was left.
const scrolls = viewMemory<number>(40);

// A scroll box that mounts again opens where the user left it, on its first frame (a ref callback
// runs before the paint). Give it `ref` and `onScroll`. Its content must be there in the same
// render (remembered data), else it opens at the top as before.
export function useScrollMemory<T extends HTMLElement>(key: string): { ref: (el: T | null) => void; onScroll: (e: UIEvent<T>) => void } {
  const ref = useCallback((el: T | null) => {
    const top = scrolls.get(key);
    if (el && top !== undefined) el.scrollTop = top;
  }, [key]);
  const onScroll = useCallback((e: UIEvent<T>) => { scrolls.set(key, e.currentTarget.scrollTop); }, [key]);
  return { ref, onScroll };
}
