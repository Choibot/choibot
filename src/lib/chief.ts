import { USER_CLI } from "../../server/brand";
// src/lib/chief.ts — every browser request goes through chiefFetch (spec §3.1).
// Adds the stored user token to same-origin relative URLs only, and turns the
// server's 403 pair-required / 503 chief-misconfigured answers into UI state.
export const USER_TOKEN_KEY = "choibot.userToken";
export const MISCONFIGURED_TEXT = `Chief misconfigured — see \`${USER_CLI} doctor\``;

export type ChiefUiState = { pairRequired: boolean; misconfigured: boolean; userAuth: "telegram" | "log" | null };

let state: ChiefUiState = { pairRequired: false, misconfigured: false, userAuth: null };
const subs = new Set<(s: ChiefUiState) => void>();

export function isSameOriginRelative(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

export function getChiefState(): ChiefUiState { return state; }

export function subscribeChiefState(cb: (s: ChiefUiState) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

function setState(next: ChiefUiState): void {
  if (next.pairRequired === state.pairRequired && next.misconfigured === state.misconfigured && next.userAuth === state.userAuth) return;
  state = next;
  for (const cb of [...subs]) cb(state);
}

// action: the refused action's name ("Merge" unless a caller says otherwise).
export function pairSentence(userAuth: "telegram" | "log" | null, action = "Merge"): string {
  return userAuth === "telegram"
    ? `${action} needs a paired device — send /pair <label> in the Master topic`
    // The page way first. The command stays for a person with no paired device at hand: it is
    // the proof that the person owns the server.
    : `${action} needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run \`${USER_CLI} brain pair <label>\` on your server`;
}

export function isRefusalText(text: string | undefined | null): boolean {
  return text === MISCONFIGURED_TEXT || text === pairSentence("telegram") || text === pairSentence("log");
}

export function clearPairRequired(): void {
  setState({ ...state, pairRequired: false });
}

// Another tab stored or removed the token: re-read the pairing state.
export function handleStorageEvent(e: { key: string | null; newValue: string | null }): void {
  if (e.key !== USER_TOKEN_KEY) return;
  if (e.newValue) clearPairRequired();
  notifyChiefState(); // a removal too: the pairing card returns
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e) => handleStorageEvent(e));
}

// The fixed sentence for a refused response, or null for any other answer.
// Reads userAuth from the body first (chiefFetch records it in state too).
export function refusalSentence(
  status: number, body: { error?: string; userAuth?: string } | null | undefined, action?: string,
): string | null {
  if (status === 403 && body?.error === "pair-required") {
    const ua = body.userAuth === "telegram" ? "telegram" : body.userAuth === "log" ? "log" : state.userAuth;
    return pairSentence(ua, action);
  }
  if (status === 503 && body?.error === "chief-misconfigured") return MISCONFIGURED_TEXT;
  return null;
}

function defaultStorage(): Pick<Storage, "getItem"> | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

// A token is base64url, so only visible ASCII is kept. A CR, LF or NUL (or a
// char above U+00FF) would make headers.set throw on every request; any other
// control or non-ASCII char is never in a real token. Such a token is absent.
const TOKEN_RE = /^[\x21-\x7e]+$/;

function readToken(storage: Pick<Storage, "getItem"> | null): string | null {
  if (!storage) return null;
  let token: string | null;
  try { token = storage.getItem(USER_TOKEN_KEY); } catch { return null; }
  return token && TOKEN_RE.test(token) ? token : null;
}

// The stored user token, or null: what chiefFetch sends as x-choibot-user. The
// terminal sockets offer it as their subprotocol (termSocket.ts).
export function storedUserToken(storage: Pick<Storage, "getItem"> | null | undefined = undefined): string | null {
  return readToken(storage === undefined ? defaultStorage() : storage);
}

// True when a user token is stored. The queue list is readable unpaired, so the
// Queue tab cannot wait for a 403 to know this browser is not paired yet.
export function hasUserToken(storage: Pick<Storage, "getItem"> | null | undefined = undefined): boolean {
  return storedUserToken(storage) !== null;
}

// Tell subscribers to re-read (a token was stored or arrived from another tab).
export function notifyChiefState(): void {
  for (const cb of [...subs]) cb(state);
}

function reloadPage(): void {
  if (typeof window !== "undefined") window.location?.reload?.();
}

// A console behind a front proxy (a hosted console) refuses every API to a browser that is not
// paired, with 401 "pair-required" (server/frontproxy.ts). The page then opens the pairing
// screen, once, and never from the pairing screens themselves.
// Not from the pairing screens, and not from a page that holds a pairing link (`#pair=`, the
// PairCard of log or Telegram mode): that page pairs with its own code. The page clears the hash
// at once (page.tsx), so the link is read here when this module loads, and the page tells it of
// a later link (holdPairLink).
const PAIR_PAGES = new Set(["/pair", "/first-run"]);
const PAIR_LINK_RE = /^#pair=/;
let pairLinkHeld = typeof window !== "undefined" && PAIR_LINK_RE.test(window.location?.hash ?? "");
export function holdPairLink(on: boolean): void { pairLinkHeld = on; }
export const opensPairPage = (pathname: string, hash: string, held: boolean): boolean =>
  !PAIR_PAGES.has(pathname) && !held && !PAIR_LINK_RE.test(hash);
let leftForPair = false;
function openPairPage(): void {
  if (typeof window === "undefined" || leftForPair || !opensPairPage(window.location?.pathname ?? "", window.location?.hash ?? "", pairLinkHeld)) return;
  leftForPair = true;
  window.location.replace("/pair");
}

export async function chiefFetch(
  input: string,
  init?: RequestInit,
  deps: { fetch?: typeof fetch; storage?: Pick<Storage, "getItem"> | null; onLocked?: () => void; onUnpaired?: () => void } = {},
): Promise<Response> {
  const doFetch = deps.fetch ?? ((i: string, o?: RequestInit) => fetch(i, o));
  let req = init;
  if (isSameOriginRelative(input)) {
    const token = readToken(deps.storage === undefined ? defaultStorage() : deps.storage);
    if (token) {
      const headers = new Headers(init?.headers);
      headers.set("x-choibot-user", token);
      req = { ...init, headers };
    }
  }
  const res = await doFetch(input, req);
  if (res.status === 401 && isSameOriginRelative(input)) {
    try {
      const body = (await res.clone().json()) as { error?: string };
      if (body.error === "pair-required") (deps.onUnpaired ?? openPairPage)();
    } catch { /* not the front proxy's answer */ }
  }
  if (res.status === 403 || res.status === 503) {
    try {
      const body = (await res.clone().json()) as { error?: string; userAuth?: string; locked?: boolean };
      if (res.status === 403 && body.error === "pair-required") {
        // A new install lost its last paired device while this page was open: the server now
        // serves only its pairing screen (server/chief/firstrun.ts), so load it.
        if (body.locked === true) (deps.onLocked ?? reloadPage)();
        setState({ ...state, pairRequired: true, userAuth: body.userAuth === "telegram" ? "telegram" : "log" });
      } else if (res.status === 503 && body.error === "chief-misconfigured") {
        setState({ ...state, misconfigured: true });
      }
    } catch { /* not a chief body */ }
  }
  return res;
}

// Claim a pairing code (only ever called from the [Pair] tap). Stores the token.
export async function claimPairing(
  code: string,
  deps: { fetch?: typeof fetch; storage?: Pick<Storage, "setItem"> | null } = {},
): Promise<{ ok: true; label: string } | { ok: false; error: "used" | "failed" }> {
  const doFetch = deps.fetch ?? ((i: string, o?: RequestInit) => fetch(i, o));
  // Resolve storage before the POST: the code is single-use, so never spend it with nowhere to keep the token.
  let storage: Pick<Storage, "setItem"> | null;
  if (deps.storage === undefined) {
    try { storage = typeof localStorage === "undefined" ? null : localStorage; } catch { storage = null; }
  } else storage = deps.storage;
  if (!storage) return { ok: false, error: "failed" };
  try {
    const res = await doFetch("/api/chief/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status === 410) return { ok: false, error: "used" };
    if (!res.ok) return { ok: false, error: "failed" };
    const body = (await res.json()) as { token?: unknown; label?: unknown };
    if (typeof body.token !== "string" || !body.token) return { ok: false, error: "failed" };
    storage.setItem(USER_TOKEN_KEY, body.token);
    clearPairRequired();
    notifyChiefState();
    return { ok: true, label: typeof body.label === "string" ? body.label : "" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

// The first device of a new install (server/chief/firstrun.ts): is this console locked to its
// pairing screen? False for a console that has no such route.
export const FIRST_RUN_ROUTE = "/api/chief/pair/first";

export async function firstRunLocked(deps: { fetch?: typeof fetch } = {}): Promise<boolean> {
  return (await firstRunState(deps)).locked;
}

// The state of the pairing screen. link: the claim link of a first-start file (none, open, or
// ended); hosted: the console of a hosted service, so a new link comes from its dashboard.
export type FirstRunState = { locked: boolean; link: "none" | "open" | "ended"; hosted: boolean };

export async function firstRunState(deps: { fetch?: typeof fetch } = {}): Promise<FirstRunState> {
  const doFetch = deps.fetch ?? ((i: string, o?: RequestInit) => fetch(i, o));
  try {
    const res = await doFetch(FIRST_RUN_ROUTE);
    if (!res.ok) return { locked: false, link: "none", hosted: false };
    const b = (await res.json()) as { locked?: unknown; link?: unknown; hosted?: unknown };
    const link = b.link === "open" || b.link === "ended" ? b.link : "none";
    return { locked: b.locked === true, link, hosted: b.hosted === true };
  } catch {
    // No answer: stay on the screen, the claim says what is wrong.
    return { locked: true, link: "none", hosted: false };
  }
}

// The secret of a claim link, from the fragment of the address (#k=<43 characters>). "" when
// there is none, or when the text has another shape.
export function linkFromHash(hash: string): string {
  return /^#?k=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? "";
}

// wrong: not the code. gone: used, too old, or none on the box. spent: too many wrong codes.
// storage: this browser cannot keep the token. failed: any other answer.
export type FirstRunError = "wrong" | "gone" | "spent" | "storage" | "failed";
// The claim of a typed code, on a route of the server. off: this console has no such route.
// name: the server does not take the name of the device.
export type CodeClaimError = FirstRunError | "off" | "name";
type ClaimDeps = { fetch?: typeof fetch; storage?: Pick<Storage, "setItem"> | null };

// Claim a typed code (only from the [Pair this device] tap). Stores the token. `field`: "claim"
// for the secret of a claim link (the same route as the code of the box).
export async function claimCode(
  route: string, code: string, label: string, deps: ClaimDeps = {}, field: "code" | "claim" = "code",
): Promise<{ ok: true; label: string } | { ok: false; error: CodeClaimError }> {
  const doFetch = deps.fetch ?? ((i: string, o?: RequestInit) => fetch(i, o));
  // Resolve storage before the POST: the code is single-use, so never spend it with nowhere to keep the token.
  let storage: Pick<Storage, "setItem"> | null;
  if (deps.storage === undefined) {
    try { storage = typeof localStorage === "undefined" ? null : localStorage; } catch { storage = null; }
  } else storage = deps.storage;
  if (!storage) return { ok: false, error: "storage" };
  try {
    const res = await doFetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: code, label }),
    });
    if (res.status === 410) return { ok: false, error: "gone" };
    if (res.status === 429) return { ok: false, error: "spent" };
    if (res.status === 404) return { ok: false, error: "off" };
    if (res.status === 400) return { ok: false, error: "name" };
    if (res.status === 403 && /^wrong-(code|link)$/.test(((await res.json()) as { error?: string }).error ?? "")) return { ok: false, error: "wrong" };
    if (!res.ok) return { ok: false, error: "failed" };
    const body = (await res.json()) as { token?: unknown; label?: unknown };
    if (typeof body.token !== "string" || !body.token) return { ok: false, error: "failed" };
    storage.setItem(USER_TOKEN_KEY, body.token);
    clearPairRequired();
    notifyChiefState();
    return { ok: true, label: typeof body.label === "string" ? body.label : "" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

// Claim the code of the box (or, with `field` "claim", the secret of the claim link), for the
// first device of a new install.
export async function claimFirstRun(
  code: string, label: string, deps: ClaimDeps = {}, field: "code" | "claim" = "code",
): Promise<{ ok: true; label: string } | { ok: false; error: FirstRunError }> {
  const r = await claimCode(FIRST_RUN_ROUTE, code, label, deps, field);
  if (r.ok) return r;
  return { ok: false, error: r.error === "off" || r.error === "name" ? "failed" : r.error };
}
