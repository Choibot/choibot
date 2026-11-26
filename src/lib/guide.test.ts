// src/lib/guide.test.ts — the page's side of the guide: the guard of the chat box, the words of
// each state, which card of the thread is live.
import { describe, expect, it } from "vitest";
import { FAKE } from "../../server/guide/testkit";
import type { GuideItem } from "../../server/guide/types";
import {
  BUSY_MAX_MS, cardModes, clockTime, fetchGuide, GUIDE_HINT_KEY, guideClosed, nextParts, offLine, readGuideHint, sendToGuide, sideOf, writeGuideHint,
} from "./guide";
import { setupRows, type SetupAnswer } from "./setup";

type Call = { url: string; body: string };
function fakeFetch(answer: (url: string) => { status: number; json: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const a = answer(url);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { "content-type": "application/json" } });
  }) as never;
  return { f, calls };
}
const VIEW = { items: [], busy: false };

describe("sendToGuide: the guard of the chat box", () => {
  it("a text that looks like a secret does not leave the browser: the server gets the kind only", async () => {
    for (const secret of Object.values(FAKE)) {
      const { f, calls } = fakeFetch(() => ({ status: 200, json: VIEW }));
      const r = await sendToGuide(`ok I have it: ${secret} do I paste it here?`, f);
      expect(r).toMatchObject({ ok: false, line: expect.stringMatching(/was not sent/) });
      expect(calls.map((c) => c.url)).toEqual(["/api/guide/stopped"]);
      // The one request holds the kind and nothing else.
      expect(Object.keys(JSON.parse(calls[0].body))).toEqual(["secret"]);
      const sent = JSON.stringify(calls) + JSON.stringify(r);
      expect(sent).not.toContain(secret);
      expect(sent).not.toContain(secret.slice(0, 12));
      expect(sent).not.toContain("do I paste it here");
    }
  });

  it("says where the secret belongs, also when the server does not answer", async () => {
    const f = (async () => { throw new Error("offline"); }) as never;
    const r = await sendToGuide(FAKE.telegram, f);
    expect(r).toMatchObject({ ok: false, view: null, stopped: { kind: "telegram", step: "telegram" } });
    expect(!r.ok && "line" in r && r.line).toMatch(/Telegram bot token.*not stored.*form of the step “Telegram”/);
  });

  it("sends a normal message, and gives the plain line of a refusal", async () => {
    const ok = fakeFetch(() => ({ status: 202, json: { items: [{ kind: "user", id: "1", ts: 1, text: "hi" }], busy: true } }));
    expect(await sendToGuide("what is a ticket?", ok.f)).toMatchObject({ ok: true, view: { busy: true } });
    expect(ok.calls).toEqual([{ url: "/api/guide/message", body: JSON.stringify({ text: "what is a ticket?" }) }]);
    const busy = fakeFetch(() => ({ status: 409, json: { error: "The guide writes now. Wait a moment." } }));
    expect(await sendToGuide("hi", busy.f)).toEqual({ ok: false, error: "The guide writes now. Wait a moment." });
    const odd = fakeFetch(() => ({ status: 500, json: { error: "ECONNRESET" } }));
    expect(await sendToGuide("hi", odd.f)).toEqual({ ok: false, error: "The console did not answer. Try again." });
  });
});

describe("fetchGuide", () => {
  it("a console with no guide (404) or with no pairing (403) is \"no guide\"; no answer keeps what was known", async () => {
    expect(await fetchGuide({ sync: true }, fakeFetch(() => ({ status: 404, json: {} })).f)).toEqual({ on: false });
    expect(await fetchGuide({}, fakeFetch(() => ({ status: 403, json: { error: "pair-required" } })).f)).toEqual({ on: false });
    expect(await fetchGuide({}, fakeFetch(() => ({ status: 502, json: {} })).f)).toBeNull();
    expect(await fetchGuide({}, (async () => { throw new Error("offline"); }) as never)).toBeNull();
    const sync = fakeFetch(() => ({ status: 200, json: { items: [], busy: false, off: { why: "down", text: "x" } } }));
    expect(await fetchGuide({ sync: true }, sync.f)).toEqual({ on: true, view: { items: [], busy: false, off: { why: "down", text: "x" } } });
    expect(sync.calls[0].url).toBe("/api/guide/sync");
  });
});

describe("the words of a guide that cannot answer", () => {
  const now = new Date(2026, 10, 19, 12, 30).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();

  it("a plan limit says when it ends, when the console knows the time", () => {
    expect(offLine({ why: "limit", text: "", until: at(19, 14, 0) }, now, "en-GB")).toBe("Your Claude plan is at its limit until 14:00.");
    expect(offLine({ why: "limit", text: "", until: at(20, 9, 5) }, now, "en-GB")).toBe("Your Claude plan is at its limit until tomorrow, 09:05.");
    expect(offLine({ why: "limit", text: "", until: at(24, 9, 0) }, now, "en-GB")).toMatch(/^Your Claude plan is at its limit until Tue,? 24 Nov, 09:00\.$/);
  });

  it("with no known time, or a time that is over, it says to try later: never a wait with no end", () => {
    expect(offLine({ why: "limit", text: "" }, now)).toBe("Your Claude plan is at its limit. Try again later.");
    expect(offLine({ why: "limit", text: "", until: now - 1 }, now)).toBe("Your Claude plan is at its limit. Try again later.");
    expect(offLine({ why: "down", text: "" }, now)).toBe("The guide did not answer. Try again later.");
    expect(offLine({ why: "login", text: "" }, now)).toBe("Claude is not logged in on your server.");
    expect(clockTime(at(19, 23, 59), now, "en-GB")).toBe("23:59");
  });

  it("no login and a plan limit close the chat; \"no answer\" keeps it open for a new try", () => {
    expect(guideClosed(undefined)).toBe(false);
    expect(guideClosed({ why: "login", text: "" })).toBe(true);
    expect(guideClosed({ why: "limit", text: "" })).toBe(true);
    expect(guideClosed({ why: "down", text: "" })).toBe(false);
    // The page waits longer than the server's own limit for one answer (90 seconds), and not for ever.
    expect(BUSY_MAX_MS).toBeGreaterThan(90_000);
    expect(BUSY_MAX_MS).toBeLessThanOrEqual(180_000);
  });
});

describe("the thread", () => {
  const item = (o: Record<string, unknown>, n: number) => ({ id: `i${n}`, ts: n, ...o }) as GuideItem;
  const answer = (states: Record<string, string>): SetupAnswer => ({
    checkedAt: 1, home: true,
    steps: Object.entries(states).map(([id, state]) => ({ id, state, title: id, why: "", optional: false, text: `${id} ${state}` })) as never,
  });

  it("one card per step is live: the last one, and only while the step is open", () => {
    const items = [
      item({ kind: "card", step: "github" }, 1), item({ kind: "user", text: "x" }, 2), item({ kind: "card", step: "github" }, 3),
      item({ kind: "card", step: "pair" }, 4), item({ kind: "card", step: "repo" }, 5), item({ kind: "card", step: "telegram" }, 6),
      item({ kind: "card", step: "agent" }, 7),
    ];
    const rows = setupRows(answer({ pair: "done", github: "todo", repo: "blocked", telegram: "todo" }));
    expect(Object.fromEntries(cardModes(items, rows))).toEqual({ i1: "old", i3: "live", i4: "done", i5: "waits", i6: "live", i7: "checking" });
    expect(Object.fromEntries(cardModes(items, setupRows(null)))).toMatchObject({ i1: "old", i3: "checking" });
  });

  it("names who speaks, and finds the head of a \"Next\" line", () => {
    expect(sideOf(item({ kind: "user", text: "x" }, 1))).toBe("you");
    for (const kind of ["guide", "check", "error", "card", "stopped", "note"]) expect(sideOf(item({ kind }, 1))).toBe("guide");
    expect(nextParts("Next: Connect GitHub. Your agents open pull requests.")).toEqual({ head: "Next: Connect GitHub.", rest: "Your agents open pull requests." });
    expect(nextParts("Welcome. Next: x.")).toBeNull();
  });
});

describe("the hint for the first frame", () => {
  it("is one flag: no text of the thread, no text of the box", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
    expect(readGuideHint(store)).toBe(false);
    writeGuideHint(true, store);
    expect([...map]).toEqual([[GUIDE_HINT_KEY, "1"]]);
    expect(readGuideHint(store)).toBe(true);
    writeGuideHint(false, store);
    expect(map.size).toBe(0);
    expect(readGuideHint({ getItem: () => { throw new Error("blocked"); }, setItem: () => {}, removeItem: () => {} })).toBe(false);
  });
});
