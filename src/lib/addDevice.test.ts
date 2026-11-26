// src/lib/addDevice.test.ts — the browser's side of "Add a device": which address cannot work
// for a phone, what the code picture holds, and how the answers of the server read.
import { describe, expect, it, vi } from "vitest";
import {
  ADD_CLAIM_ROUTE, ADD_DEVICE_ROUTE, addedWords, cancelAddCode, claimAddDevice, codeFromHash, countdown, deviceKind, deviceName,
  loopbackHost, mintAddCode, newDevices, pairLink,
} from "./addDevice";
import { USER_TOKEN_KEY } from "./chief";
// The rule of the server for a device name.
import { DEVICE_LABEL_RE } from "../../server/chief/auth";

const json = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("the address of this console", () => {
  it("an address of this computer only cannot work for a phone", () => {
    for (const h of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1", "0.0.0.0"]) expect(loopbackHost(h), h).toBe(true);
  });
  it("a private address, a name of the tailnet and a LAN address can work", () => {
    for (const h of ["console.tail1234.ts.net", "100.64.0.7", "192.168.1.20", "mybox", "localhost.example.com", "1270.0.0.1"]) expect(loopbackHost(h), h).toBe(false);
  });
});

describe("the code picture", () => {
  it("holds the address as the browser sees it, the pairing page, and the code in the fragment", () => {
    const link = pairLink("https://console.tail1234.ts.net", "K7QF-2M9X");
    expect(link).toBe("https://console.tail1234.ts.net/pair#code=K7QF-2M9X");
    const u = new URL(link);
    // What a browser sends to a server: the path and the query. The code is in neither.
    expect(u.pathname + u.search).toBe("/pair");
    expect(codeFromHash(u.hash)).toBe("K7QF-2M9X");
  });
  it("reads only a plain code from a fragment", () => {
    expect(codeFromHash("#code=k7qf-2m9x")).toBe("K7QF-2M9X");
    expect(codeFromHash("code=K7QF2M9X")).toBe("K7QF2M9X");
    for (const h of ["", "#", "#pair=abc", "#code=", "#code=<b>", "#code=K7QF-2M9X&x=1", `#code=${"A".repeat(25)}`]) expect(codeFromHash(h), h).toBe("");
  });
});

describe("the name of a device", () => {
  it("has a default from the device type", () => {
    expect(deviceKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("phone");
    expect(deviceKind("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toBe("phone");
    expect(deviceKind("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)")).toBe("tablet");
    expect(deviceKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("computer");
  });
  it("what a person types becomes a name that the server takes, or nothing", () => {
    expect(deviceName("  My Phone ")).toBe("my-phone");
    expect(deviceName("Ada's iPhone 16!")).toBe("ada-s-iphone-16");
    expect(deviceName("-_x")).toBe("x");
    expect(deviceName("work_laptop")).toBe("work_laptop");
    expect(deviceName("!!!")).toBe("");
    expect(deviceName("x".repeat(40))).toHaveLength(32);
    for (const typed of ["My Phone", "Ada's iPhone 16!", "téléphone", "a".repeat(31) + " b", "  9  "]) expect(deviceName(typed), typed).toMatch(DEVICE_LABEL_RE);
  });
  it("the line of the first device names what was added", () => {
    expect(addedWords("phone")).toBe("Phone added");
    expect(addedWords("phone-2")).toBe("Phone added");
    expect(addedWords("tablet")).toBe("Tablet added");
    expect(addedWords("kitchen-ipad")).toBe("Device added");
    expect(addedWords("phones")).toBe("Device added");
  });
});

describe("what the first device sees", () => {
  it("a device is new when it was not paired at the time of the code", () => {
    const before = [{ label: "computer", createdAt: 1 }, { label: "phone", createdAt: 2 }];
    expect(newDevices(before, before)).toEqual([]);
    expect(newDevices(before, [...before, { label: "phone-2", createdAt: 9 }])).toEqual([{ label: "phone-2", createdAt: 9 }]);
    // The same name paired again is a new device too.
    expect(newDevices(before, [before[0], { label: "phone", createdAt: 9 }])).toEqual([{ label: "phone", createdAt: 9 }]);
    expect(newDevices(before, [before[0]])).toEqual([]);
  });
  it("counts the time left in minutes and seconds", () => {
    expect(countdown(300_000)).toBe("5:00");
    expect(countdown(247_400)).toBe("4:08");
    expect(countdown(900)).toBe("0:01");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(-5)).toBe("0:00");
  });
});

describe("the calls", () => {
  it("asks for a code with a POST, and reads the code and its life", async () => {
    const f = json(200, { code: "K7QF-2M9X", expiresAt: 5, ttlMs: 300_000 });
    expect(await mintAddCode({ fetch: f as unknown as typeof fetch })).toEqual({ ok: true, code: "K7QF-2M9X", ttlMs: 300_000, address: null });
    // The private address of the server comes with the code: an HTTPS origin only.
    const withAddress = (address: unknown) => mintAddCode({ fetch: json(200, { code: "K7QF-2M9X", ttlMs: 300_000, address }) as unknown as typeof fetch });
    expect(await withAddress("https://server.example.ts.net")).toMatchObject({ ok: true, address: "https://server.example.ts.net" });
    for (const bad of ["http://server.example.ts.net", "https://server.example.ts.net/x", "javascript:alert(1)", 7, null]) {
      expect(await withAddress(bad), String(bad)).toMatchObject({ ok: true, address: null });
    }
    expect(f.mock.calls[0]).toEqual([ADD_DEVICE_ROUTE, expect.objectContaining({ method: "POST" })]);
  });
  it("a refusal is a sentence, and an answer with no code is not a code", async () => {
    const refused = await mintAddCode({ fetch: json(403, { error: "pair-required", userAuth: "log" }) as unknown as typeof fetch });
    expect(refused).toEqual({ ok: false, error: expect.stringContaining("Adding a device needs a paired device") });
    expect(await mintAddCode({ fetch: json(200, {}) as unknown as typeof fetch })).toEqual({ ok: false, error: "The console gave no code" });
    const down = vi.fn(async () => { throw new Error("down"); });
    expect(await mintAddCode({ fetch: down as unknown as typeof fetch })).toEqual({ ok: false, error: "The console did not answer" });
    await expect(cancelAddCode({ fetch: down as unknown as typeof fetch })).resolves.toBeUndefined();
  });
  it("the claim sends the code in the body, keeps the token, and reads each refusal", async () => {
    const setItem = vi.fn();
    const ok = json(200, { token: "tok", label: "phone-2" });
    expect(await claimAddDevice("K7QF-2M9X", "phone", { fetch: ok as unknown as typeof fetch, storage: { setItem } })).toEqual({ ok: true, label: "phone-2" });
    expect(ok.mock.calls[0][0]).toBe(ADD_CLAIM_ROUTE);
    expect(JSON.parse((ok.mock.calls[0][1] as RequestInit).body as string)).toEqual({ code: "K7QF-2M9X", label: "phone" });
    expect(setItem).toHaveBeenCalledWith(USER_TOKEN_KEY, "tok");
    setItem.mockClear();
    const claim = (status: number, body: unknown = {}) => claimAddDevice("x", "phone", { fetch: json(status, body) as unknown as typeof fetch, storage: { setItem } });
    expect(await claim(403, { error: "wrong-code" })).toEqual({ ok: false, error: "wrong" });
    expect(await claim(410)).toEqual({ ok: false, error: "gone" });
    expect(await claim(429)).toEqual({ ok: false, error: "spent" });
    expect(await claim(404)).toEqual({ ok: false, error: "off" });
    expect(await claim(400)).toEqual({ ok: false, error: "name" });
    expect(await claim(500)).toEqual({ ok: false, error: "failed" });
    expect(await claim(200, {})).toEqual({ ok: false, error: "failed" });
    expect(setItem).not.toHaveBeenCalled();
    // A browser that cannot keep the token does not spend the code.
    const never = json(200, { token: "tok" });
    expect(await claimAddDevice("x", "phone", { fetch: never as unknown as typeof fetch, storage: null })).toEqual({ ok: false, error: "storage" });
    expect(never).not.toHaveBeenCalled();
  });
});
