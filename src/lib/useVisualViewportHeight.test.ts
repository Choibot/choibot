import { describe, it, expect } from "vitest";
import { appViewportVars } from "./useVisualViewportHeight";

const vv = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale });

describe("appViewportVars", () => {
  it("mirrors the visible viewport height on mobile (keyboard shrinks the shell)", () => {
    expect(appViewportVars(true, vv(508))).toEqual({ vh: "508px", top: "0px" });
    expect(appViewportVars(true, vv(844))).toEqual({ vh: "844px", top: "0px" }); // keyboard closed
  });

  it("follows the visible area when iOS pans the page to show the focused field", () => {
    // iOS keeps the layout viewport at full height and moves the visible part down to the box:
    // the shell must move with it, or its bottom (the composer) shows at the top of the screen
    // with the empty page below it.
    expect(appViewportVars(true, vv(508, 336))).toEqual({ vh: "508px", top: "336px" });
  });

  it("rounds sub-pixel values and never goes above the page top", () => {
    expect(appViewportVars(true, vv(507.6, 335.6))).toEqual({ vh: "508px", top: "336px" });
    expect(appViewportVars(true, vv(508, -4))).toEqual({ vh: "508px", top: "0px" }); // rubber-band overshoot
  });

  it("clears the overrides on desktop so the shell falls back to 100dvh at the top", () => {
    expect(appViewportVars(false, vv(508, 336))).toBeNull();
  });

  it("clears the overrides for a zero/absent viewport height", () => {
    expect(appViewportVars(true, vv(0))).toBeNull();
  });

  it("clears the overrides while the page is pinch-zoomed (the shell must not follow the pan)", () => {
    expect(appViewportVars(true, vv(422, 120, 2))).toBeNull();
  });
});
