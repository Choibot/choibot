// src/components/QueueMerge.tsx — the Merge button of an open pr ticket in the Queue view (the
// user's ask of 2026-11-19). The user still merges: one press in the ticket, then one confirm in
// place ("Squash and merge #12 into main?" Merge / Cancel; Esc cancels). A merge cannot be undone.
// The press reads the PR fresh on the server (GET /api/queue/:id/merge), never the cached pills;
// the confirm shows what GitHub says (repo, GitHub's title, head → base, the short head commit),
// not the agent's ticket text, and posts that head commit with the merge (POST): the server
// refuses when the PR moved since, and GitHub merges only that commit. Checks that fail or still run
// ask first ("Checks: 1 failing. Merge anyway?"). Conflicts, a draft, a merged or closed PR give
// a disabled button with the reason. The routes are USER only: a device with no user token sees
// the button disabled. The method (squash, merge, rebase) is remembered per repo in this browser.
// Every string renders as a React text node (the GitHub error text too).
"use client";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { QueueItem } from "../../server/chief/queue/types"; // type-only
import type { PrMergeFacts } from "../../server/gh/status"; // type-only
import { pairSentence } from "../lib/chief";
import { mergeTicket, readMerge, saveMergeMethod, savedMergeMethod, type MergeMethod } from "../lib/queue";
import { prSlug } from "../lib/queueDetail";
import { CheckIcon, ChevronIcon, ExternalIcon, MoreIcon } from "./SideIcons";
import q from "./QueueView.module.css";
import s from "./QueueMerge.module.css";

const METHODS: { id: MergeMethod; label: string }[] = [
  { id: "squash", label: "Squash and merge" }, { id: "merge", label: "Create a merge commit" }, { id: "rebase", label: "Rebase and merge" },
];
const VERB: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge", rebase: "Rebase and merge" };
// A reason from the press-time read stays this long; then the button reads again on a press.
const BLOCK_KEEP_MS = 60_000;
const MOVED_TEXT = "New commits since you opened this. Look again.";
// Why Merge cannot run now ("unknown": GitHub has not finished its conflict check, a short wait).
type Block = { why: string; text: string };

// What the Queue view does around a merge: `commit` before the post (focus to the list, the
// enter guard: the confirm row goes away with the ticket), `merged` with the closed ticket.
export type MergeHooks = { commit(): void; merged(item: QueueItem): void };
export const MergeHooksContext = createContext<MergeHooks | null>(null);

// The `m` key (lib/useQueueKeys): it opens the confirm step of the ticket's button, the same as a
// press. It never merges by itself.
const asks = new Map<string, number>();
const subs = new Set<() => void>();
export function askMerge(id: string): void {
  asks.set(id, (asks.get(id) ?? 0) + 1);
  for (const f of subs) f();
}
const sub = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const useAsk = (id: string): number => useSyncExternalStore(sub, () => asks.get(id) ?? 0, () => 0);

// What the button tells the rest of the footer, per ticket: its one short line (a reason, a
// wait, the GitHub error; MergeLine shows it as the footer's first row, so a long text never
// pushes the buttons out of place) and `off`, a reason from the press-time read that keeps Merge
// from running (the footer then shows "Open PR" in the bar: GitHub is where to go).
type Said = { text: string | null; error: boolean; off: boolean };
const said = new Map<string, Said>();
const saidSubs = new Set<() => void>();
function tell(id: string, v: Said | null): void {
  const cur = said.get(id);
  if (v ? cur && cur.text === v.text && cur.error === v.error && cur.off === v.off : !cur) return;
  if (v) said.set(id, v); else said.delete(id);
  for (const f of saidSubs) f();
}
const saidSub = (f: () => void) => { saidSubs.add(f); return () => { saidSubs.delete(f); }; };
const useSaid = (id: string): Said | undefined => useSyncExternalStore(saidSub, () => said.get(id), () => undefined);

// The line of the ticket's Merge button, or the reason from its pills (conflicts) before any press.
export function MergeLine({ item }: { item: QueueItem }) {
  const l = useSaid(item.id);
  const text = l?.text ?? pillBlock(item)?.text;
  if (!text) return null;
  return <div className={l?.error ? s.err : s.line} role={l?.error ? "alert" : "status"}>{text}</div>;
}

// True when Merge cannot run on this ticket now: a device that is not paired, conflicts on the
// pills, or a reason from the press-time read (draft, merged, closed, another PR).
export function useMergeOff(item: QueueItem, readOnly: boolean): boolean {
  const l = useSaid(item.id);
  return readOnly || !!pillBlock(item) || !!l?.off;
}

// The reason from the ticket's pills alone (before any press): conflicts.
export function pillBlock(i: QueueItem): Block | null {
  const pr = i.pr;
  if (!pr || !("url" in pr)) return null;
  return pr.mergeable === "CONFLICTING" ? { why: "conflicts", text: `PR #${pr.number} has conflicts. Fix them first.` } : null;
}

// An Esc that closed a menu or the confirm goes no further. React's root is the document here,
// so stopPropagation alone does not keep it from the Queue keys' document listener (whose Esc
// on a phone leaves the ticket screen); React's listener runs first, so this stops that one too.
function stopEsc(e: KeyboardEvent): void {
  e.stopPropagation();
  e.nativeEvent.stopImmediatePropagation();
}

type Phase = "idle" | "reading" | "confirm" | "merging" | "merged";
type Props = { item: QueueItem; readOnly: boolean; userAuth: "telegram" | "log" | null; phone: boolean };

export function MergeButton({ item: i, readOnly, userAuth, phone }: Props) {
  const hooks = useContext(MergeHooksContext);
  const pr = i.pr && "url" in i.pr ? i.pr : null;
  const slug = pr ? prSlug(pr.url) ?? i.repo : i.repo;
  const [method, setMethod] = useState<MergeMethod>(() => savedMergeMethod(slug));
  const [menu, setMenu] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [facts, setFacts] = useState<PrMergeFacts | null>(null); // what the confirm shows and binds to
  const [ask, setAsk] = useState<string | null>(null); // the checks ask of the confirm step
  const [block, setBlock] = useState<Block | null>(null); // from the press-time read
  const [note, setNote] = useState<string | null>(null); // a short line: wait, or "merged"
  const [error, setError] = useState<string | null>(null); // the GitHub error text
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // A reason from the press-time read goes after a while and when the page is in front again
  // (the user fixed it on GitHub): the next press reads again.
  useEffect(() => {
    if (!block) return;
    const t = setTimeout(() => setBlock(null), BLOCK_KEEP_MS);
    const back = () => { if (document.visibilityState === "visible") setBlock(null); };
    document.addEventListener("visibilitychange", back);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", back); };
  }, [block]);

  // Focus: the confirm row takes it on Cancel (Enter there cancels); Cancel or Esc gives it back
  // to the Merge button. Never to body: Enter on body is "accept the suggestion".
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mergeRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<"cancel" | "merge" | null>(null);
  useLayoutEffect(() => {
    const r = refocus.current;
    refocus.current = null;
    if (r === "cancel") cancelRef.current?.focus();
    else if (r === "merge") mergeRef.current?.focus();
  }, [phase]);

  const blocked = block && block.why !== "unknown" ? block : pillBlock(i);
  const disabled = readOnly || !pr || !!blocked || phase !== "idle";

  const begin = async (): Promise<void> => {
    if (disabled) return;
    setMenu(false); setError(null); setNote(null); setPhase("reading");
    const r = await readMerge(i.id);
    if (!alive.current) return;
    if (!r.ok) {
      setPhase("idle");
      // GitHub gave another PR than the ticket's: Merge stays off.
      if (r.reason === "mismatch") setBlock({ why: "mismatch", text: r.error }); else setError(r.error);
      return;
    }
    setFacts(r.view.facts);
    if (r.view.blocked) {
      setPhase("idle");
      if (r.view.blocked.why === "unknown") setNote(r.view.blocked.text); else setBlock(r.view.blocked);
      return;
    }
    setAsk(r.view.checks);
    refocus.current = "cancel";
    setPhase("confirm");
  };
  const cancel = () => { refocus.current = "merge"; setAsk(null); setPhase("idle"); };
  const confirm = async (): Promise<void> => {
    if (phase !== "confirm" || !facts) return;
    hooks?.commit();
    setPhase("merging");
    const r = await mergeTicket(i.id, method, facts.headSha, ask !== null);
    if (!alive.current) return;
    if (r.ok) {
      setPhase("merged");
      if (r.item.status === "open" || r.item.status === "snoozed") setNote("Merged. The ticket closes when GitHub shows the merge.");
      hooks?.merged(r.item);
      return;
    }
    // The checks changed between the read and the press: ask now.
    if (r.reason === "checks" && r.checks) { setAsk(r.checks); refocus.current = "cancel"; setPhase("confirm"); return; }
    setPhase("idle");
    setAsk(null);
    if (r.reason === "blocked" && r.blocked) {
      if (r.blocked.why === "unknown") setNote(r.blocked.text); else setBlock(r.blocked);
      return;
    }
    // A push since the confirm: the next press reads again and shows the new head.
    if (r.reason === "moved") { setNote(MOVED_TEXT); return; }
    if (r.reason === "mismatch") { setBlock({ why: "mismatch", text: r.error }); return; }
    setError(r.error);
  };

  // The `m` key: a new ask since this button mounted opens the confirm step.
  const asked = useAsk(i.id);
  const seen = useRef(asked);
  useEffect(() => {
    if (asked === seen.current) return;
    seen.current = asked;
    void begin();
  }, [asked]); // eslint-disable-line react-hooks/exhaustive-deps

  // The line goes to MergeLine (the footer's first row), `off` to the footer; both go with the button.
  const lineText = readOnly ? null : error ?? note ?? (blocked ? blocked.text : null);
  const off = !!block && block.why !== "unknown";
  useEffect(() => { tell(i.id, lineText || off ? { text: lineText, error: error !== null, off } : null); }, [i.id, lineText, error, off]);
  useEffect(() => () => tell(i.id, null), [i.id]);

  // The method menu closes on a press outside it.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menu]);

  const pick = (m: MergeMethod) => { setMethod(m); saveMergeMethod(slug, m); setMenu(false); mergeRef.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (phase === "confirm") { stopEsc(e); cancel(); }
    else if (menu) { stopEsc(e); setMenu(false); mergeRef.current?.focus(); }
  };

  if (!pr) return null;
  const title = readOnly ? pairSentence(userAuth, "Merge") : blocked ? blocked.text : `${VERB[method]} PR #${pr.number} on GitHub`;
  const confirming = phase === "confirm" || phase === "merging";
  return (
    <div ref={boxRef} className={s.box} data-merge="" data-confirm={confirming ? "" : undefined} onKeyDown={onKey}>
      {confirming ? (
        <span className={s.confirm}>
          {facts && <ConfirmText facts={facts} verb={VERB[method]} ask={ask} />}
          <span className={s.pair}>
            <button type="button" className={`${q.b} ${q.pri}`} disabled={phase === "merging"} onClick={() => void confirm()}>
              {phase === "merging" ? "Merging…" : ask ? "Merge anyway" : "Merge"}
            </button>
            <button ref={cancelRef} type="button" className={q.b} disabled={phase === "merging"} onClick={cancel}>Cancel</button>
          </span>
        </span>
      ) : (
        <span className={s.split}>
          <button
            ref={mergeRef} type="button" className={`${q.b} ${q.pri} ${s.main}`} disabled={disabled} title={title}
            aria-label={`Merge PR #${pr.number}`} onClick={() => void begin()}
          >
            {phase === "reading" ? "Checking…" : phase === "merged" ? "Merged" : "Merge"}
            {!phone && phase === "idle" && !disabled && <kbd className={q.key}>m</kbd>}
          </button>
          <button
            type="button" className={`${q.b} ${q.pri} ${s.caret}`} disabled={disabled} aria-haspopup="menu" aria-expanded={menu}
            aria-label={`Merge method: ${METHODS.find((m) => m.id === method)?.label}`} title="Merge method" onClick={() => setMenu((v) => !v)}
          >
            <ChevronIcon dir="down" size={10} />
          </button>
          {menu && (
            <span className={s.menu} role="menu">
              {METHODS.map((m) => (
                <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === method} className={s.item} onClick={() => pick(m.id)}>
                  <span className={s.tick} aria-hidden>{m.id === method && <CheckIcon size={11} />}</span>{m.label}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

// The confirm text from GitHub's own facts, never the ticket's: "Squash and merge o/demo #470?"
// over "<GitHub title> · agent/x → main · a1b2c3d" (one line, cut). With the checks ask, the
// first line asks about the checks and the second names the PR.
function ConfirmText({ facts: f, verb, ask }: { facts: PrMergeFacts; verb: string; ask: string | null }) {
  const what = `${prSlug(f.url) ?? "PR"} #${f.number}`;
  const title = f.title.replace(/\s+/g, " ").trim();
  const meta = [ask ? `${verb} ${what}` : null, title || null, f.head && f.base ? `${f.head} → ${f.base}` : null, f.headSha.slice(0, 7)]
    .filter(Boolean).join(" · ");
  return (
    <span className={s.ask}>
      <b className={s.q}>{ask ? `${ask} Merge anyway?` : `${verb} ${what}?`}</b>
      <span className={s.meta} title={meta}>{meta}</span>
    </span>
  );
}

// The "more" button of a pr ticket's action bar: the actions that left the bar (Open PR on
// GitHub, I merged it). Their keys (o, a) still work and show in the rows. The menu opens
// upward; Esc, a press outside it and a pick close it.
export type MoreItem = {
  id: string; label: string; kbd?: string; title?: string; disabled?: boolean;
  link?: { href: string; target?: "_blank"; rel?: "noopener noreferrer" }; onSelect?: () => void;
};
export function MoreMenu({ items, phone }: { items: MoreItem[]; phone: boolean }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (open) firstRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (items.length === 0) return null;
  const close = (back: boolean) => { setOpen(false); if (back) btnRef.current?.focus(); };
  const row = (it: MoreItem) => (
    <>
      <span className={s.itemText}>{it.label}</span>
      {it.link?.target && <ExternalIcon size={10} />}
      {it.kbd && !phone && <kbd className={q.key}>{it.kbd}</kbd>}
    </>
  );
  return (
    <span ref={boxRef} className={s.more} onKeyDown={(e) => { if (open && e.key === "Escape") { stopEsc(e); close(true); } }}>
      <button
        ref={btnRef} type="button" className={`${q.b} ${s.moreBtn}`} aria-label="More actions" aria-haspopup="menu" aria-expanded={open}
        title="More actions" onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon size={16} />
      </button>
      {open && (
        <span className={`${s.menu} ${s.menuStart}`} role="menu">
          {items.map((it, n) => (it.link ? (
            <a
              key={it.id} ref={n === 0 ? (el) => { firstRef.current = el; } : undefined} role="menuitem" className={s.item} title={it.title}
              {...it.link} onClick={() => { it.onSelect?.(); close(false); }} onAuxClick={() => it.onSelect?.()}
            >{row(it)}</a>
          ) : (
            <button
              key={it.id} ref={n === 0 ? (el) => { firstRef.current = el; } : undefined} type="button" role="menuitem" className={s.item}
              title={it.title} disabled={it.disabled} onClick={() => { close(true); it.onSelect?.(); }}
            >{row(it)}</button>
          )))}
        </span>
      )}
    </span>
  );
}
