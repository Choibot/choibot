// src/components/setup/SetupPage.tsx — the Set-up page of a new install: the home of the console
// until its first pull request is merged (GET /api/setup/home). Desktop: a 52 px head and the
// checklist. Phone: one screen with the back arrow to the home list.
//
// With a guide (lib/useGuide; a new install with a paired device): the guide's thread is next to
// the list on a wide page, and one tap from it on a narrow page and on the phone. Each row of
// the list keeps its form and its button. When the guide cannot answer (no Claude login, the
// plan at its limit), one plain line says so over the list, and the page is the list as before.
// A console with no guide gets the list alone.
"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { guideClosed } from "../../lib/guide";
import { headline, progress, setupRows, type SetupRow } from "../../lib/setup";
import { useGuide } from "../../lib/useGuide";
import type { SetupView } from "../../lib/useSetup";
import { PhoneHeader } from "../PhoneHeader";
import { cx as k } from "../settings/kit";
import { DISPLAY_NAME } from "../../../server/brand";
import { GuideBanner, GuidePane } from "./GuidePane";
import { SetupDone, SetupList, StepAction, type SetupNav } from "./SetupList";
import c from "./Setup.module.css";
import g from "./Guide.module.css";

// From this width of the page, the guide and the list are side by side.
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

type Show = "guide" | "list";

function Switch({ show, set, count }: { show: Show; set: (s: Show) => void; count: string }) {
  return (
    <div className={g.switch} role="group" aria-label="Guide or list">
      <button type="button" aria-pressed={show === "guide"} onClick={() => set("guide")}>Guide</button>
      <button type="button" aria-pressed={show === "list"} onClick={() => set("list")}>List · {count}</button>
    </div>
  );
}

export function SetupPage({ setup, nav, onBack }: { setup: SetupView; nav: SetupNav; onBack?: () => void }) {
  const rows = setupRows(setup.answer);
  const { done, total } = progress(rows);
  // Every required step passes: the "done" screen, then the console.
  const over = setup.answer !== null && total > 0 && done === total;
  // The guide says what is new each time the list has a new answer.
  const guide = useGuide({ on: true, mark: setup.answer?.checkedAt ?? 0 });
  const off = guide.view?.off;
  const closed = guideClosed(off);
  // The thread is on the page: this console has a guide, and it can take a message.
  const chat = guide.on && !closed;
  const [show, setShow] = useState<Show>("guide");
  const [wide, pageRef] = useWide(WIDE_PX);
  const count = `${done} of ${total}`;

  const banner = guide.on && closed && off ? <GuideBanner off={off} /> : null;
  // A card of the thread is the part of the row: the same form, the same button, the same route.
  const card = (row: SetupRow): ReactNode => <StepAction row={row} nav={nav} onDone={setup.refresh} />;
  const list = (o: { phone?: boolean; side?: boolean }) => over
    ? <SetupDone setup={setup} nav={nav} phone={o.phone} narrow={o.side} />
    : <SetupList setup={setup} nav={nav} phone={o.phone} closed={o.side} narrow={o.side} />;

  if (onBack) {
    const pill = chat
      ? <button type="button" className={`${c.pill} ${g.pillBtn}`} onClick={() => setShow(show === "guide" ? "list" : "guide")}
          aria-label={show === "guide" ? `Show the list: ${count} steps done` : "Show the guide"}>{show === "guide" ? count : "Guide"}</button>
      : <span className={c.pill}>{count}</span>;
    return (
      <div className={c.phonePage}>
        <PhoneHeader onBack={onBack} title="Set-up" sub={headline(rows)} right={pill} />
        {chat && show === "guide"
          ? <GuidePane guide={guide} rows={rows} phone card={card} />
          // The phone body of Settings: its padding and its touch sizes for buttons and fields.
          : <div className={c.phoneScroll}><div className={k.phoneBody}>{banner}{list({ phone: true })}</div></div>}
      </div>
    );
  }
  return (
    <div className={c.page} ref={pageRef}>
      <div className={c.pageHead}>
        <h1 className={c.pageTitle}>{over ? "Set-up" : `Set up ${DISPLAY_NAME}`}</h1>
        <span className={c.pageLine}>{headline(rows)}</span>
        {chat && !wide && <Switch show={show} set={setShow} count={count} />}
      </div>
      {chat ? (
        <div className={g.split} data-wide={wide}>
          {(wide || show === "guide") && <GuidePane guide={guide} rows={rows} card={card} />}
          {(wide || show === "list") && <aside className={g.side} aria-label="Set-up list"><div className={g.sideInner}>{list({ side: wide })}</div></aside>}
        </div>
      ) : (
        <div className={c.pageScroll}><div className={c.pageInner}>{banner}{list({})}</div></div>
      )}
    </div>
  );
}
