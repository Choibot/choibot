import { describe, expect, it } from "vitest";
import type { UpdateRun } from "../../server/chief/deploy/ticket";
import {
  AWAY_AFTER, PRESS_ANSWER_MS, PRESS_KEY, PRESS_MAX_MS, createUpdateTracker, endedPressTicket, pickRun, progressOf,
  type Link, type Press, type Progress,
} from "./updateProgress";

const T = 1_700_000_000_000;
const run = (state: UpdateRun["state"], extra: Partial<UpdateRun> = {}): UpdateRun => ({ state, via: "tab", askedAt: T + 100, from: 848, to: 849, ...extra });
const press = (extra: Partial<Press> = {}): Press => ({ item: "q1", from: 848, to: 849, at: T, askedAt: T + 100, furthest: 0, ended: false, peeked: false, ...extra });
const up = (running: number, result: string | null, step: string | null = null, extra: Partial<Extract<Link, { t: "up" }>> = {}): Link =>
  ({ t: "up", running, result, step, installed: result === "updated" ? running : 848, run: null, ...extra });
const NONE: Link = { t: "none" };

// "Downloading>" marks the present step, "+" a done one, "-" one to come.
function words(p: Progress): string {
  if (p.t === "going") return p.steps.map((s) => (s.state === "done" ? `+${s.word}` : s.state === "now" ? `${s.word}>` : `-${s.word}`)).join(" ");
  if (p.t === "done") return `done ${p.version}`;
  if (p.t === "failed") return `failed: ${p.line}${p.next ? ` | ${p.next}` : ""}${p.again ? " [again]" : ""}`;
  return "idle";
}
const at = (x: Parameters<typeof progressOf>[0]) => words(progressOf(x).p);

describe("progressOf: the steps from the ticket's run, the page's press and the poll", () => {
  it("shows nothing with no press and no run", () => {
    expect(at({ run: null, press: null, link: NONE, now: T })).toBe("idle");
  });

  it("the press shows the first step at once, before the server answers", () => {
    expect(at({ run: null, press: press({ askedAt: null }), link: NONE, now: T + 50 })).toBe("Downloading> -Installing -Restarting -Checking");
  });

  it("follows root's steps: download, then stage (Installing)", () => {
    const p = press();
    expect(at({ run: run("asked"), press: p, link: NONE, now: T + 1_000 })).toBe("Downloading> -Installing -Restarting -Checking");
    expect(at({ run: run("running", { step: "download" }), press: p, link: NONE, now: T + 2_000 })).toBe("Downloading> -Installing -Restarting -Checking");
    expect(at({ run: run("running", { step: "stage" }), press: p, link: NONE, now: T + 3_000 })).toBe("+Downloading Installing> -Restarting -Checking");
    // The poll sees root's stage before the ticket does.
    expect(at({ run: run("running", { step: "download" }), press: p, link: up(848, "running", "stage"), now: T + 3_000 })).toBe("+Downloading Installing> -Restarting -Checking");
  });

  it("the console away after the install began: Restarting; it answers on the new version: Checking; root's end: done", () => {
    const p = press({ furthest: 1 });
    expect(at({ run: run("running", { step: "stage" }), press: p, link: { t: "away" }, now: T + 9_000 })).toBe("+Downloading +Installing Restarting> -Checking");
    expect(at({ run: run("running", { step: "stage" }), press: p, link: up(849, "running", "stage"), now: T + 20_000 })).toBe("+Downloading +Installing +Restarting Checking>");
    expect(at({ run: run("running", { step: "stage" }), press: p, link: up(849, "updated"), now: T + 25_000 })).toBe("done 849");
    expect(at({ run: run("updated"), press: p, link: NONE, now: T + 26_000 })).toBe("done 849");
  });

  it("the console away before the install: the present step stays (one lost answer is not a restart)", () => {
    expect(at({ run: run("running", { step: "download" }), press: press(), link: { t: "away" }, now: T + 5_000 })).toBe("Downloading> -Installing -Restarting -Checking");
  });

  it("the steps never go back: the press keeps the furthest step", () => {
    const r = progressOf({ run: run("running", { step: "stage" }), press: press({ furthest: 2 }), link: up(848, "running", "stage"), now: T + 30_000 });
    expect(words(r.p)).toBe("+Downloading +Installing Restarting> -Checking");
    expect(r.furthest).toBe(2);
  });

  it("a failure: the console's own sentence and what the user can do, in the same place", () => {
    expect(at({ run: run("failed-back", { step: "health" }), closed: "update-failed", press: press(), link: NONE, now: T + 60_000 }))
      .toBe("failed: Failed at the health check. Back on version 848. Nothing lost. | The next release comes as a new ticket.");
    expect(at({ run: run("unreachable"), press: press(), link: NONE, now: T + 60_000 })).toBe("failed: The release could not be downloaded. Nothing changed. [again]");
    expect(at({ run: run("refused", { step: "download" }), press: press(), link: NONE, now: T + 60_000 })).toMatch(/^failed: Update refused at .*Nothing changed\. \[again\]$/);
    expect(at({ run: run("failed-stuck", { step: "start" }), press: press(), link: NONE, now: T + 60_000 })).toBe("failed: Update failed. The console needs help.");
  });

  it("the poll's run ends the press while the stream is still away (the ticket closed during the restart)", () => {
    const link = up(848, "failed-back", "health", { run: run("failed-back", { step: "health" }) });
    expect(at({ run: run("running", { step: "stage" }), press: press({ furthest: 2 }), link, now: T + 60_000 })).toMatch(/^failed: Failed at the health check/);
  });

  it("an end of an older press never shows for a new press", () => {
    const old = run("failed-back", { askedAt: T - 3_600_000, step: "health" });
    // Before the POST answers, and after it (the stream has not brought the new run yet).
    expect(at({ run: old, press: press({ askedAt: null }), link: NONE, now: T + 100 })).toBe("Downloading> -Installing -Restarting -Checking");
    expect(at({ run: old, press: press(), link: up(848, "failed-back", "health", { run: old }), now: T + 500 })).toBe("Downloading> -Installing -Restarting -Checking");
  });

  it("on a ticket's panel, the poll's run of another release does not count", () => {
    const other = run("updated", { askedAt: T + 100, from: 847, to: 848 });
    expect(at({ run: undefined, press: null, link: up(848, "updated", null, { run: other }), now: T, to: 849 })).toBe("idle");
    expect(at({ run: undefined, press: null, link: up(848, "updated", null, { run: other }), now: T })).toBe("done 848");
  });

  it("a press that the server never answered, or a very old one, is over", () => {
    expect(at({ run: null, press: press({ askedAt: null }), link: NONE, now: T + PRESS_ANSWER_MS + 1 })).toBe("idle");
    expect(at({ run: null, press: press(), link: NONE, now: T + PRESS_MAX_MS + 1 })).toBe("idle");
  });

  it("a press whose end showed already shows nothing more by itself", () => {
    expect(at({ run: null, press: press({ ended: true }), link: NONE, now: T + 5_000 })).toBe("idle");
  });

  it("another device's press shows the same steps (the ticket's run, no press on this page)", () => {
    expect(at({ run: run("running", { step: "stage" }), press: null, link: NONE, now: T })).toBe("+Downloading Installing> -Restarting -Checking");
  });

  it("pickRun: the later press, then the end, then the further step", () => {
    expect(pickRun(run("updated", { askedAt: 1 }), run("asked", { askedAt: 2 }))?.state).toBe("asked");
    expect(pickRun(run("running"), run("updated"))?.state).toBe("updated");
    expect(pickRun(run("running", { step: "download" }), run("running", { step: "stage" }))?.step).toBe("stage");
    expect(pickRun(null, undefined)).toBeNull();
  });
});

// ---- the tracker: the page's memory of its press, and the poll ----

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}
type Answer = { status: number; body?: unknown } | "down";
function fakeApi(answers: Answer[]) {
  const calls: string[] = [];
  const fetch = (async (input: string) => {
    calls.push(input);
    const a = answers.shift() ?? "down";
    if (a === "down") throw new TypeError("fetch failed");
    return new Response(a.body === undefined ? "<html>bad gateway</html>" : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const deploy = (running: number, result: string | null, step: string | null, pressRun: UpdateRun | null, installed = 848) =>
  ({ status: 200, body: { armed: true, update: { on: true, running, checkedAt: null, result, tried: 849, installed, step }, press: pressRun } });
function tracker(answers: Answer[], storage = memory(), clock = { t: T }) {
  const api = fakeApi(answers);
  const tr = createUpdateTracker({ fetch: api.fetch, storage, now: () => clock.t, setTimeout: () => 0, clearTimeout: () => {} });
  return { tr, api, storage, clock };
}
// The page's view after each poll: what the panel of ticket q1 shows (the stream is away: no run).
const view = (tr: ReturnType<typeof createUpdateTracker>, now: number, run: UpdateRun | null = null) => {
  const s = tr.get();
  const r = progressOf({ run, press: s.press, link: s.link, now, to: 849 });
  if (s.press && r.furthest > s.press.furthest) tr.note({ furthest: r.furthest });
  return words(r.p);
};

describe("the tracker: press → steps → restart gap → done", () => {
  it("one press through every step, with the API away for a while", async () => {
    const asked = run("asked");
    const { tr, clock } = tracker([
      deploy(848, "available", null, asked),
      deploy(848, "running", "download", run("running", { step: "download" })),
      deploy(848, "running", "stage", run("running", { step: "stage" })),
      { status: 502 }, "down", "down", "down",
      deploy(849, "running", "stage", null, 849),
      deploy(849, "updated", null, null, 849),
    ]);
    expect(tr.press({ item: "q1", from: 848, to: 849 })).toBe(true);
    const seen = [view(tr, clock.t)];
    tr.answered(T + 100);
    for (let n = 0; n < 9; n++) {
      clock.t += 1_500;
      await tr.pollOnce();
      seen.push(view(tr, clock.t));
    }
    expect([...new Set(seen)]).toEqual([
      "Downloading> -Installing -Restarting -Checking",
      "+Downloading Installing> -Restarting -Checking",
      "+Downloading +Installing Restarting> -Checking",
      "+Downloading +Installing +Restarting Checking>",
      "done 849",
    ]);
    // One failed answer did not count as the restart: the step changed only at the second.
    expect(seen[4]).toBe("+Downloading Installing> -Restarting -Checking");
    expect(seen[5]).toBe("+Downloading +Installing Restarting> -Checking");
    expect(AWAY_AFTER).toBe(2);
  });

  it("a failure through the restart: the console's sentence, and the steps stop where they were", async () => {
    const { tr, clock } = tracker([
      deploy(848, "running", "stage", run("running", { step: "stage" })), "down", "down",
      deploy(848, "failed-back", "health", run("failed-back", { step: "health" })),
    ]);
    tr.press({ item: "q1", from: 848, to: 849 });
    tr.answered(T + 100);
    const seen: string[] = [];
    for (let n = 0; n < 4; n++) { clock.t += 1_500; await tr.pollOnce(); seen.push(view(tr, clock.t)); }
    expect(seen).toEqual([
      "+Downloading Installing> -Restarting -Checking",
      "+Downloading Installing> -Restarting -Checking",
      "+Downloading +Installing Restarting> -Checking",
      "failed: Failed at the health check. Back on version 848. Nothing lost. | The next release comes as a new ticket.",
    ]);
  });

  it("a reload in the middle: a new page has the same press, at the same step", async () => {
    const storage = memory();
    const first = tracker([deploy(848, "running", "stage", run("running", { step: "stage" }))], storage);
    first.tr.press({ item: "q1", from: 848, to: 849 });
    first.tr.answered(T + 100);
    await first.tr.pollOnce();
    expect(view(first.tr, T + 2_000)).toBe("+Downloading Installing> -Restarting -Checking");
    first.tr.note({ furthest: 2 }); // the page saw the API away before the reload
    // The reloaded page: no poll yet, the stream not open; the press is there.
    const again = tracker([deploy(849, "running", "stage", null, 849)], storage, { t: T + 30_000 });
    expect(again.tr.get().press).toMatchObject({ item: "q1", askedAt: T + 100, furthest: 2, ended: false });
    expect(view(again.tr, T + 30_000)).toBe("+Downloading +Installing Restarting> -Checking");
    await again.tr.pollOnce();
    expect(view(again.tr, T + 31_000)).toBe("+Downloading +Installing +Restarting Checking>");
  });

  it("a reload drops a press that the server never answered, and one that is too old", () => {
    const storage = memory();
    storage.setItem(PRESS_KEY, JSON.stringify(press({ askedAt: null })));
    expect(tracker([], storage, { t: T + PRESS_ANSWER_MS + 1 }).tr.get().press).toBeNull();
    expect(storage.getItem(PRESS_KEY)).toBeNull();
    storage.setItem(PRESS_KEY, JSON.stringify(press()));
    expect(tracker([], storage, { t: T + PRESS_MAX_MS + 1 }).tr.get().press).toBeNull();
    storage.setItem(PRESS_KEY, "{not json");
    expect(tracker([], storage).tr.get().press).toBeNull();
  });

  it("two presses: the second does nothing while the first waits for its answer", () => {
    const { tr, storage } = tracker([]);
    expect(tr.press({ item: "q1", from: 848, to: 849 })).toBe(true);
    const first = storage.getItem(PRESS_KEY);
    expect(tr.press({ item: "q1", from: 848, to: 849 })).toBe(false);
    expect(storage.getItem(PRESS_KEY)).toBe(first);
    // After an end (a refusal that can be asked again), a new press is one.
    tr.answered(T + 100);
    tr.note({ ended: true });
    expect(tr.press({ item: "q1", from: 848, to: 849 })).toBe(true);
  });

  it("a refused POST takes the press back (the button again)", () => {
    const { tr, storage } = tracker([]);
    tr.press({ item: "q1", from: 848, to: 849 });
    tr.refused();
    expect(tr.get().press).toBeNull();
    expect(storage.getItem(PRESS_KEY)).toBeNull();
    expect(view(tr, T)).toBe("idle");
  });

  it("an answer that is not the console's JSON counts as away; a console with no updater changes nothing", async () => {
    const { tr } = tracker([{ status: 200 }, { status: 200 }, { status: 200, body: { armed: true } }]);
    await tr.pollOnce();
    expect(tr.get().link.t).toBe("none");
    await tr.pollOnce();
    expect(tr.get().link.t).toBe("away");
    await tr.pollOnce();
    expect(tr.get().link.t).toBe("away"); // a git console's answer: no update view
  });

  it("the poll runs while one place watches, once for all of them, and stops with the last", async () => {
    const timers: (() => void)[] = [];
    const api = fakeApi([]);
    const tr = createUpdateTracker({ fetch: api.fetch, storage: memory(), now: () => T, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const tick = async () => { for (const fn of timers.splice(0)) fn(); await flush(); };
    const stopA = tr.watch();
    const stopB = tr.watch();
    await flush();
    expect(api.calls).toHaveLength(1);
    stopA();
    stopA(); // twice is once
    await tick();
    expect(api.calls).toHaveLength(2); // B still watches
    stopB();
    await tick();
    await tick();
    expect(api.calls).toHaveLength(2);
  });

  it("notes keep the furthest step, the end and the Queue's one peek", () => {
    const { tr, storage } = tracker([]);
    tr.press({ item: "q1", from: 848, to: 849 });
    tr.note({ furthest: 2 });
    tr.note({ furthest: 1 });
    tr.note({ ended: true, peeked: true });
    expect(JSON.parse(storage.getItem(PRESS_KEY)!)).toMatchObject({ furthest: 2, ended: true, peeked: true });
  });
});

describe("endedPressTicket: the Queue keeps the ended update ticket in the pane, once", () => {
  const closed = { id: "q1", status: "withdrawn", lastError: "updated" };
  it("keeps it when the pane showed it, or on the view's first list (a reload)", () => {
    expect(endedPressTicket(press(), [closed], "q1")).toBe("q1");
    expect(endedPressTicket(press(), [closed], undefined)).toBe("q1");
    expect(endedPressTicket(press(), [{ ...closed, lastError: "update-failed" }], "q1")).toBe("q1");
  });
  it("not when the pane showed another ticket, after the one peek, or for another end", () => {
    expect(endedPressTicket(press(), [closed], "q2")).toBeNull();
    expect(endedPressTicket(press({ peeked: true }), [closed], "q1")).toBeNull();
    expect(endedPressTicket(press(), [{ ...closed, lastError: "live" }], "q1")).toBeNull();
    expect(endedPressTicket(press(), [{ ...closed, status: "open" }], "q1")).toBeNull();
    expect(endedPressTicket(null, [closed], "q1")).toBeNull();
  });
});
