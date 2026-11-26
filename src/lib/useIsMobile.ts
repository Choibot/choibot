"use client";
import { useLayoutEffect, useState } from "react";

export const MOBILE_QUERY = "(max-width: 768px)";

// SSR-safe: returns false on the server and the first client render (matching the
// desktop DOM so hydration doesn't mismatch), then updates before the first
// paint (a layout effect: a phone never shows a frame of the desktop shell) and
// on every viewport crossing of the 768px breakpoint.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useLayoutEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  return isMobile;
}
