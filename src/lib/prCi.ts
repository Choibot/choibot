// src/lib/prCi.ts — the CI of a pr ticket: where "Checks: <state>" links to, the list of the
// checks, the preview links, and the one CI read of a ticket on screen. The source is the one
// of the Changes column (lib/gh `fetchPrCi`). Names and URLs from GitHub are untrusted: a caller
// shows a name as a React text node, and only an http(s) URL becomes a link.
"use client";
import { useEffect, useState, type RefObject } from "react";
import { sortCheckRuns } from "./cockpit";
import { fetchPrCi, type CheckRun, type PrCi } from "./gh";

export function webUrl(raw: string | undefined): string | null {
  try {
    const u = new URL(raw ?? "");
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "" ? u.href : null;
  } catch {
    return null;
  }
}

// The checks in the order of the list (failed, then running, then passed).
export type CheckRow = CheckRun & { href: string | null };
export const checkRows = (ci: PrCi | null): CheckRow[] => sortCheckRuns(ci?.checkRuns ?? []).map((r) => ({ ...r, href: webUrl(r.url) }));

// The target of "Checks: <state>": the first failed check run, else the PR's checks page on
// GitHub. `slug` is owner/name from the PR url (lib/queueDetail `prSlug`); none gives no link.
export function checksHref(slug: string | undefined, pr: number, ci: PrCi | null): string | null {
  if (!slug) return null;
  return checkRows(ci).find((r) => r.status === "failed" && r.href)?.href ?? `https://github.com/${slug}/pull/${pr}/checks`;
}

// One link for each deployment of the PR's head commit, the preview environment first. The
// label is the environment's name as GitHub gives it ("Preview" for Vercel).
export type PreviewLink = { label: string; url: string };
export function previewLinks(ci: PrCi | null): PreviewLink[] {
  const all = (ci?.deployments ?? []).flatMap((d) => {
    const url = webUrl(d.url), label = d.environment.trim() || "Preview";
    return url ? [{ label, url }] : [];
  });
  const isPreview = (l: PreviewLink) => /preview/i.test(l.label);
  return [...all.filter(isPreview), ...all.filter((l) => !isPreview(l))];
}

// One CI read serves both views of a ticket for a minute (the server keeps a read as long).
export const CI_KEEP_MS = 60_000;
const SETTLE_MS = 500; // j / k across the list, or a card that scrolls past, starts no read
type Kept = { at: number; checks: string | undefined; ci: PrCi };
const kept = new Map<string, Kept>();

// What a ticket on screen does with the read it has. The server keeps the ticket's rollup word
// fresh (queue/prwatch), so a new word says that the CI changed: read past the server's cache.
export function ciReadPlan(hit: Pick<Kept, "at" | "checks"> | undefined, checks: string | undefined, now: number): "keep" | "read" | "fresh" {
  if (!hit) return "read";
  if (hit.checks !== checks) return "fresh";
  return now - hit.at < CI_KEEP_MS ? "keep" : "read";
}

export type PrCiView = { ci: PrCi | null; failed: boolean; open: boolean; toggle: () => void };

// The CI of one PR for a ticket. It reads only while `shown` (the ticket is on screen), and
// then only when it has no read, the read is older than a minute, or the rollup word changed.
// No timer: a ticket that nobody looks at costs no GitHub call.
export function usePrCi(slug: string | undefined, pr: number | undefined, checks: string | undefined, shown: boolean): PrCiView {
  const key = slug && pr ? `${slug}#${pr}` : null;
  const [ci, setCi] = useState<PrCi | null>(() => (key ? kept.get(key)?.ci ?? null : null));
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); setFailed(false); }, [key]);
  useEffect(() => {
    if (!key || !slug || !pr) { setCi(null); return; }
    const hit = kept.get(key);
    setCi(hit?.ci ?? null);
    if (!shown) return;
    const plan = ciReadPlan(hit, checks, Date.now());
    if (plan === "keep") return;
    let live = true;
    const timer = setTimeout(() => {
      void fetchPrCi(slug, pr, plan === "fresh").then((d) => {
        if (d) kept.set(key, { at: Date.now(), checks, ci: d });
        if (!live) return;
        if (d) setCi(d);
        setFailed(!d);
      });
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [key, slug, pr, checks, shown, open]);
  return { ci, failed, open, toggle: () => setOpen((v) => !v) };
}

// True while the element is on screen (a ticket card in a long thread).
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setOn(true); return; }
    const io = new IntersectionObserver((es) => setOn(es[es.length - 1]?.isIntersecting ?? false));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}
