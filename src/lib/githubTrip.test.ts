// src/lib/githubTrip.test.ts — ONE trip to GitHub in the Set-up of the ChoiBot app: press 1 opens
// the tab, the tab goes on to the install page once while the person is away, and the list is
// read again when this tab shows again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { awayFrom, chooseCard, installUrl, moveTrip, onReturn, openTrip, resetTrip, tripMoved, tripWaits, type TripWindow } from "./githubTrip";

const DEVICE = "https://github.com/login/device?user_code=WDJB-MJHT";
const APP = "https://github.com/apps/choibot";

// A browser tab: an empty page of the console's own origin, or a GitHub page (no access to its
// document). A move to about:blank lands at the next tick (`land`).
function tab() {
  const log: string[] = [];
  let ours = true;
  let url = "about:blank";
  let landing = false;
  const win = {
    closed: false,
    opener: { console: true } as unknown,
    get document() {
      if (!ours) throw new Error("Blocked a frame with origin from accessing a cross-origin frame.");
      return {
        URL: url, readyState: "complete", body: { appendChild: () => undefined },
        createElement: () => {
          const a = { href: "", rel: "", click: () => { log.push(`link ${a.href} rel=${a.rel}`); url = a.href; ours = false; } };
          return a;
        },
      };
    },
    location: { replace: (u: string) => { log.push(`replace ${u}`); if (u === "about:blank") landing = true; } },
    close: () => { win.closed = true; },
  };
  const land = () => { if (landing) { landing = false; ours = true; url = "about:blank"; } };
  return { win: win as TripWindow & { closed: boolean }, log, land };
}

afterEach(() => resetTrip());

describe("press 1 opens the tab of the trip", () => {
  it("opens an empty page and goes to the device page with no Referer; the way back stays for the move", () => {
    const t = tab();
    const open = vi.fn(() => t.win);
    expect(openTrip(DEVICE, { open })).toBe(true);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(t.win.opener).not.toBeNull();
    expect(t.log).toEqual([`link ${DEVICE} rel=noreferrer`]);
    expect(tripWaits()).toBe(true);
    expect(tripMoved()).toBe(false);
  });

  it("leaves the press to the link when the browser gives no tab", () => {
    expect(openTrip(DEVICE, { open: () => null })).toBe(false);
    expect(openTrip(DEVICE, { open: () => { throw new Error("blocked"); } })).toBe(false);
    expect(tripWaits()).toBe(false);
  });

  it("closes a tab that it cannot send on, and leaves the press to the link", () => {
    const t = tab();
    Object.defineProperty(t.win, "document", { get: () => { throw new Error("no access"); } });
    expect(openTrip(DEVICE, { open: () => t.win })).toBe(false);
    expect(t.win.closed).toBe(true);
    expect(tripWaits()).toBe(false);
  });
});

describe("after the approval the same tab goes on to the install page", () => {
  const clock = () => { let at = 0; return { now: () => at, step: (ms: number) => { at += ms; } }; };

  it("goes from the GitHub page to an empty page of this origin, then with no way back and no Referer, one time only", async () => {
    const t = tab();
    openTrip(DEVICE, { open: () => t.win });
    const c = clock();
    const ok = await moveTrip(installUrl(APP), { now: c.now, sleep: async (ms) => { c.step(ms); t.land(); } });
    expect(ok).toBe(true);
    expect(t.log).toEqual([
      `link ${DEVICE} rel=noreferrer`,
      "replace about:blank",
      `link ${APP}/installations/new rel=noreferrer`,
    ]);
    expect(t.win.opener).toBeNull();
    expect(tripMoved()).toBe(true);
    expect(tripWaits()).toBe(false);
    // One time only: a second read of the list does not move the tab again.
    expect(await moveTrip(installUrl(APP), { now: c.now, sleep: async (ms) => { c.step(ms); t.land(); } })).toBe(false);
    expect(t.log).toHaveLength(3);
  });

  it("does nothing with no trip, or with a tab that the person closed", async () => {
    expect(await moveTrip(installUrl(APP))).toBe(false);
    const t = tab();
    openTrip(DEVICE, { open: () => t.win });
    t.win.close();
    expect(tripWaits()).toBe(false);
    expect(await moveTrip(installUrl(APP))).toBe(false);
    expect(t.log).toEqual([`link ${DEVICE} rel=noreferrer`]);
  });

  it("gives up on a tab that does not come back in time, and moves nothing", async () => {
    const t = tab();
    openTrip(DEVICE, { open: () => t.win });
    const c = clock();
    const ok = await moveTrip(installUrl(APP), { waitMs: 500, tickMs: 100, now: c.now, sleep: async (ms) => { c.step(ms); } });
    expect(ok).toBe(false);
    expect(t.log).toEqual([`link ${DEVICE} rel=noreferrer`, "replace about:blank"]);
    expect(t.win.opener).not.toBeNull();
    expect(tripMoved()).toBe(false);
  });

  it("names the install page of the app", () => {
    expect(installUrl(APP)).toBe("https://github.com/apps/choibot/installations/new");
    expect(installUrl(`${APP}/`)).toBe("https://github.com/apps/choibot/installations/new");
  });

  it("moves only while the person is away from this tab", () => {
    expect(awayFrom({ visibilityState: "hidden", hasFocus: () => false })).toBe(true);
    expect(awayFrom({ visibilityState: "visible", hasFocus: () => false })).toBe(true);
    expect(awayFrom({ visibilityState: "visible", hasFocus: () => true })).toBe(false);
  });
});

describe("the list is read again when this tab shows again", () => {
  function page() {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState });
    return { win, doc };
  }

  it("reads on the focus and on a page that turns visible, once for one return", () => {
    const p = page();
    let at = 0;
    const fn = vi.fn();
    const stop = onReturn(fn, { win: p.win, doc: p.doc, now: () => at });
    p.doc.dispatchEvent(new Event("visibilitychange"));
    expect(fn).not.toHaveBeenCalled();
    p.doc.visibilityState = "visible";
    p.doc.dispatchEvent(new Event("visibilitychange"));
    p.win.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(1);
    at = 5_000;
    p.win.dispatchEvent(new Event("focus"));
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
    at = 10_000;
    p.win.dispatchEvent(new Event("focus"));
    p.doc.dispatchEvent(new Event("visibilitychange"));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("the repo part of the card while the app reaches no repo", () => {
  it("has one line and one link for each state", () => {
    expect(chooseCard(APP, false)).toEqual({
      line: "On GitHub, pick “Only select repositories”, then your repos.",
      link: { href: `${APP}/installations/new`, text: "Choose repos on GitHub", primary: true },
    });
    expect(chooseCard(APP, true)).toEqual({
      line: "In the GitHub tab, pick “Only select repositories”, your repos, then Install.",
      link: { href: `${APP}/installations/new`, text: "Open GitHub again", primary: false },
    });
    expect(chooseCard(null, true)).toEqual({ line: expect.stringContaining("no link to the ChoiBot app"), link: null });
  });
});
