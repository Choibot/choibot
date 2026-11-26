import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { opensPairPage, claimFirstRun, firstRunLocked, firstRunState, linkFromHash, FIRST_RUN_ROUTE, clearPairRequired, handleStorageEvent, hasUserToken, notifyChiefState, isRefusalText, MISCONFIGURED_TEXT, USER_TOKEN_KEY, chiefFetch, claimPairing, getChiefState, isSameOriginRelative, pairSentence, subscribeChiefState } from "./chief";

const store = (t: string | null) => ({ getItem: (k: string) => (k === USER_TOKEN_KEY ? t : null) });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("chiefFetch", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(async () => json(200, {})); });
  const hdr = () => new Headers(fetchMock.mock.calls[0][1]?.headers).get("x-choibot-user");

  it("adds the token to same-origin relative urls", async () => {
    await chiefFetch("/api/x", { method: "POST" }, { fetch: fetchMock, storage: store("tok") });
    expect(hdr()).toBe("tok");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });
  it("never adds the token to absolute or protocol-relative urls", async () => {
    await chiefFetch("https://evil/x", undefined, { fetch: fetchMock, storage: store("tok") });
    await chiefFetch("//evil/x", undefined, { fetch: fetchMock, storage: store("tok") });
    for (const c of fetchMock.mock.calls) expect(c[1]).toBeUndefined();
    expect(isSameOriginRelative("//e")).toBe(false);
    expect(isSameOriginRelative("/a")).toBe(true);
  });
  it("works with null storage, no token, or throwing storage", async () => {
    await chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: null });
    await chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: store(null) });
    await chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: { getItem: () => { throw new Error("x"); } } });
    for (const c of fetchMock.mock.calls) expect(c[1]).toBeUndefined();
  });
  it("treats a stored token with control or non-ASCII characters as absent and does not throw", async () => {
    for (const bad of ["a\rb", "a\nb", "tok\r\n", "a\0b", "a\x01b", "a\tb", "a\x7fb", "tök✓"]) {
      fetchMock.mockClear();
      await expect(chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: store(bad) })).resolves.toBeInstanceOf(Response);
      expect(fetchMock.mock.calls[0][1]).toBeUndefined();
    }
  });
  it("sets pairRequired on 403 pair-required, keeps body readable, notifies", async () => {
    const body = { error: "pair-required", userAuth: "log" };
    fetchMock.mockImplementation(async () => json(403, body));
    const cb = vi.fn();
    const off = subscribeChiefState(cb);
    const res = await chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: store("revoked") });
    expect(getChiefState()).toMatchObject({ pairRequired: true, userAuth: "log" });
    expect(await res.json()).toEqual(body);
    expect(cb).toHaveBeenCalled();
    off();
  });
  it("sets misconfigured on 503 chief-misconfigured", async () => {
    fetchMock.mockImplementation(async () => json(503, { error: "chief-misconfigured" }));
    await chiefFetch("/api/x", undefined, { fetch: fetchMock, storage: null });
    expect(getChiefState().misconfigured).toBe(true);
  });
  it("pairSentence and misconfigured text", () => {
    expect(pairSentence("log")).toBe("Merge needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server");
    expect(pairSentence("telegram")).toBe("Merge needs a paired device — send /pair <label> in the Master topic");
    expect(MISCONFIGURED_TEXT).toBe("Chief misconfigured — see `pnpm choibot doctor`");
  });
});

describe("no raw fetch in client code", () => {
  it("every client file uses chiefFetch", () => {
    const bad: string[] = [];
    for (const dir of ["src/lib", "src/components"]) {
      for (const f of readdirSync(dir)) {
        if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || f === "chief.ts") continue;
        if (/(^|[^.\w])fetch\(/m.test(readFileSync(join(dir, f), "utf8"))) bad.push(`${dir}/${f}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("claimPairing", () => {
  it("stores the token and returns the label on 200", async () => {
    const setItem = vi.fn();
    const f = vi.fn(async (_u: string, _o?: RequestInit) => json(200, { token: "tok1", label: "phone" }));
    const r = await claimPairing("abc", { fetch: f as unknown as typeof fetch, storage: { setItem } });
    expect(r).toEqual({ ok: true, label: "phone" });
    expect(setItem).toHaveBeenCalledWith(USER_TOKEN_KEY, "tok1");
    expect(f.mock.calls[0][0]).toBe("/api/chief/pair/claim");
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toEqual({ code: "abc" });
  });
  it("returns used on 410 and stores nothing", async () => {
    const setItem = vi.fn();
    const f = vi.fn(async () => json(410, { error: "pairing code expired or used" }));
    expect(await claimPairing("abc", { fetch: f as unknown as typeof fetch, storage: { setItem } })).toEqual({ ok: false, error: "used" });
    expect(setItem).not.toHaveBeenCalled();
  });
  it("returns failed on other errors and on throwing storage", async () => {
    const f500 = vi.fn(async () => json(500, {}));
    expect(await claimPairing("abc", { fetch: f500 as unknown as typeof fetch, storage: null })).toEqual({ ok: false, error: "failed" });
    const f = vi.fn(async () => json(200, { token: "t", label: "l" }));
    const bad = { setItem: () => { throw new Error("x"); } };
    expect(await claimPairing("abc", { fetch: f as unknown as typeof fetch, storage: bad })).toEqual({ ok: false, error: "failed" });
  });
});

describe("the first device of a new install", () => {
  const f = (status: number, body: unknown) => vi.fn(async (_u: string, _o?: RequestInit) => json(status, body));
  it("stores the token of the claimed code", async () => {
    const setItem = vi.fn();
    const ok = f(200, { token: "tok1", label: "computer" });
    expect(await claimFirstRun("k7qf-2m9x", "computer", { fetch: ok as unknown as typeof fetch, storage: { setItem } })).toEqual({ ok: true, label: "computer" });
    expect(setItem).toHaveBeenCalledWith(USER_TOKEN_KEY, "tok1");
    expect(ok.mock.calls[0][0]).toBe(FIRST_RUN_ROUTE);
    expect(JSON.parse(ok.mock.calls[0][1]?.body as string)).toEqual({ code: "k7qf-2m9x", label: "computer" });
    // The code goes in the body only: never in the address.
    expect(ok.mock.calls[0][0]).not.toContain("k7qf");
  });
  it("names each refusal and stores nothing", async () => {
    const setItem = vi.fn();
    const claim = (status: number, body: unknown) => claimFirstRun("x", "phone", { fetch: f(status, body) as unknown as typeof fetch, storage: { setItem } });
    expect(await claim(403, { error: "wrong-code" })).toEqual({ ok: false, error: "wrong" });
    expect(await claim(410, { error: "pairing code expired or used" })).toEqual({ ok: false, error: "gone" });
    expect(await claim(429, { error: "too-many-tries" })).toEqual({ ok: false, error: "spent" });
    expect(await claim(403, { error: "agent headers are not allowed" })).toEqual({ ok: false, error: "failed" });
    expect(await claim(404, { error: "not found" })).toEqual({ ok: false, error: "failed" });
    expect(await claim(200, { label: "phone" })).toEqual({ ok: false, error: "failed" });
    expect(setItem).not.toHaveBeenCalled();
  });
  it("does not spend the code when the browser cannot keep the token", async () => {
    const ok = f(200, { token: "t", label: "l" });
    expect(await claimFirstRun("x", "phone", { fetch: ok as unknown as typeof fetch, storage: null })).toEqual({ ok: false, error: "storage" });
    expect(ok).not.toHaveBeenCalled();
  });
  it("the claim link: the secret goes in the body as `claim`, never in the address; a wrong link is named", async () => {
    const secret = "A".repeat(43);
    const setItem = vi.fn();
    const ok = f(200, { token: "tok2", label: "mira-laptop" });
    expect(await claimFirstRun(secret, "mira-laptop", { fetch: ok as unknown as typeof fetch, storage: { setItem } }, "claim")).toEqual({ ok: true, label: "mira-laptop" });
    expect(JSON.parse(ok.mock.calls[0][1]?.body as string)).toEqual({ claim: secret, label: "mira-laptop" });
    expect(ok.mock.calls[0][0]).toBe(FIRST_RUN_ROUTE);
    const wrong = f(403, { error: "wrong-link" });
    expect(await claimFirstRun(secret, "x", { fetch: wrong as unknown as typeof fetch, storage: { setItem } }, "claim")).toEqual({ ok: false, error: "wrong" });
  });
  it("reads the secret of a claim link from the fragment, and nothing of another shape", () => {
    const secret = "aZ09_-".repeat(7) + "x";
    expect(linkFromHash(`#k=${secret}`)).toBe(secret);
    expect(linkFromHash(`k=${secret}`)).toBe(secret);
    for (const bad of ["", "#k=", `#k=${secret}x`, `#k=${secret.slice(1)}`, `#code=${secret}`, `#k=${secret}&x=1`, `#k=${secret.slice(1)}+`]) expect([bad, linkFromHash(bad)]).toEqual([bad, ""]);
  });
  it("reads the state of the screen: the link and whether the console is hosted", async () => {
    const st = (status: number, body: unknown) => firstRunState({ fetch: f(status, body) as unknown as typeof fetch });
    expect(await st(200, { locked: true, link: "open", hosted: true })).toEqual({ locked: true, link: "open", hosted: true });
    expect(await st(200, { locked: true })).toEqual({ locked: true, link: "none", hosted: false });
    expect(await st(200, { locked: true, link: "other", hosted: "yes" })).toEqual({ locked: true, link: "none", hosted: false });
    expect(await st(404, {})).toEqual({ locked: false, link: "none", hosted: false });
  });
  it("reads the lock: only a console that says so is locked", async () => {
    const locked = (status: number, body: unknown) => firstRunLocked({ fetch: f(status, body) as unknown as typeof fetch });
    expect(await locked(200, { locked: true })).toBe(true);
    expect(await locked(200, { locked: false })).toBe(false);
    expect(await locked(404, { error: "not found" })).toBe(false); // a console with no such route
  });
  it("a console that got locked while the page was open: the page loads again", async () => {
    const onLocked = vi.fn();
    const refuse = (body: unknown) => chiefFetch("/api/x", undefined, { fetch: (async () => json(403, body)) as unknown as typeof fetch, storage: null, onLocked });
    await refuse({ error: "pair-required", userAuth: "log" });
    await refuse({ error: "pair-required", userAuth: "telegram" });
    expect(onLocked).not.toHaveBeenCalled(); // the answer of every console of today
    await refuse({ error: "pair-required", userAuth: "log", locked: true });
    expect(onLocked).toHaveBeenCalledTimes(1);
    clearPairRequired();
  });
});

describe("pairRequired clearing", () => {
  const refuse = () => chiefFetch("/api/x", undefined, { fetch: (async () => json(403, { error: "pair-required", userAuth: "log" })) as unknown as typeof fetch, storage: null });
  it("a successful claimPairing clears pairRequired and notifies", async () => {
    await refuse();
    expect(getChiefState().pairRequired).toBe(true);
    const cb = vi.fn();
    const off = subscribeChiefState(cb);
    const f = vi.fn(async () => json(200, { token: "t", label: "l" }));
    await claimPairing("abc", { fetch: f as unknown as typeof fetch, storage: { setItem: () => {} } });
    off();
    expect(getChiefState().pairRequired).toBe(false);
    expect(cb).toHaveBeenCalled();
  });
  it("claimPairing with no storage makes no request", async () => {
    const f = vi.fn(async () => json(200, { token: "t" }));
    expect(await claimPairing("abc", { fetch: f as unknown as typeof fetch, storage: null })).toEqual({ ok: false, error: "failed" });
    expect(f).not.toHaveBeenCalled();
  });
  it("a token set by another tab clears pairRequired; other keys do not", async () => {
    await refuse();
    handleStorageEvent({ key: "other", newValue: "x" });
    expect(getChiefState().pairRequired).toBe(true);
    handleStorageEvent({ key: USER_TOKEN_KEY, newValue: null });
    expect(getChiefState().pairRequired).toBe(true);
    handleStorageEvent({ key: USER_TOKEN_KEY, newValue: "tok" });
    expect(getChiefState().pairRequired).toBe(false);
  });
  it("another tab removing the token notifies subscribers (the pairing card returns)", () => {
    const cb = vi.fn();
    const un = subscribeChiefState(cb);
    handleStorageEvent({ key: USER_TOKEN_KEY, newValue: null });
    expect(cb).toHaveBeenCalledTimes(1);
    handleStorageEvent({ key: "other", newValue: null });
    expect(cb).toHaveBeenCalledTimes(1);
    un();
  });
  it("a token arriving while pairRequired is false still notifies subscribers", () => {
    clearPairRequired(); // own setup: no reliance on the order of the tests above
    expect(getChiefState().pairRequired).toBe(false);
    const cb = vi.fn();
    const un = subscribeChiefState(cb);
    handleStorageEvent({ key: USER_TOKEN_KEY, newValue: "tok" });
    expect(cb).toHaveBeenCalledTimes(1);
    un();
  });
  it("isRefusalText matches only the fixed sentences", () => {
    expect(isRefusalText(MISCONFIGURED_TEXT)).toBe(true);
    expect(isRefusalText(pairSentence("telegram"))).toBe(true);
    expect(isRefusalText("nope")).toBe(false);
  });
});

describe("hasUserToken / notifyChiefState", () => {
  it("true only for a stored, well-formed token", () => {
    expect(hasUserToken(store("abc123"))).toBe(true);
    expect(hasUserToken(store(null))).toBe(false);
    expect(hasUserToken(store("bad token\n"))).toBe(false);
    expect(hasUserToken(null)).toBe(false);
  });
  it("notify re-calls subscribers with the current state", () => {
    const cb = vi.fn();
    const off = subscribeChiefState(cb);
    notifyChiefState();
    off();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(getChiefState());
  });
});

describe("opensPairPage (a 401 pair-required of the front proxy)", () => {
  it("opens /pair from the console's pages, never from the pairing screens or a page with a pairing link", () => {
    expect(opensPairPage("/", "", false)).toBe(true);
    expect(opensPairPage("/settings", "#agent=a1&reconcile", false)).toBe(true);
    expect(opensPairPage("/pair", "", false)).toBe(false);
    expect(opensPairPage("/first-run", "#k=x", false)).toBe(false);
    expect(opensPairPage("/", "#pair=abc", false)).toBe(false);
    // The page cleared the hash, the link is still held.
    expect(opensPairPage("/", "", true)).toBe(false);
  });
});

describe("chiefFetch and the front proxy's 401", () => {
  it("calls onUnpaired for 401 pair-required only, and only for the console's own addresses", async () => {
    const seen: string[] = [];
    const f = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    await chiefFetch("/api/x", undefined, { fetch: f(401, { error: "pair-required" }) as unknown as typeof fetch, storage: null, onUnpaired: () => seen.push("a") });
    await chiefFetch("/api/x", undefined, { fetch: f(401, { error: "unauthorized" }) as unknown as typeof fetch, storage: null, onUnpaired: () => seen.push("b") });
    await chiefFetch("/api/x", undefined, { fetch: f(403, { error: "pair-required" }) as unknown as typeof fetch, storage: null, onUnpaired: () => seen.push("c") });
    await chiefFetch("https://other.example/api/x", undefined, { fetch: f(401, { error: "pair-required" }) as unknown as typeof fetch, storage: null, onUnpaired: () => seen.push("d") });
    expect(seen).toEqual(["a"]);
  });
});
