// src/components/PrCi.tsx — the CI parts of a pr ticket, the same in the thread card and in the
// Queue reading pane: "Checks: <state>" as a link, the caret that opens the list of the checks,
// and one link for each preview deployment (lib/prCi). Every name from GitHub is a React text
// node, and only an http(s) URL is a link. Each link opens in a new tab.
"use client";
import type { ReactNode } from "react";
import { formatDuration } from "../lib/cockpit";
import { checkRows, checksHref, previewLinks, type PrCiView } from "../lib/prCi";
import { CheckIcon, ChevronIcon, ExternalIcon, Mark } from "./SideIcons";
import s from "./PrCi.module.css";

const NEW_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;
const MARK = { passed: "ok", failed: "fail", pending: "run" } as const;

type Pr = { slug?: string; number: number };

// The mark in front of the state word in a pill: a check when the checks pass, else a dot (colour
// only at dot size).
function PillMark({ tone }: { tone?: string }) {
  if (tone === "good") return <span className={s.tick} aria-hidden><CheckIcon size={12} /></span>;
  if (tone === "bad" || tone === "warn") return <span className={s.dot} data-tone={tone} aria-hidden />;
  return null;
}

// The state word as a link (the first failed check, else the PR's checks page), then the caret.
// `onToggle`: the card's "the user opens something" call (the thread must not jump away).
// `pill`: the look of the Queue reading pane's facts row (a pill with a mark and the count).
export function ChecksFact({ view, pr, tone, onToggle, pill, children }: { view: PrCiView; pr: Pr; tone?: string; onToggle?: () => void; pill?: boolean; children: ReactNode }) {
  const href = checksHref(pr.slug, pr.number, view.ci);
  const rows = pill ? checkRows(view.ci) : [];
  const count = rows.length > 0 ? ` ${rows.filter((r) => r.status === "passed").length}/${rows.length}` : "";
  if (!href) return pill ? <span className={s.pill}><PillMark tone={tone} />{children}</span> : <span data-tone={tone}>{children}</span>;
  if (pill) {
    return (
      <span className={`${s.pill} ${s.pillLink}`}>
        <a className={s.pillA} href={href} {...NEW_TAB} title="Open the checks on GitHub"><PillMark tone={tone} />{children}{count}<ExternalIcon size={10} /></a>
        <button
          type="button" className={s.pillCaret} aria-expanded={view.open} aria-label={view.open ? "Hide the list of checks" : "Show the list of checks"}
          onClick={() => { onToggle?.(); view.toggle(); }}
        >
          <ChevronIcon open={view.open} size={10} />
        </button>
      </span>
    );
  }
  return (
    <span className={s.fact}>
      <a className={s.link} data-tone={tone} href={href} {...NEW_TAB} title="Open the checks on GitHub">{children}<ExternalIcon size={10} /></a>
      <button
        type="button" className={s.caret} aria-expanded={view.open} aria-label={view.open ? "Hide the list of checks" : "Show the list of checks"}
        onClick={() => { onToggle?.(); view.toggle(); }}
      >
        <ChevronIcon open={view.open} size={10} />
      </button>
    </span>
  );
}

export function PreviewLinks({ view, pill }: { view: PrCiView; pill?: boolean }) {
  return (
    <>
      {previewLinks(view.ci).map((p) => (
        <a key={`${p.label} ${p.url}`} className={pill ? `${s.pill} ${s.pillLink}` : s.link} href={p.url} {...NEW_TAB} title={p.url}>{p.label}<ExternalIcon size={10} /></a>
      ))}
    </>
  );
}

// The list under the facts row: state, name, duration and link of each check (the look of the
// Changes column's CI section).
export function ChecksList({ view }: { view: PrCiView }) {
  if (!view.open) return null;
  const rows = checkRows(view.ci);
  return (
    <div className={s.list} role="group" aria-label="Checks">
      {!view.ci && <div className={s.empty}>{view.failed ? "The checks could not be read." : "Loading the checks…"}</div>}
      {view.ci && rows.length === 0 && <div className={s.empty}>This PR has no checks.</div>}
      {rows.map((r, n) => {
        const inner = (
          <>
            <span className={s.glyph} data-status={r.status} aria-label={r.status}><Mark kind={MARK[r.status]} /></span>
            <span className={s.name}>{r.name}</span>
            <span className={s.meta}>{formatDuration(r.durationMs)}{r.href && <ExternalIcon size={10} />}</span>
          </>
        );
        return r.href
          ? <a key={n} className={s.row} href={r.href} {...NEW_TAB} title={r.name}>{inner}</a>
          : <div key={n} className={s.row} title={r.name}>{inner}</div>;
      })}
    </div>
  );
}
