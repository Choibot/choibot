// src/lib/usePrSize.ts — the size of a PR (files, plus and minus lines) and its file list for the
// Queue view's reading pane. The queue item holds only checks and mergeable, so the size comes from the PR
// diff API (the source of the Diff panel). One request per PR in 5 min, and only after the
// ticket stayed selected for a moment (j / k across the list starts no request).
"use client";
import { useEffect, useState } from "react";
import { parsePatch, type ChangeType, type FileDiff } from "./diff";
import { fetchPrDiff } from "./pr";
import { sizeWords } from "./queueInbox";

export type PrSizeFile = { path: string; type: ChangeType; additions: number; deletions: number };
export type PrSize = ReturnType<typeof sizeWords> & { list: PrSizeFile[] };

const withList = (files: FileDiff[]): PrSize => ({
  ...sizeWords(files),
  list: files.map((f) => ({ path: f.path, type: f.type, additions: f.additions, deletions: f.deletions })),
});

const KEEP_MS = 5 * 60_000;
const RETRY_MS = 60_000; // a failed read is not tried again before this
const SETTLE_MS = 500;
const cache = new Map<string, { at: number; size: PrSize | null }>();

function cached(key: string, now: number): { size: PrSize | null } | null {
  const c = cache.get(key);
  if (!c) return null;
  return now - c.at < (c.size ? KEEP_MS : RETRY_MS) ? c : null;
}

// `slug` is owner/name. Null while unknown, and when the diff cannot be read.
export function usePrSize(slug: string | undefined, pr: number | undefined): PrSize | null {
  const key = slug && pr ? `${slug}#${pr}` : null;
  const [size, setSize] = useState<PrSize | null>(() => (key ? cached(key, Date.now())?.size ?? null : null));
  useEffect(() => {
    if (!key || !slug || !pr) { setSize(null); return; }
    const hit = cached(key, Date.now());
    if (hit) { setSize(hit.size); return; }
    setSize(null);
    let live = true;
    const timer = setTimeout(() => {
      void fetchPrDiff({ repo: slug, pr })
        .then((r) => (r.ok ? withList(parsePatch(r.data.diff)) : null))
        .catch(() => null)
        .then((s) => {
          cache.set(key, { at: Date.now(), size: s });
          if (live) setSize(s);
        });
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [key, slug, pr]);
  return size;
}
