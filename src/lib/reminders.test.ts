import { describe, it, expect, vi } from "vitest";
import { badgeLabel, badgeTitle, cancelAllowed, cancelReminder, fetchReminders, nextByAgent, remindersEnabled, type ReminderRow } from "./reminders";
import { chiefFetch, clearPairRequired, USER_TOKEN_KEY } from "./chief";

const deps = (res: Response) => ({ fetch: vi.fn(async () => res) as unknown as typeof fetch, storage: null });
const M = 60_000, H = 60 * M, D = 24 * H;
const row = (o: Partial<ReminderRow>): ReminderRow => ({ id: "r_aaaaaaa1", agentId: "a1", dueAt: 10 * D, text: "t", state: "open", ...o });

describe("fetchReminders", () => {
  it("404 (flag off) and 503 (misconfigured) are off: no badge", async () => {
    expect(await fetchReminders(deps(new Response("<html>", { status: 404 })))).toEqual({ state: "off" });
    expect(await fetchReminders(deps(new Response('{"error":"chief-misconfigured"}', { status: 503 })))).toEqual({ state: "off" });
  });
  it("200 gives the open reminders and the server clock", async () => {
    const f = deps(new Response(JSON.stringify({ reminders: [row({})], serverNow: 7 }), { status: 200 }));
    expect(await fetchReminders(f)).toEqual({ state: "on", reminders: [row({})], serverNow: 7 });
    expect((f.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe("/api/reminders");
  });
  it("throws on other errors (the caller keeps its last list)", async () => {
    await expect(fetchReminders(deps(new Response("", { status: 500 })))).rejects.toThrow("reminders: 500");
  });
});

describe("remindersEnabled", () => {
  it("only while the chief queue is on: flag off, loading or misconfigured send no request", () => {
    expect(remindersEnabled("on")).toBe(true);
    for (const v of ["off", "loading", "misconfigured"] as const) expect(remindersEnabled(v)).toBe(false);
  });
});

describe("nextByAgent", () => {
  it("keeps each agent's earliest open reminder and counts the rest", () => {
    const m = nextByAgent([
      row({ id: "r_1", dueAt: 5 * D, text: "later" }), row({ id: "r_2", dueAt: 2 * D, text: "soon" }),
      row({ id: "r_3", agentId: "a2", dueAt: D, state: "delivering" }),
      row({ id: "r_4", agentId: "a3", state: "delivered" }), row({ id: "r_5", agentId: "a3", state: "cancelled" }),
    ]);
    expect(m).toEqual({ a1: { id: "r_2", dueAt: 2 * D, text: "soon", count: 2 }, a2: { id: "r_3", dueAt: D, text: "t", count: 1 } });
  });
});

describe("badgeLabel", () => {
  it("days from about 1 day on, then hours, then minutes, each rounded to the nearest", () => {
    expect(badgeLabel(3 * D - 5_000, 0)).toBe("3d"); // a 3d reminder a few seconds after it was set
    expect(badgeLabel(2 * D + 5 * H, 0)).toBe("2d");
    expect(badgeLabel(D + 13 * H, 0)).toBe("2d");
    expect(badgeLabel(D, 0)).toBe("1d");
    expect(badgeLabel(D - 20 * M, 0)).toBe("1d");
    expect(badgeLabel(23 * H, 0)).toBe("23h");
    expect(badgeLabel(H, 0)).toBe("1h");
    expect(badgeLabel(59 * M + 40_000, 0)).toBe("1h");
    expect(badgeLabel(59 * M + 1, 0)).toBe("59m");
    expect(badgeLabel(40 * M, 0)).toBe("40m");
    expect(badgeLabel(1, 0)).toBe("1m");
  });
  it("a due one waiting for its agent reads now", () => {
    expect(badgeLabel(0, 0)).toBe("now");
    expect(badgeLabel(5, 10)).toBe("now");
  });
});

describe("badgeTitle", () => {
  it("is the text, plus how many more are open", () => {
    expect(badgeTitle({ id: "r_1", dueAt: 2 * D, text: "check the canary", count: 1 }, 0)).toBe("Reminder in 2d: check the canary");
    expect(badgeTitle({ id: "r_1", dueAt: 0, text: "x", count: 3 }, 0)).toBe("Reminder due now: x (+2 more)");
  });
});

describe("cancelReminder (the badge's ×, as the paired user)", () => {
  const token = { getItem: (k: string) => (k === USER_TOKEN_KEY ? "tok-123" : null) };
  const call = (res: Response | Error) => {
    const fetch = vi.fn(async () => { if (res instanceof Error) throw res; return res; });
    return { fetch, deps: { fetch: fetch as unknown as typeof globalThis.fetch, storage: token } };
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("POSTs the cancel route with the user token; 200 is ok", async () => {
    const t = call(json(200, { id: "r_aaaaaaa1", state: "cancelled" }));
    expect(await cancelReminder("r_aaaaaaa1", t.deps)).toEqual({ ok: true });
    const [url, init] = t.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/reminders/r_aaaaaaa1/cancel");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-choibot-user")).toBe("tok-123");
  });

  it("a refusal gives the line the rail shows: pair sentence, the server's 409 reason, gone, or a fixed failure", async () => {
    try {
      expect(await cancelReminder("r_aaaaaaa1", call(json(403, { error: "pair-required", userAuth: "log" })).deps))
        .toEqual({ ok: false, text: "Cancelling a reminder needs a paired device. On a paired device: Settings, Devices, “Add a device”. With no paired device: run `pnpm choibot brain pair <label>` on your server" });
    } finally { clearPairRequired(); }
    expect(await cancelReminder("r_aaaaaaa1", call(json(409, { error: "being delivered; try again in a few minutes" })).deps))
      .toEqual({ ok: false, text: "Not cancelled: being delivered; try again in a few minutes" });
    expect(await cancelReminder("r_aaaaaaa1", call(json(404, { error: "not found" })).deps))
      .toEqual({ ok: false, text: "Not cancelled: the reminder is gone" });
    for (const r of [json(500, { error: "internal error" }), new Error("offline")]) {
      expect(await cancelReminder("r_aaaaaaa1", call(r).deps)).toEqual({ ok: false, text: "Cancel failed — try again" });
    }
  });
});

describe("cancelAllowed (the × shows only on a paired device)", () => {
  it("needs a stored user token and no pair-required answer since", async () => {
    const tok = { getItem: () => "tok-123" };
    expect(cancelAllowed({ getItem: () => null })).toBe(false);
    expect(cancelAllowed(tok)).toBe(true);
    try {
      await chiefFetch("/api/x", undefined, { fetch: (async () => new Response(JSON.stringify({ error: "pair-required" }), { status: 403 })) as unknown as typeof fetch, storage: tok });
      expect(cancelAllowed(tok)).toBe(false);
    } finally { clearPairRequired(); }
    expect(cancelAllowed(tok)).toBe(true);
  });
});
