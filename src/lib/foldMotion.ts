// src/lib/foldMotion.ts — the motion of a part that opens and closes in place (a step of the
// Set-up list, a card of the guide, a new line of the thread). Pure: no DOM, no React. The
// component (components/setup/Fold.tsx) gives the DOM calls, so the tests can drive each case.
//
// The rules:
//   - One motion per change: the height goes from what is on screen now to the new height, once.
//   - A part that waits for its data (a "Reading…" line) holds the fold shut for HOLD_MS at most,
//     so the part opens once, to its real height, and not first to one line and then again.
//   - A part that closes keeps its content until the motion ends.
//   - The content of an open part grows or shrinks (a poll, a new line): the same one motion,
//     from the old height. But no motion while a fold inside it moves (the inner one moves, this
//     one follows), while a fold around it moves, or when the width changed (a resize).
//   - Reduced motion (prefers-reduced-motion): no motion at all, the same end states at once.

export const FOLD_MS = 260;
export const FOLD_EASE = "cubic-bezier(.2, 0, 0, 1)";
// The longest wait for a part's data before the fold opens anyway.
export const HOLD_MS = 180;
// The shortest motion when the target changes in a motion.
const MIN_MS = 120;

export type FoldPhase = "open" | "closed" | "opening" | "closing" | "holding";

export type FoldDom = {
  /** The height on screen now (in a motion: where the motion is). */
  shown(): number;
  /** The height of the content. */
  content(): number;
  /** Start a motion from one height to another, in `ms`. The DOM calls `end()` when it is over. */
  move(from: number, to: number, ms: number, fade: "in" | "out" | null): void;
  /** No motion: the natural height when open, 0 when closed. */
  rest(open: boolean): void;
  /** Hold the fold at this height, with no motion. */
  clip(height: number): void;
  wait(ms: number, fn: () => void): void;
};

export type FoldEnv = {
  reduced(): boolean;
  /** A fold around this one moves now. */
  outerBusy(): boolean;
  /** This fold started (+1) or stopped (-1) a motion: the fold around it counts it. */
  tell(d: 1 | -1): void;
  now(): number;
};

export class FoldMachine {
  phase: FoldPhase;
  // The height on screen when no motion runs (-1: not measured yet).
  private last = -1;
  private width = -1;
  private target = 0;
  private started = 0;
  private held = 0;
  private holds = 0;
  private holdGen = 0;
  private kids = 0;

  constructor(open: boolean, private dom: FoldDom, private env: FoldEnv) {
    this.phase = open ? "open" : "closed";
  }

  get moving(): boolean { return this.phase === "opening" || this.phase === "closing"; }

  /** The user or the data opens or closes the part. */
  toggle(open: boolean): void {
    if (open) {
      if (this.phase === "open" || this.phase === "opening" || this.phase === "holding") return;
      if (this.holds > 0 && !this.env.reduced()) { this.hold(); return; }
      this.go(true);
    } else {
      if (this.phase === "closed" || this.phase === "closing") return;
      this.go(false);
    }
  }

  /** A part in this fold waits for its data. True: this fold holds; false: ask the fold around it. */
  takesHold(): boolean { return this.phase === "closed" || this.phase === "holding"; }
  addHold(): void { this.holds++; }
  /** The data of a part is there (or the part is gone). */
  release(): void {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds === 0 && this.phase === "holding") this.go(true);
  }

  /** The content has a new size (a ResizeObserver). */
  resize(height: number, width: number): void {
    const widthChanged = this.width >= 0 && Math.abs(width - this.width) >= 1;
    this.width = width;
    if (this.phase === "closed" || this.phase === "closing" || this.phase === "holding") return;
    if (this.phase === "opening") {
      // A fold inside moves: this one waits for its end (childMove), not one new motion per frame.
      if (this.kids > 0 || Math.abs(height - this.target) < 1) return;
      this.retarget(height);
      return;
    }
    if (this.last < 0 || Math.abs(height - this.last) < 1) { this.last = height; return; }
    if (widthChanged || this.kids > 0 || this.env.outerBusy() || this.env.reduced()) { this.last = height; return; }
    const from = this.last;
    this.last = height;
    this.start("opening", from, height, FOLD_MS, null);
  }

  /** A fold inside this one started (+1) or ended (-1) a motion. */
  childMove(d: 1 | -1): void {
    this.kids = Math.max(0, this.kids + d);
    if (this.kids > 0) return;
    if (this.phase === "opening") { const h = this.dom.content(); if (Math.abs(h - this.target) >= 1) this.retarget(h); }
    else if (this.phase === "open") this.last = this.dom.content();
  }

  /** The DOM says the motion is over. */
  end(): void {
    if (this.phase === "opening") this.settle(true);
    else if (this.phase === "closing") this.settle(false);
  }

  /** The part is gone (unmount): a motion that runs ends for the fold around it too. */
  dispose(): void {
    if (this.moving) this.env.tell(-1);
    this.holdGen++;
    this.phase = "closed";
  }

  private from(): number {
    if (this.moving) return this.dom.shown();
    if (this.phase === "holding") return this.held;
    if (this.phase === "closed") return 0;
    return Math.max(0, this.last);
  }

  private hold(): void {
    this.held = this.from();
    const wasMoving = this.moving;
    this.phase = "holding";
    if (wasMoving) this.env.tell(-1);
    this.dom.clip(this.held);
    const gen = ++this.holdGen;
    this.dom.wait(HOLD_MS, () => { if (gen === this.holdGen && this.phase === "holding") this.go(true); });
  }

  private go(open: boolean): void {
    const from = this.from();
    const to = open ? this.dom.content() : 0;
    this.holdGen++;
    if (this.env.reduced() || Math.abs(to - from) < 1) { this.settle(open); return; }
    this.start(open ? "opening" : "closing", from, to, FOLD_MS, open ? "in" : "out");
  }

  private retarget(height: number): void {
    const left = Math.max(MIN_MS, FOLD_MS - (this.env.now() - this.started));
    this.start("opening", this.dom.shown(), height, left, null);
  }

  private start(phase: "opening" | "closing", from: number, to: number, ms: number, fade: "in" | "out" | null): void {
    const wasMoving = this.moving;
    this.phase = phase;
    this.target = to;
    this.started = this.env.now();
    if (!wasMoving) this.env.tell(1);
    this.dom.move(from, to, ms, fade);
  }

  private settle(open: boolean): void {
    const wasMoving = this.moving;
    this.phase = open ? "open" : "closed";
    this.dom.rest(open);
    this.last = open ? this.dom.content() : 0;
    if (wasMoving) this.env.tell(-1);
  }
}
