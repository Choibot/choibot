// src/components/setup/Fold.tsx — a part that opens and closes in place, in one motion of its
// height (lib/foldMotion.ts has the rules). Used by the Set-up list (the open step), the guide's
// cards and the new lines of the guide's thread.
//
// <Fold open> draws two boxes: the frame (it clips while it moves) and in it the part with the
// given class. Closed, the part is not in the page. A part that closes stays in the page with
// its last content until the motion ends.
//
// <Pending> is a "Reading…" line: the same <p> and the same words, and while it is there the
// fold that opens holds shut (HOLD_MS at most), so the part opens once, to its real height. Its
// words show only after a short delay (CSS), so a fast read never shows them.
"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { FOLD_EASE, FoldMachine, type FoldDom } from "../../lib/foldMotion";
import c from "./Setup.module.css";

type Link = { busy(): boolean; childMove(d: 1 | -1): void; hold(): () => void };
const FoldCtx = createContext<Link | null>(null);

const reduced = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const noop = () => {};

export function Fold({ open, appear = false, frame, className, children, ...rest }: {
  open: boolean;
  /** Open at the first render too: the part comes in with the motion (a new line of the thread). */
  appear?: boolean;
  /** The class of the frame (the clip box). */
  frame?: string;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const parent = useContext(FoldCtx);
  const parentRef = useRef(parent);
  parentRef.current = parent;
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);
  const height = useRef<Animation | null>(null);
  const fade = useRef<Animation | null>(null);

  // The part is in the page while it is open or closes. Opened: in the page in this same render.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  // The last content of the open part: a part that closes keeps it until the motion ends.
  const kept = useRef<ReactNode>(children);
  if (open) kept.current = children;

  const machine = useRef<FoldMachine | null>(null);
  if (machine.current === null) {
    const stop = (a: { current: Animation | null }) => { a.current?.cancel(); a.current = null; };
    const dom: FoldDom = {
      shown: () => outer.current?.getBoundingClientRect().height ?? 0,
      content: () => inner.current?.getBoundingClientRect().height ?? 0,
      move: (from, to, ms, kind) => {
        const el = outer.current;
        if (!el) return;
        stop(height);
        el.style.overflow = "hidden";
        el.style.height = `${to}px`;
        if (typeof el.animate !== "function") { machine.current?.end(); return; }
        const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: ms, easing: FOLD_EASE });
        height.current = a;
        a.onfinish = () => { if (height.current === a) { height.current = null; machine.current?.end(); } };
        const part = inner.current;
        if (kind && part) {
          // From the opacity on screen (a turn back in the middle), or from 0 for a part that comes in.
          const now = kind === "in" && from < 1 ? 0 : Number(getComputedStyle(part).opacity) || 0;
          stop(fade);
          fade.current = part.animate([{ opacity: now }, { opacity: kind === "in" ? 1 : 0 }], { duration: ms, easing: FOLD_EASE, fill: "forwards" });
        }
      },
      rest: (isOpen) => {
        stop(height);
        stop(fade);
        const el = outer.current;
        if (el) { el.style.height = isOpen ? "" : "0px"; el.style.overflow = isOpen ? "" : "hidden"; }
        if (!isOpen && alive.current) setMounted(false);
      },
      clip: (h) => {
        stop(height);
        const el = outer.current;
        if (el) { el.style.overflow = "hidden"; el.style.height = `${h}px`; }
      },
      wait: (ms, fn) => { setTimeout(fn, ms); },
    };
    machine.current = new FoldMachine(open && !appear, dom, {
      reduced,
      outerBusy: () => parentRef.current?.busy() ?? false,
      tell: (d) => parentRef.current?.childMove(d),
      now: () => performance.now(),
    });
  }

  // Open or close. The first render is the end state, unless the part comes in (`appear`).
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; if (!(appear && open)) return; }
    machine.current?.toggle(open);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Gone from the page (not the test unmount of React's strict mode, which mounts again at once).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => { if (!alive.current) machine.current?.dispose(); });
    };
  }, []);

  // The part's size: an open part that grows or shrinks moves once from the old height.
  const seen = useRef<ResizeObserver | null>(null);
  const innerRef = useCallback((el: HTMLDivElement | null) => {
    seen.current?.disconnect();
    seen.current = null;
    inner.current = el;
    if (!el || typeof ResizeObserver === "undefined") return;
    seen.current = new ResizeObserver(([e]) => machine.current?.resize(el.getBoundingClientRect().height, e.contentRect.width));
    seen.current.observe(el);
  }, []);

  const link = useMemo<Link>(() => ({
    busy: () => (machine.current?.moving ?? false) || (parentRef.current?.busy() ?? false),
    childMove: (d) => machine.current?.childMove(d),
    hold: () => {
      const m = machine.current;
      if (!m || !m.takesHold()) return parentRef.current?.hold() ?? noop;
      m.addHold();
      let done = false;
      // Later than the commit: a "Reading…" line that gives its place to the next one in the same
      // render (the ticket after the pull request) keeps the fold shut.
      return () => { if (done) return; done = true; queueMicrotask(() => m.release()); };
    },
  }), []);

  return (
    <div ref={outer} className={frame} data-fold="">
      {mounted && (
        <FoldCtx.Provider value={link}>
          <div ref={innerRef} className={className} {...rest}>{open ? children : kept.current}</div>
        </FoldCtx.Provider>
      )}
    </div>
  );
}

/** A "Reading…" line in a fold: the same words, and the fold that opens waits for the data. */
export function Pending({ className, children }: { className?: string; children: ReactNode }) {
  const link = useContext(FoldCtx);
  useLayoutEffect(() => link?.hold(), [link]);
  return <p className={className ? `${className} ${c.pending}` : c.pending}>{children}</p>;
}

/** The quiet "More: …" switch of a closed fold: help that the stage does not show at first. */
export function MoreToggle({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={c.moreBtn} aria-expanded={open} onClick={onToggle}>
      More: {label}<span className={c.moreChev} data-open={open ? "" : undefined} aria-hidden>▸</span>
    </button>
  );
}

/** "More: …" on its own line, and the help in a fold under it. Closed at first. */
export function More({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={c.moreLine}><MoreToggle label={label} open={open} onToggle={() => setOpen(!open)} /></div>
      <Fold open={open} frame={c.moreFrame} className={c.moreBody}>{children}</Fold>
    </>
  );
}
