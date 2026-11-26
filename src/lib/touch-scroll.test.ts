import { describe, it, expect } from "vitest";
import {
  touchScrollStart,
  touchScrollMove,
  flingVelocity,
  TOUCH_SCROLL_SLOP_PX,
  FLING_SAMPLE_WINDOW_MS,
} from "./touch-scroll";

describe("touchScrollMove", () => {
  it("emits nothing while the finger stays inside the tap slop", () => {
    const st = touchScrollStart(100);
    const r = touchScrollMove(st, 100 - (TOUCH_SCROLL_SLOP_PX - 1));
    expect(r.deltaY).toBeNull();
  });

  it("emits the full accumulated delta once the slop is crossed (no lost motion)", () => {
    const st = touchScrollStart(100);
    const r = touchScrollMove(st, 88); // 12px up, past the slop
    expect(r.deltaY).toBe(12); // finger up → positive deltaY → scroll down
  });

  it("emits incremental deltas after the drag has started", () => {
    let st = touchScrollStart(100);
    const first = touchScrollMove(st, 80);
    st = first.state;
    const second = touchScrollMove(st, 70);
    expect(second.deltaY).toBe(10);
  });

  it("dragging the finger down scrolls up (negative deltaY) — the bug's gesture", () => {
    const st = touchScrollStart(100);
    const r = touchScrollMove(st, 140);
    expect(r.deltaY).toBe(-40);
  });

  it("stays in dragging mode even when a later move returns near the origin", () => {
    let st = touchScrollStart(100);
    st = touchScrollMove(st, 80).state;
    const back = touchScrollMove(st, 99); // within slop of origin, but drag already live
    expect(back.deltaY).toBe(-19);
  });
});

describe("flingVelocity", () => {
  it("returns px/ms velocity from recent samples (finger up → positive)", () => {
    const v = flingVelocity(
      [
        { t: 1000, y: 300 },
        { t: 1050, y: 250 },
        { t: 1100, y: 200 },
      ],
      1100,
    );
    expect(v).toBeCloseTo(1); // 100px in 100ms
  });

  it("ignores samples older than the sampling window (stale start of a long drag)", () => {
    const v = flingVelocity(
      [
        { t: 0, y: 900 }, // stale — must not skew the velocity
        { t: 1000 - 40, y: 240 },
        { t: 1000, y: 200 },
      ],
      1000,
    );
    expect(v).toBeCloseTo(1);
  });

  it("returns 0 when the gesture ended with a hold (last sample old)", () => {
    const v = flingVelocity(
      [
        { t: 0, y: 300 },
        { t: 50, y: 200 },
      ],
      50 + FLING_SAMPLE_WINDOW_MS + 1,
    );
    expect(v).toBe(0);
  });

  it("returns 0 with fewer than two usable samples or a zero time span", () => {
    expect(flingVelocity([{ t: 100, y: 50 }], 100)).toBe(0);
    expect(
      flingVelocity(
        [
          { t: 100, y: 50 },
          { t: 100, y: 40 },
        ],
        100,
      ),
    ).toBe(0);
  });
});
