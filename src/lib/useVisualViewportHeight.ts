"use client";
import { useEffect } from "react";
import { MOBILE_QUERY } from "./useIsMobile";

// Keep the phone shell exactly on the *visible* viewport while the soft keyboard
// is open.
//
// `100dvh` tracks the browser toolbars but NOT the keyboard: the keyboard covers
// the bottom of the layout viewport, where the composer, the Queue reply box and
// the terminal's input line and key bar live. And iOS Safari does a second
// thing: it keeps the layout viewport at full height and pans the visible part
// down to the focused field (visualViewport.offsetTop > 0). A shell that only
// shrinks then sits at the top of the layout viewport, above the visible part:
// the screen shows the shell's bottom (the composer) at the top, then the empty
// page down to the keyboard.
//
// So on mobile we mirror two values of `window.visualViewport` into custom
// properties: `--app-vh` (its height, the space above the keyboard) and
// `--app-vv-top` (its offsetTop). The phone shell is `position: fixed` with that
// height, moved down by that offset (page.module.css), so it always covers the
// visible area. Its regions re-fit to the smaller box: the thread stays scrolled
// to its end, xterm re-fits and floats its input line above the keyboard. On
// desktop (or before mount) the properties stay unset and the shell falls back
// to `100dvh` at the top.

type ViewportState = { height: number; offsetTop: number; scale: number };

// Pure decision (unit-tested): the custom property values for a viewport state,
// or null to clear them. Only on mobile: on desktop there is no soft keyboard.
// Not while pinch-zoomed: the visible area is then a zoomed part of the page,
// and a shell that followed the pan could never be panned across.
export function appViewportVars(isMobile: boolean, vv: ViewportState): { vh: string; top: string } | null {
  if (!isMobile || !(vv.height > 0) || vv.scale > 1.01) return null;
  return { vh: `${Math.round(vv.height)}px`, top: `${Math.max(0, Math.round(vv.offsetTop))}px` };
}

export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const root = document.documentElement;

    const apply = () => {
      const vars = appViewportVars(mql.matches, vv);
      if (vars) {
        root.style.setProperty("--app-vh", vars.vh);
        root.style.setProperty("--app-vv-top", vars.top);
      } else {
        root.style.removeProperty("--app-vh");
        root.style.removeProperty("--app-vv-top");
      }
    };

    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    mql.addEventListener("change", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      mql.removeEventListener("change", apply);
      root.style.removeProperty("--app-vh");
      root.style.removeProperty("--app-vv-top");
    };
  }, []);
}
