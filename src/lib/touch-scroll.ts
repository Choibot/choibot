// src/lib/touch-scroll.ts
// Pure gesture math for the terminal's touch→wheel bridge (see wireTouchScroll
// in XtermTerminal.tsx). xterm 6 scrolls only on wheel events — it has no touch
// handling — so on mobile a finger drag is translated into synthetic WheelEvents.
// Sign convention matches the wheel: finger up (y decreases) → positive deltaY
// → content scrolls down.

// Movement below this is a tap (or soft-keyboard jitter), not a scroll.
export const TOUCH_SCROLL_SLOP_PX = 6;

// Only samples this recent count toward the release velocity — a long drag's
// early motion says nothing about how fast the finger let go.
export const FLING_SAMPLE_WINDOW_MS = 120;

export type TouchScrollState = {
  startY: number;
  lastY: number;
  dragging: boolean;
};

export type FlingSample = { t: number; y: number };

export function touchScrollStart(y: number): TouchScrollState {
  return { startY: y, lastY: y, dragging: false };
}

// Feed one touchmove. Returns the wheel deltaY to dispatch (null while still
// inside the tap slop). Crossing the slop emits the whole accumulated delta so
// the first frame of scrolling doesn't swallow those pixels.
export function touchScrollMove(
  state: TouchScrollState,
  y: number,
): { state: TouchScrollState; deltaY: number | null } {
  if (!state.dragging && Math.abs(y - state.startY) < TOUCH_SCROLL_SLOP_PX) {
    return { state, deltaY: null };
  }
  const from = state.dragging ? state.lastY : state.startY;
  return {
    state: { ...state, lastY: y, dragging: true },
    deltaY: from - y,
  };
}

// Release velocity in px/ms (wheel sign), from the samples recorded during the
// drag. 0 when the finger paused before lifting or the data is unusable.
export function flingVelocity(samples: FlingSample[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= FLING_SAMPLE_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const span = last.t - first.t;
  if (span <= 0) return 0;
  return (first.y - last.y) / span;
}
