// src/lib/useFold.ts
"use client";
import { useState } from "react";

// Collapsed/expanded state for a rail section, persisted per key in
// localStorage so the choice survives reloads and agent switches. SSR-safe:
// prerender falls back to `initial` (the client re-inits from storage on mount
// because the component only renders data fetched client-side anyway).
export function useFold(key: string, initial = false): [boolean, () => void] {
  const [folded, setFolded] = useState<boolean>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const v = window.localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setFolded((f) => {
      const n = !f;
      try { window.localStorage.setItem(key, n ? "1" : "0"); } catch { /* private mode */ }
      return n;
    });
  return [folded, toggle];
}
