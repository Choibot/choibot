// src/lib/useUsageFoot.ts — what the header of the footer (AccountLine) and its usage lines
// (UsageMeter) share: if the lines are folded, and the state of the worst line.
"use client";
import { useCallback, useSyncExternalStore } from "react";
import type { LineState } from "./usage";

function store<T>(first: T) {
  let value = first;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(value, next)) return;
      value = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
}

// The choice of the user, per browser. A key of its own: "side.usage.folded" was the old form
// (fewer windows per login), with the opposite default.
export const FOLD_KEY = "side.usage.closed";
const fold = store<boolean | null>(null); // null: not read yet

// Read one time, at the first client render. The server render and the hydration use `false`
// (getServerSnapshot); React then draws the stored choice before the first paint. The lines come
// only with the first usage answer, so a folded footer never shows them for a frame.
function readFold(): boolean {
  const v = fold.get();
  if (v !== null) return v;
  let stored = false;
  try { stored = window.localStorage.getItem(FOLD_KEY) === "1"; } catch { /* private mode */ }
  fold.set(stored);
  return stored;
}

export function useUsageFold(): [boolean, () => void] {
  const folded = useSyncExternalStore(fold.subscribe, readFold, () => false);
  const toggle = useCallback(() => {
    const next = !readFold();
    try { window.localStorage.setItem(FOLD_KEY, next ? "1" : "0"); } catch { /* private mode */ }
    fold.set(next);
  }, []);
  return [folded, toggle];
}

// The state of the worst usage line. Null: there are no lines, so there is nothing to fold.
const worst = store<LineState | null>(null);
export const setUsageWorst = (state: LineState | null): void => worst.set(state);
export function useUsageWorst(): LineState | null {
  return useSyncExternalStore(worst.subscribe, worst.get, () => null);
}
