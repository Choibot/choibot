// src/components/setup/SetupPage.tsx — the Set-up page of a new install: the home of the console
// until its first pull request is merged (GET /api/setup/home). Desktop: a 52 px head and the
// stage (Stage.tsx). Phone: one screen with the back arrow to the home list.
//
// With a guide (lib/useGuide; a new install with a paired device): a "Guide" switch at the right
// of the line under the rail. The guide's thread is a column next to the stage on a wide page,
// and a sheet from the bottom on a narrow page and on the phone. It starts closed: the stage is
// the page. When the guide cannot answer (no Claude login, the plan at its limit), one plain
// line says so under the rail. A console with no guide gets the stage alone.
"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { guideClosed } from "../../lib/guide";
import { progress, setupRows } from "../../lib/setup";
import { useGuide } from "../../lib/useGuide";
import type { SetupView } from "../../lib/useSetup";
import { PhoneHeader } from "../PhoneHeader";
import { cx as k } from "../settings/kit";
import { DISPLAY_NAME } from "../../../server/brand";
import { GuideBanner, GuidePane } from "./GuidePane";
import { SetupStage } from "./Stage";
import type { SetupNav } from "./SetupList";
import c from "./Setup.module.css";
import s from "./Stage.module.css";

// From this width of the page, the guide is a column next to the stage.
const WIDE_PX = 940;

// Is the element at least `min` wide? True until it is measured (the desktop page is wide).
function useWide(min: number): [boolean, (el: HTMLElement | null) => void] {
  const [wide, setWide] = useState(true);
  const seen = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    seen.current?.disconnect();
    seen.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    seen.current = new ResizeObserver(([e]) => setWide(e.contentRect.width >= min));
    seen.current.observe(el);
  }, [min]);
  useEffect(() => () => seen.current?.disconnect(), []);
  return [wide, ref];
}

function Sheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <button type="button" className={s.scrim} aria-label="Close the guide" tabIndex={-1} onClick={onClose} />
      <div className={s.sheet} role="dialog" aria-label="Guide">
        <div className={s.sheetHead}><b>Guide</b><button type="button" className={`${k.btn} ${k.quiet}`} onClick={onClose}>Close</button></div>
        {children}
      </div>
    </>
  );
}

export function SetupPage({ setup, nav, onBack }: { setup: SetupView; nav: SetupNav; onBack?: () => void }) {
  const rows = setupRows(setup.answer);
  const { done, total } = progress(rows);
  const over = setup.answer !== null && total > 0 && done === total;
  // The guide says what is new each time the list has a new answer.
  const mark = setup.answer?.checkedAt ?? 0;
  const guide = useGuide({ on: true, mark });
  const off = guide.view?.off;
  const closed = guideClosed(off);
  // The thread is on the page: this console has a guide, and it can take a message.
  const chat = guide.on && !closed;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [wide, pageRef] = useWide(WIDE_PX);

  const banner = guide.on && closed && off ? <GuideBanner off={off} /> : null;
  const pill = chat
    ? <button type="button" className={s.pill} aria-pressed={open} onClick={() => setOpen(!open)}>Guide</button>
    : null;

  if (onBack) {
    return (
      <div className={`${c.phonePage} ${s.phonePage}`}>
        <PhoneHeader onBack={onBack} title="Set-up" />
        {/* The phone body of Settings: its padding and its touch sizes for buttons and fields. */}
        <div className={c.phoneScroll}><div className={k.phoneBody}><SetupStage setup={setup} nav={nav} phone banner={banner} /></div></div>
        {pill && <div className={s.phoneBar}>{pill}</div>}
        {chat && open && <Sheet onClose={close}><GuidePane guide={guide} rows={rows} phone /></Sheet>}
      </div>
    );
  }
  return (
    <div className={c.page} ref={pageRef}>
      <div className={c.pageHead}>
        <h1 className={c.pageTitle}>{over ? "Set-up" : `Set up ${DISPLAY_NAME}`}</h1>
      </div>
      <div className={s.body}>
        <div className={s.main}><SetupStage setup={setup} nav={nav} tools={pill} banner={banner} /></div>
        {chat && open && wide && <aside className={s.side} aria-label="Guide"><GuidePane guide={guide} rows={rows} /></aside>}
        {chat && open && !wide && <Sheet onClose={close}><GuidePane guide={guide} rows={rows} /></Sheet>}
      </div>
    </div>
  );
}
