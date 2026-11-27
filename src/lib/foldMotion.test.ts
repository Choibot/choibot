// src/lib/foldMotion.test.ts — one motion per change, a part that waits holds the fold shut,
// reduced motion gives the end state at once, and nested folds do not both move.
import { describe, expect, it } from "vitest";
import { FOLD_MS, FoldMachine, HOLD_MS, type FoldDom } from "./foldMotion";

type Call = { op: string; from?: number; to?: number; ms?: number; fade?: string | null; open?: boolean; h?: number };

function rig(o: { open?: boolean; content?: number; reduced?: boolean; outerBusy?: boolean } = {}) {
  const calls: Call[] = [];
  const told: number[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const s = { content: o.content ?? 200, shown: 0, now: 0, reduced: o.reduced ?? false, outerBusy: o.outerBusy ?? false };
  const dom: FoldDom = {
    shown: () => s.shown,
    content: () => s.content,
    move: (from, to, ms, fade) => { calls.push({ op: "move", from, to, ms, fade }); s.shown = from; },
    rest: (open) => { calls.push({ op: "rest", open }); },
    clip: (h) => { calls.push({ op: "clip", h }); },
    wait: (ms, fn) => { timers.push({ at: s.now + ms, fn }); },
  };
  const m = new FoldMachine(o.open ?? false, dom, {
    reduced: () => s.reduced, outerBusy: () => s.outerBusy, tell: (d) => told.push(d), now: () => s.now,
  });
  const tick = (ms: number) => { s.now += ms; for (const t of timers.splice(0)) { if (t.at <= s.now) t.fn(); else timers.push(t); } };
  return { m, s, calls, told, tick, moves: () => calls.filter((c) => c.op === "move") };
}

describe("FoldMachine", () => {
  it("opens in one motion from 0 to the height of the content, with a fade in", () => {
    const r = rig({ content: 240 });
    r.m.toggle(true);
    expect(r.moves()).toEqual([{ op: "move", from: 0, to: 240, ms: FOLD_MS, fade: "in" }]);
    expect(r.m.phase).toBe("opening");
    r.m.end();
    expect(r.m.phase).toBe("open");
    expect(r.calls.at(-1)).toEqual({ op: "rest", open: true });
    expect(r.told).toEqual([1, -1]);
  });

  it("closes in one motion and keeps the content until the motion ends", () => {
    const r = rig({ open: true, content: 240 });
    r.m.resize(240, 600); // the first measure: no motion
    r.m.toggle(false);
    expect(r.moves()).toEqual([{ op: "move", from: 240, to: 0, ms: FOLD_MS, fade: "out" }]);
    // No "rest closed" (the part that removes the content) before the end of the motion.
    expect(r.calls.some((c) => c.op === "rest")).toBe(false);
    r.m.end();
    expect(r.calls.at(-1)).toEqual({ op: "rest", open: false });
    expect(r.m.phase).toBe("closed");
  });

  it("reduced motion: no motion, the end state at once", () => {
    const r = rig({ content: 240, reduced: true });
    r.m.toggle(true);
    expect(r.moves()).toEqual([]);
    expect(r.calls).toEqual([{ op: "rest", open: true }]);
    r.m.resize(240, 600);
    r.m.resize(300, 600); // the content grows: it follows at once
    r.m.toggle(false);
    expect(r.moves()).toEqual([]);
    expect(r.calls.at(-1)).toEqual({ op: "rest", open: false });
    expect(r.told).toEqual([]);
  });

  it("a part that waits for its data holds the fold shut, then the fold opens once to the real height", () => {
    const r = rig({ content: 22 }); // only the "Reading…" line
    r.m.addHold();
    r.m.toggle(true);
    expect(r.m.phase).toBe("holding");
    expect(r.calls).toEqual([{ op: "clip", h: 0 }]);
    r.s.content = 320; // the data is there
    r.m.release();
    expect(r.moves()).toEqual([{ op: "move", from: 0, to: 320, ms: FOLD_MS, fade: "in" }]);
    r.tick(HOLD_MS + 1); // the old timer does nothing
    expect(r.moves()).toHaveLength(1);
  });

  it("a wait that lasts opens the fold after HOLD_MS; the data that comes later moves the same motion on", () => {
    const r = rig({ content: 22 });
    r.m.addHold();
    r.m.toggle(true);
    r.tick(HOLD_MS - 1);
    expect(r.moves()).toHaveLength(0);
    r.tick(1);
    expect(r.moves()).toEqual([{ op: "move", from: 0, to: 22, ms: FOLD_MS, fade: "in" }]);
    r.s.shown = 15; r.s.now += 100;
    r.m.resize(320, 600);
    expect(r.moves()[1]).toEqual({ op: "move", from: 15, to: 320, ms: FOLD_MS - 100, fade: null });
    expect(r.told).toEqual([1]); // one motion for the fold around it, not two
  });

  it("an open part that grows moves from the old height, once", () => {
    const r = rig({ open: true });
    r.m.resize(200, 600);
    r.s.content = 260;
    r.m.resize(260, 600);
    expect(r.moves()).toEqual([{ op: "move", from: 200, to: 260, ms: FOLD_MS, fade: null }]);
    r.m.end();
    r.m.resize(260, 600); // the same height again (a poll with the same state): nothing
    expect(r.moves()).toHaveLength(1);
  });

  it("no motion of its own while a fold inside moves or a fold around it moves, or after a change of width", () => {
    const r = rig({ open: true });
    r.m.resize(200, 600);
    r.m.childMove(1);
    r.m.resize(150, 600);
    r.m.resize(100, 600);
    r.m.childMove(-1);
    r.s.outerBusy = true;
    r.m.resize(140, 600);
    r.s.outerBusy = false;
    r.m.resize(180, 400); // the page is narrower
    expect(r.moves()).toEqual([]);
    r.m.resize(220, 400);
    expect(r.moves()).toEqual([{ op: "move", from: 180, to: 220, ms: FOLD_MS, fade: null }]);
  });

  it("a close in the middle of the opening turns back from the height on screen", () => {
    const r = rig({ content: 300 });
    r.m.toggle(true);
    r.s.shown = 120;
    r.m.toggle(false);
    expect(r.moves()[1]).toEqual({ op: "move", from: 120, to: 0, ms: FOLD_MS, fade: "out" });
    expect(r.told).toEqual([1]);
    r.s.shown = 60;
    r.m.toggle(true); // and back again: from 60, the fade goes back in
    expect(r.moves()[2]).toEqual({ op: "move", from: 60, to: 300, ms: FOLD_MS, fade: "in" });
    r.m.end();
    expect(r.told).toEqual([1, -1]);
  });

  it("only a closed or a holding fold takes a hold (an open one leaves it to the fold around it)", () => {
    expect(rig().m.takesHold()).toBe(true);
    expect(rig({ open: true }).m.takesHold()).toBe(false);
  });

  it("a fold that goes away in a motion ends that motion for the fold around it", () => {
    const r = rig({ content: 300 });
    r.m.toggle(true);
    r.m.dispose();
    expect(r.told).toEqual([1, -1]);
  });
});
