import { queueCounts } from "../../server/chief/queue/api";
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import {
  answer, delivery, fetchQueue, loadRetryDelay, metricsLine, pairingText, latestUndoable, mergeTicket, openLink, previewSrc, readMerge,
  saveMergeMethod, savedMergeMethod, sections, snooze, undo, upsertItem, withdraw, type QueueResponse,
} from "./queue";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const NOW = 10_000_000_000;
const MIN = 60_000;
function item(p: Partial<QueueItem> & { id: string }): QueueItem {
  return {
    kind: "choice", agentId: "a1", createdBy: { agentId: "a1", kind: "worker" }, repo: "r", area: "x",
    title: "t", body: "", createdAt: NOW - 5 * MIN, updatedAt: NOW - 5 * MIN, status: "open", blocking: true,
    history: [], answerSeq: 0, ...p,
  };
}
const ans = (at: number, value = "A") => ({ value, by: "user" as const, via: "tab" as const, at });
const DATA: QueueResponse = {
  items: [], counts: { open: 7, auto: 0, undelivered: 0 }, metrics: { week: { decisions: 14, corrections: 3 } },
  serverNow: 5, undoMs: 600_000, hardened: false, userAuth: "log",
};

describe("fetchQueue", () => {
  it("requests status=all and returns on", async () => {
    const f = vi.fn(async (_u: string) => json(200, DATA));
    expect(await fetchQueue({ fetch: f as unknown as typeof fetch })).toEqual({ state: "on", data: DATA });
    expect(f.mock.calls[0][0]).toBe("/api/queue?status=all");
  });
  it("404 -> off, 503 -> misconfigured", async () => {
    expect(await fetchQueue({ fetch: (async () => json(404, {})) as unknown as typeof fetch })).toEqual({ state: "off" });
    expect(await fetchQueue({ fetch: (async () => json(503, { error: "chief-misconfigured" })) as unknown as typeof fetch })).toEqual({ state: "misconfigured" });
  });
});

describe("fetchQueue failures", () => {
  it("rejects on a 500, a network error and bad JSON", async () => {
    await expect(fetchQueue({ fetch: (async () => json(500, {})) as unknown as typeof fetch })).rejects.toThrow();
    await expect(fetchQueue({ fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).rejects.toThrow("down");
    await expect(fetchQueue({ fetch: (async () => new Response("{nope", { status: 200 })) as unknown as typeof fetch })).rejects.toThrow();
  });
  it("sends x-choibot-user from storage", async () => {
    const tok = "a".repeat(43);
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, DATA));
    await fetchQueue({ fetch: f as unknown as typeof fetch, storage: { getItem: () => tok } });
    expect(new Headers(f.mock.calls[0][1]?.headers).get("x-choibot-user")).toBe(tok);
  });
});

describe("upsertItem", () => {
  it("replaces by id and appends new", () => {
    const a = item({ id: "qa" }), b = item({ id: "qb" });
    const a2 = item({ id: "qa", title: "new" });
    expect(upsertItem([a, b], a2)).toEqual([a2, b]);
    expect(upsertItem([a], b)).toEqual([a, b]);
  });
});

describe("sections", () => {
  it("failed slot goes to undelivered, unless the item is withdrawn agent-gone", () => {
    const f = item({ id: "qf", status: "answered", answer: ans(NOW), delivery: { msgId: "m", state: "failed", attempts: 3 } });
    const u = item({ id: "qu", status: "answered", answer: ans(NOW), withdrawal: { msgId: "w", state: "unknown", attempts: 1 } });
    const g = item({ id: "qg", status: "withdrawn", lastError: "agent-gone", closedAt: NOW, withdrawal: { msgId: "w", state: "failed", attempts: 1, lastError: "agent-gone" } });
    const s = sections([f, u, g], NOW);
    expect(s.undelivered.map((i) => i.id).sort()).toEqual(["qf", "qu"]);
    expect(s.open).toEqual([]);
  });
  it("final fix wave, minor 4: a stuck withdrawal on an item withdrawn otherwise (merged, closed, by its agent) stays in Undelivered", () => {
    const stuck = { msgId: "w", state: "failed" as const, attempts: 1, lastError: "not-live" };
    const m = item({ id: "qm", status: "withdrawn", lastError: "merged", closedAt: NOW, withdrawal: stuck });
    const c = item({ id: "qc", status: "withdrawn", lastError: "closed", closedAt: NOW, withdrawal: { ...stuck, state: "unknown" } });
    const a = item({ id: "qa", status: "withdrawn", closedAt: NOW, withdrawal: stuck });
    const g = item({ id: "qg", status: "withdrawn", lastError: "agent-gone", closedAt: NOW, withdrawal: stuck });
    const s = sections([m, c, a, g], NOW);
    expect(s.undelivered.map((i) => i.id).sort()).toEqual(["qa", "qc", "qm"]);
    expect(queueCounts([m, c, a, g], NOW).undelivered).toBe(3);
  });
  it("decision 60: the merged notice of a pr item that waits for its agent (not-live) is not undelivered; any other stuck notice is", () => {
    const notice = (id: string, slot: object) => item({ id, kind: "pr", status: "withdrawn", lastError: "merged", closedAt: NOW,
      delivery: { msgId: `${id}-m`, attempts: 1, ...slot } as never });
    const waits = notice("qw", { state: "failed", lastError: "not-live" });
    const unknown = notice("qk", { state: "unknown", lastError: "EIO" });
    const failed = notice("qx", { state: "failed", lastError: "bad msgId" });
    const both = { ...notice("qb", { state: "failed", lastError: "not-live" }), withdrawal: { msgId: "qb-w1", state: "failed" as const, attempts: 1 } };
    const s = sections([waits, unknown, failed, both], NOW);
    expect(s.undelivered.map((i) => i.id).sort()).toEqual(["qb", "qk", "qx"]);
    expect(queueCounts([waits, unknown, failed, both], NOW).undelivered).toBe(3);
    // A user answer that waits for its agent still shows: the user must know it did not arrive.
    const answer = item({ id: "qa", status: "answered", answer: ans(NOW), delivery: { msgId: "qa-1", state: "failed", attempts: 1, lastError: "not-live" } });
    expect(sections([answer], NOW).undelivered).toEqual([answer]);
  });
  it("agent-gone closed 2h ago is in gone only; 25h ago is nowhere", () => {
    const g2 = item({ id: "q2", status: "withdrawn", lastError: "agent-gone", closedAt: NOW - 2 * 60 * MIN });
    const g25 = item({ id: "q25", status: "withdrawn", lastError: "agent-gone", closedAt: NOW - 25 * 60 * MIN });
    const s = sections([g2, g25], NOW);
    expect(s.gone.map((i) => i.id)).toEqual(["q2"]);
    expect([...s.open, ...s.undelivered, ...s.auto].length).toBe(0);
  });
  it("a withdrawn item without agent-gone is not in gone; an unknown answer slot is undelivered", () => {
    const w = item({ id: "qw", status: "withdrawn", lastError: "merged", closedAt: NOW });
    const u = item({ id: "qu", status: "answered", answer: ans(NOW), delivery: { msgId: "m", state: "unknown", attempts: 1 } });
    const s = sections([w, u], NOW);
    expect(s.gone).toEqual([]);
    expect(s.undelivered.map((i) => i.id)).toEqual(["qu"]);
  });
  it("server queueCounts equals the section lengths (parity)", () => {
    const items = [
      item({ id: "q1" }), item({ id: "q2", kind: "pr", blocking: false }),
      item({ id: "q3", status: "snoozed", snoozedUntil: NOW - 1 }), item({ id: "q4", status: "snoozed", snoozedUntil: NOW + MIN }),
      item({ id: "q5", status: "auto", answer: { ...ans(NOW - 5 * MIN), by: "master" } }),
      item({ id: "q6", status: "auto", answer: { ...ans(NOW - 10 * MIN), by: "master" } }),
      item({ id: "q7", status: "auto", updatedAt: NOW }),
      item({ id: "q8", status: "answered", answer: ans(NOW), delivery: { msgId: "m", state: "failed", attempts: 3 } }),
      item({ id: "q9", status: "withdrawn", withdrawal: { msgId: "w", state: "failed", attempts: 3 } }),
      item({ id: "q10", status: "withdrawn", lastError: "merged", closedAt: NOW, withdrawal: { msgId: "w", state: "unknown", attempts: 1 } }),
      item({ id: "q11", status: "withdrawn", lastError: "agent-gone", closedAt: NOW, withdrawal: { msgId: "w", state: "failed", attempts: 1 } }),
    ];
    const s = sections(items, NOW);
    expect(queueCounts(items, NOW)).toEqual({ open: s.open.length, undelivered: s.undelivered.length, auto: s.auto.length });
    expect(s.undelivered.map((i) => i.id).sort()).toEqual(["q10", "q8", "q9"]);
  });
  it("open is sorted; auto is the last 10 min only", () => {
    const lo = item({ id: "qlo", kind: "preview", blocking: false });
    const hi = item({ id: "qhi", kind: "question" });
    const a1 = item({ id: "qa1", status: "auto", answer: { ...ans(NOW - 5 * MIN), by: "master" } });
    const a2 = item({ id: "qa2", status: "auto", answer: { ...ans(NOW - 11 * MIN), by: "master" } });
    const s = sections([lo, hi, a1, a2], NOW);
    expect(s.open.map((i) => i.id)).toEqual(["qhi", "qlo"]);
    expect(s.auto.map((i) => i.id)).toEqual(["qa1"]);
  });
});

describe("latestUndoable", () => {
  const U = 10 * MIN;
  it("picks the newest answer inside the window", () => {
    const old = item({ id: "qo", status: "answered", answer: ans(NOW - 20 * MIN) });
    const a = item({ id: "qa", status: "answered", answer: ans(NOW - 5 * MIN) });
    const b = item({ id: "qb", status: "auto", answer: ans(NOW - 2 * MIN) });
    expect(latestUndoable([old, a, b], NOW, U)?.id).toBe("qb");
    expect(latestUndoable([old], NOW, U)).toBeNull();
  });
  it("ignores withdrawn and open items", () => {
    const w = item({ id: "qw", status: "withdrawn", answer: ans(NOW - MIN) });
    const o = item({ id: "qo", status: "open", answer: ans(NOW - MIN) });
    expect(latestUndoable([w, o], NOW, U)).toBeNull();
  });
});

describe("auto section and previews", () => {
  const U = 10 * MIN;
  it("latestUndoable returns an auto item inside the window", () => {
    const a = item({ id: "qa", status: "auto", answer: { value: "B", by: "master", via: "tab", at: NOW - 3 * MIN } });
    expect(latestUndoable([a], NOW, U)?.id).toBe("qa");
  });
  it("sections.auto drops an auto item older than 10 min", () => {
    const by = "master" as const;
    const fresh = item({ id: "qf", status: "auto", answer: { value: "B", by, via: "tab", at: NOW - 9 * MIN } });
    const old = item({ id: "qo", status: "auto", answer: { value: "B", by, via: "tab", at: NOW - 11 * MIN } });
    expect(sections([fresh, old], NOW).auto.map((i) => i.id)).toEqual(["qf"]);
  });
  it("previewSrc encodes the id and name", () => {
    expect(previewSrc(item({ id: "q7k2" }), "1.png")).toBe("/api/queue/q7k2/media/1.png");
    expect(previewSrc(item({ id: "a/b" }), "x y#.png")).toBe("/api/queue/a%2Fb/media/x%20y%23.png");
  });
});

// The header's counts ("4 open · 2 block an agent") are countsLine in lib/queueInbox; the week
// metrics have their own line.
describe("metrics", () => {
  it("the metrics line with no decision", () => {
    expect(metricsLine({ ...DATA, metrics: { week: { decisions: 0, corrections: 0 } } })).toBe("This week: 0 decisions · 0 corrections · 0%");
  });
});

describe("empty/pairing text", () => {
  it("metrics line", () => expect(metricsLine(DATA)).toBe("This week: 14 decisions · 3 corrections · 21%"));
  it("pairing text per userAuth", () => {
    expect(pairingText("telegram")).toBe("Pair this device — send `/pair <label>` in the Telegram Master topic and open the link the bot sends you privately. Items stay visible read-only below.");
    expect(pairingText("log")).toBe("Pair this device — on a paired device, open Settings, Devices and press “Add a device”. With no paired device, run `pnpm choibot brain pair <label>` on your server. Items stay visible read-only below.");
    expect(pairingText(null)).toBe(pairingText("telegram"));
  });
});

describe("openLink", () => {
  it("refuses non-http(s)", () => {
    const open = vi.fn();
    expect(openLink("javascript:alert(1)", { open })).toBe(false);
    expect(openLink("not a url", { open })).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("opens http(s) with noopener,noreferrer", () => {
    const open = vi.fn();
    expect(openLink("https://x", { open })).toBe(true);
    expect(open).toHaveBeenCalledWith("https://x/", "_blank", "noopener,noreferrer");
  });
});

describe("actions", () => {
  it("answer success returns the item", async () => {
    const it1 = item({ id: "qa" });
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, it1));
    const r = await answer("qa", { value: "A" }, { fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true, item: it1 });
    expect(f.mock.calls[0][0]).toBe("/api/queue/qa/answer");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ value: "A" });
  });
  it("409 returns the current item so the caller can upsert (Review Focus 5)", async () => {
    const cur = item({ id: "qa", status: "answered", answer: ans(NOW) });
    const f = async () => json(409, { error: "already answered", item: cur });
    const r = await answer("qa", { value: "A" }, { fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, status: 409, item: cur, error: "already answered" });
    expect(upsertItem([item({ id: "qa" })], (r as { item: QueueItem }).item)[0]).toEqual(cur);
  });
  it("network error -> status 0", async () => {
    const r = await undo("qa", { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, status: 0, error: "down" });
  });
  it("snooze, withdraw, delivery post to their routes", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json(200, item({ id: "qa" })));
    const d = { fetch: f as unknown as typeof fetch };
    await snooze("qa", 30, d);
    await withdraw("qa", d);
    await delivery("qa", "resend", "withdrawal", d);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["/api/queue/qa/snooze", "/api/queue/qa/withdraw", "/api/queue/qa/delivery"]);
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ minutes: 30 });
    expect(JSON.parse(String(f.mock.calls[2][1]?.body))).toEqual({ action: "resend", slot: "withdrawal" });
  });
});

// Final fix wave, minor 8: the first fetch is retried while the view is "loading".
describe("loadRetryDelay", () => {
  it("2 s, 5 s, 15 s, then every 60 s", () => {
    expect([0, 1, 2, 3, 4, 50].map(loadRetryDelay)).toEqual([2_000, 5_000, 15_000, 60_000, 60_000, 60_000]);
  });
});

// The Merge button's two calls (server/chief/queue/merge.ts) and its remembered method.
describe("readMerge / mergeTicket", () => {
  const FACTS = { number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", draft: false, mergeable: "MERGEABLE", base: "main",
    checks: { total: 1, passed: 0, failed: 1, pending: 0, rollup: "failure" } };
  it("GET reads the facts; POST sends the method and checks: accept only when asked", async () => {
    const f = vi.fn(async (_u: string, i?: RequestInit) => (i?.method === "POST"
      ? json(200, { merged: true, item: item({ id: "q1", status: "withdrawn", lastError: "merged" }) })
      : json(200, { facts: FACTS, blocked: null, checks: "Checks: 1 failing." })));
    const deps = { fetch: f as unknown as typeof fetch, storage: { getItem: () => "t".repeat(43) } };
    expect(await readMerge("q1", deps)).toEqual({ ok: true, view: { facts: FACTS, blocked: null, checks: "Checks: 1 failing." } });
    expect(f.mock.calls[0][0]).toBe("/api/queue/q1/merge");
    const sha = "a".repeat(40);
    const r = await mergeTicket("q1", "rebase", sha, true, deps);
    expect(r).toMatchObject({ ok: true, item: { id: "q1", status: "withdrawn" } });
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ method: "rebase", head: sha, checks: "accept" });
    await mergeTicket("q1", "squash", sha, false, deps);
    expect(JSON.parse(String(f.mock.calls[2][1]?.body))).toEqual({ method: "squash", head: sha });
    expect(new Headers(f.mock.calls[1][1]?.headers).get("x-choibot-user")).toBe("t".repeat(43));
  });
  it("a refusal keeps its reason and text; pair-required becomes the pairing sentence", async () => {
    const no = (status: number, body: unknown) => ({ fetch: (async () => json(status, body)) as unknown as typeof fetch });
    expect(await mergeTicket("q1", "squash", "a".repeat(40), false, no(409, { error: "Checks: 1 failing.", reason: "checks", checks: "Checks: 1 failing." })))
      .toEqual({ ok: false, status: 409, error: "Checks: 1 failing.", reason: "checks", checks: "Checks: 1 failing." });
    expect(await mergeTicket("q1", "squash", "a".repeat(40), false, no(405, { error: "GraphQL: Base branch was modified", reason: "github" })))
      .toMatchObject({ ok: false, error: "GraphQL: Base branch was modified", reason: "github" });
    const pair = await mergeTicket("q1", "squash", "a".repeat(40), false, no(403, { error: "pair-required", userAuth: "log" }));
    expect(await readMerge("q1", no(409, { error: "GitHub gives o/x#1 for this ticket's o/r#12. Merge is off.", reason: "mismatch" })))
      .toEqual({ ok: false, status: 409, error: "GitHub gives o/x#1 for this ticket's o/r#12. Merge is off.", reason: "mismatch" });
    expect(pair).toMatchObject({ ok: false, status: 403 });
    expect(pair.ok ? "" : pair.error).toMatch(/^Merge needs a paired device/);
    expect(await readMerge("q1", { fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch })).toEqual({ ok: false, status: 0, error: "down" });
  });
  it("the method is remembered per repo; squash by default and for a bad value", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    expect(savedMergeMethod("o/r", store)).toBe("squash");
    saveMergeMethod("o/r", "rebase", store);
    expect(savedMergeMethod("o/r", store)).toBe("rebase");
    expect(savedMergeMethod("o/other", store)).toBe("squash");
    mem.set("choibot.mergeMethod.o/r", "octopus");
    expect(savedMergeMethod("o/r", store)).toBe("squash");
    expect(savedMergeMethod("o/r", { getItem: () => { throw new Error("blocked"); } })).toBe("squash");
  });
});
