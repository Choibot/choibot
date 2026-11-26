// src/lib/prAutoCheck.ts — when a pr ticket is checked with no press (overview decision 64).
// The user merges a PR on github.com in another tab or window and comes back: the console then
// asks the server once "is it merged?" (the `checkPr` path of lib/useQueueRun), so the ticket
// closes in about a second and not at the server's next poll. Checked on a return:
//   - the pr ticket selected in the Queue view (each view that has one gives it, `selected`);
//   - every pr ticket whose "Open PR #n" the user pressed in this page (`opened`), for 30 minutes.
// Cheap by rule: at most one check per ticket in 15 seconds (a press of "I merged it" counts),
// and never in a hidden tab. A return inside the 15 seconds is not lost: its check runs when they
// end, if the tab is still visible. No React and no DOM here: `bindPrAutoCheck` connects the one
// page instance to the window.

export const AUTO_CHECK_GAP_MS = 15_000;
export const OPENED_FOR_MS = 30 * 60_000;

// A view that can check a ticket. `check` starts the check and gives true, or gives false when
// the view cannot (the ticket is not an open pr ticket any more, the device is read-only).
export type CheckSource = { selected?: () => string | null; check(id: string): boolean };

export type AutoCheckEnv = {
  now(): number;
  visible(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  gapMs?: number; openedForMs?: number;
};

export class PrAutoCheck {
  private readonly last = new Map<string, number>(); // ticket id -> when its last check started
  private readonly later = new Set<string>(); // tickets with a check that waits for the gap to end
  private readonly openedAt = new Map<string, number>(); // ticket id -> when "Open PR" was pressed
  private readonly sources = new Set<CheckSource>();
  private away = false; // the user left the page (another tab, another window) and is not back yet
  private readonly gap: number;
  private readonly openedFor: number;

  constructor(private readonly env: AutoCheckEnv) {
    this.gap = env.gapMs ?? AUTO_CHECK_GAP_MS;
    this.openedFor = env.openedForMs ?? OPENED_FOR_MS;
  }

  add(source: CheckSource): () => void {
    this.sources.add(source);
    return () => { this.sources.delete(source); };
  }

  // A check of this ticket starts now by a press: the gap counts from here.
  stamp(id: string): void { this.last.set(id, this.env.now()); }

  // The user pressed "Open PR #n" (or `o`) on this ticket: the merge is made there, so the
  // ticket is checked when the user comes back. No check at the press itself: the PR cannot be
  // merged yet, and that check would use the 15 seconds in which the user merges.
  opened(id: string): void { this.openedAt.set(id, this.env.now()); }

  // The window lost focus or the tab was hidden.
  left(): void { this.away = true; }

  // The window has focus again or the tab is visible again. A return makes both events: the
  // first one takes it. Nothing while the tab is hidden.
  returned(): void {
    if (!this.away || !this.env.visible()) return;
    this.away = false;
    const t = this.env.now();
    const ids = new Set<string>();
    for (const s of this.sources) { const id = s.selected?.(); if (id) ids.add(id); }
    for (const [id, at] of this.openedAt) {
      if (t - at > this.openedFor) this.openedAt.delete(id); else ids.add(id);
    }
    for (const id of ids) this.request(id);
  }

  private request(id: string): void {
    const wait = (this.last.get(id) ?? -Infinity) + this.gap - this.env.now();
    if (wait <= 0) { this.run(id); return; }
    if (this.later.has(id)) return;
    this.later.add(id);
    this.env.setTimer(() => {
      this.later.delete(id);
      if (this.env.visible()) this.run(id);
    }, wait);
  }

  private run(id: string): void {
    for (const s of this.sources) {
      if (!s.check(id)) continue;
      this.last.set(id, this.env.now());
      return;
    }
    // No view can check it: the ticket is closed (or the device is read-only). Forget it.
    this.openedAt.delete(id);
    this.last.delete(id);
  }
}

// The page's one instance.
export const prAutoCheck = new PrAutoCheck({
  now: () => Date.now(),
  visible: () => typeof document !== "undefined" && document.visibilityState === "visible",
  setTimer: (fn, ms) => setTimeout(fn, ms),
});

type Target = { addEventListener(type: string, fn: () => void): void };
let bound = false;
// Connects the instance to the window, once for the page. Tests give their own targets.
export function bindPrAutoCheck(
  auto: Pick<PrAutoCheck, "left" | "returned"> = prAutoCheck,
  win: Target | undefined = typeof window === "undefined" ? undefined : window,
  doc: (Target & { visibilityState: string }) | undefined = typeof document === "undefined" ? undefined : document,
): void {
  if (!win || !doc) return;
  if (auto === prAutoCheck) { if (bound) return; bound = true; }
  win.addEventListener("blur", () => auto.left());
  win.addEventListener("focus", () => auto.returned());
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") auto.left(); else auto.returned(); });
}
