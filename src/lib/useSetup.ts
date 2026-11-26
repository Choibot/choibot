// src/lib/useSetup.ts — the step list for a view (the Set-up page, the Set-up row of Settings):
// the last answer at once (lib/viewCache), a new one when the view opens, when the tab comes
// back, on "Check again", and on a slow tick while `pollMs` is given.
"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchSetup, fetchSetupHome, readHomeHint, writeHomeHint, type SetupAnswer } from "./setup";
import { useRemembered, viewMemory } from "./viewCache";

const seen = viewMemory<SetupAnswer | null>(1);

export type SetupView = {
  answer: SetupAnswer | null;
  // A read is in progress (the "Check again" button waits).
  checking: boolean;
  // The last read got no answer.
  failed: boolean;
  refresh: () => Promise<void>;
};

export function useSetup(o: { on: boolean; pollMs?: number }): SetupView {
  const [answer, setAnswer] = useRemembered<SetupAnswer | null>(seen, "setup", null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const next = await fetchSetup();
      setAnswer(next);
      if (live.current) setFailed(false);
    } catch {
      if (live.current) setFailed(true);
    } finally {
      if (live.current) setChecking(false);
    }
  }, [setAnswer]);
  const { on, pollMs } = o;
  useEffect(() => {
    if (!on) return;
    void refresh();
    const shown = () => document.visibilityState === "visible";
    const onShow = () => { if (shown()) void refresh(); };
    document.addEventListener("visibilitychange", onShow);
    const tick = pollMs ? setInterval(() => { if (shown()) void refresh(); }, pollMs) : null;
    return () => { document.removeEventListener("visibilitychange", onShow); if (tick) clearInterval(tick); };
  }, [on, pollMs, refresh]);
  return { answer, checking, failed, refresh };
}

// Is the Set-up page the home of this console (a new install, until its first merged pull
// request)? `home` is false until the server says so, so a console of today never shows it. The hint of
// the last load is read before the first paint.
export function useSetupHome(): { home: boolean; leave: () => void } {
  const [home, setHome] = useState(false);
  // The user leaves the "done" screen for the console. The server gives the same answer on the
  // next load: after the first merged pull request, the Set-up page is not the home.
  const leave = useCallback(() => { writeHomeHint(false); setHome(false); }, []);
  useLayoutEffect(() => { if (readHomeHint()) setHome(true); }, []);
  useEffect(() => {
    let on = true;
    void fetchSetupHome().then((h) => {
      if (h === null) return;
      writeHomeHint(h);
      if (on) setHome(h);
    });
    return () => { on = false; };
  }, []);
  return { home, leave };
}
