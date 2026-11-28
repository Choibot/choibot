// src/lib/githubTrip.ts — ONE trip to GitHub in the Set-up of the ChoiBot app (the one card
// "Connect GitHub", src/lib/setup.ts oneGithubStep): the approval of the code and the choice of the
// repos happen in the same GitHub tab.
//   1. Press 1 opens the tab (a press of the person, so no popup block) as an empty page of the
//      console's own origin and sends it to GitHub's device page.
//   2. GitHub has the approval and the app reaches no repo yet. While the person is still away
//      from this tab, the page sends THAT tab on to the app's install page, one time only. At this
//      hop the tab loses its way back to the console (opener = null).
//   3. The person picks the repos, presses Install and comes back: the repo list is read again
//      when this tab shows again (onReturn). No press is necessary.
// The way back (window.opener) stays only while the tab shows GitHub's device pages: a browser
// lets a page move another tab only when it is that tab's opener (Chromium: "neither same-origin
// with the target, nor is it the target's parent or opener"). The install page has none.
// Each hop starts on an empty page of the console's own origin, by a link with rel="noreferrer":
// GitHub gets no Referer, as with the plain links (rel="noopener noreferrer") before. No hop
// carries a token: the device page gets GitHub's own user code (as before), the install page
// nothing.
// If the browser gives no handle or loses it (a blocked window, a closed tab, a GitHub page whose
// opener policy cuts the handle), nothing moves: the card shows its link to GitHub, as before.

type TripDoc = {
  readonly URL: string;
  readonly readyState: string;
  readonly body: { appendChild(n: unknown): unknown } | null;
  createElement(tag: "a"): { href: string; rel: string; click(): void };
};
export type TripWindow = {
  readonly closed: boolean;
  opener: unknown;
  readonly document: TripDoc;
  readonly location: { replace(url: string): void };
  close(): void;
};
export type TripHost = { open(url: string, target: string): TripWindow | null };

let trip: { win: TripWindow; moved: boolean } | null = null;

// The app's install page (GitHub's docs, "Installing a GitHub App from a third party"): GitHub
// asks for the account, then "All repositories" or "Only select repositories".
export function installUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/installations/new`;
}

// A hop of the tab: a link with rel="noreferrer" on its empty page of the console's own origin.
// `cut`: the tab loses its way back to the console first. False when the tab shows no such page
// (a GitHub page, or a closed tab).
function follow(win: TripWindow, url: string, cut: boolean): boolean {
  try {
    if (win.closed) return false;
    const d = win.document;
    if (d.URL !== "about:blank" || !d.body) return false;
    if (cut) win.opener = null;
    const a = d.createElement("a");
    a.href = url;
    a.rel = "noreferrer";
    d.body.appendChild(a);
    a.click();
    return true;
  } catch {
    return false;
  }
}

// Press 1: call it in the press's own handler. True: the tab is open and on its way to `url` (the
// caller stops the link's own action). False: the link opens `url` itself, as before.
export function openTrip(url: string, host: TripHost = window as unknown as TripHost): boolean {
  let win: TripWindow | null = null;
  try { win = host.open("about:blank", "_blank"); } catch { win = null; }
  if (!win) return false;
  if (!follow(win, url, false)) {
    try { win.close(); } catch { /* nothing to close */ }
    return false;
  }
  trip = { win, moved: false };
  return true;
}

// A trip that is open and has not moved yet.
export const tripWaits = (): boolean => trip !== null && !trip.moved && !trip.win.closed;
// The trip went on to the install page (the card says where the person picks the repos).
export const tripMoved = (): boolean => trip !== null && trip.moved;

export type MoveOpts = { waitMs?: number; tickMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };
const SLEEP = (ms: number) => new Promise<void>((ok) => { setTimeout(ok, ms); });

// Step 2: send the tab of press 1 on to `url`, one time only. The tab shows a GitHub page, so it
// goes first to an empty page (which then has the console's origin), then by the link, with no way
// back. False: no trip, a closed tab, a trip that moved before, or a tab that did not come back in
// time.
export async function moveTrip(url: string, o: MoveOpts = {}): Promise<boolean> {
  const t = trip;
  if (!t || t.moved || t.win.closed) return false;
  t.moved = true;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? SLEEP;
  const until = now() + (o.waitMs ?? 5_000);
  if (follow(t.win, url, true)) return true;
  try { t.win.location.replace("about:blank"); } catch { t.moved = false; return false; }
  while (now() < until) {
    await sleep(o.tickMs ?? 50);
    if (t.win.closed) break;
    if (follow(t.win, url, true)) return true;
  }
  t.moved = false;
  return false;
}

// Is the person away from this tab (on GitHub)? Only then may the trip move: a person who looks
// at this tab presses the card's link instead (a tab that moves out of sight is lost on a phone).
export const awayFrom = (doc: Pick<Document, "visibilityState" | "hasFocus"> = document): boolean =>
  doc.visibilityState === "hidden" || !doc.hasFocus();

// `fn` runs each time this tab shows again: the window gets the focus back, or the page turns
// visible. Both come on one return: a second call within `gapMs` is dropped. Gives the stop.
export function onReturn(
  fn: () => void,
  o: { win?: Pick<EventTarget, "addEventListener" | "removeEventListener">; doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">; gapMs?: number; now?: () => number } = {},
): () => void {
  const win = o.win ?? window;
  const doc = o.doc ?? document;
  const now = o.now ?? Date.now;
  const gap = o.gapMs ?? 1_000;
  let last = -Infinity;
  const again = () => {
    if (doc.visibilityState !== "visible") return;
    const t = now();
    if (t - last < gap) return;
    last = t;
    fn();
  };
  win.addEventListener("focus", again);
  doc.addEventListener("visibilitychange", again);
  return () => { win.removeEventListener("focus", again); doc.removeEventListener("visibilitychange", again); };
}

// The repo part of the one card while the app reaches no repo yet: one line and one link.
export type ChooseCard = { line: string; link: { href: string; text: string; primary: boolean } | null };
export function chooseCard(appUrl: string | null, moved: boolean): ChooseCard {
  if (!appUrl) return { line: "The settings of your server have no link to the ChoiBot app yet. Ask the person who runs your server for it.", link: null };
  const href = installUrl(appUrl);
  return moved
    ? { line: "In the GitHub tab, pick “Only select repositories”, your repos, then Install.", link: { href, text: "Open GitHub again", primary: false } }
    : { line: "On GitHub, pick “Only select repositories”, then your repos.", link: { href, text: "Choose repos on GitHub", primary: true } };
}

// Tests only: forget the trip.
export function resetTrip(): void { trip = null; }
