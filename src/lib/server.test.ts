import { describe, expect, it } from "vitest";
import { ago, fetchHealth, fetchLevel, fullTone, linePath, nearest, placeWords, seriesOf } from "./server";

const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as never;

describe("the Server page's data", () => {
  it("reads the health, and says when the browser is not a paired device", async () => {
    expect(await fetchHealth({ fetch: res(200, { level: "ok" }) })).toEqual({ ok: true, view: { level: "ok" } });
    expect(await fetchHealth({ fetch: res(403, { error: "pair-required" }) })).toEqual({ ok: false, why: "needs-pairing" });
    expect(await fetchHealth({ fetch: res(500, {}) })).toEqual({ ok: false, why: "failed" });
    expect(await fetchHealth({ fetch: (async () => { throw new Error("offline"); }) as never })).toEqual({ ok: false, why: "failed" });
  });

  it("reads the level of the sidebar dot, or nothing", async () => {
    expect(await fetchLevel({ fetch: res(200, { level: "warn" }) })).toBe("warn");
    expect(await fetchLevel({ fetch: res(200, { level: "purple" }) })).toBeNull();
    expect(await fetchLevel({ fetch: res(403, {}) })).toBeNull();
  });

  it("colours a bar only from a limit", () => {
    expect([fullTone(50, 85, 95), fullTone(85, 85, 95), fullTone(96, 85, 95), fullTone(99, 90)]).toEqual(["ok", "warn", "err", "warn"]);
  });

  it("draws the last hour from the samples and the last day from the 5-minute means", () => {
    const now = 100 * 3_600_000;
    const h = {
      fine: [[now - 30_000, 40, 60, 0], [now - 15_000, 50, 61, 0]] as never, coarse: [[now - 25 * 3_600_000, 1, 1, 0], [now - 3_600_000, 20, 55, 0]] as never,
      fineStepMs: 15_000, coarseStepMs: 300_000,
    };
    expect(seriesOf(h, "hour", 1, now)).toEqual({ points: [[now - 30_000, 40], [now - 15_000, 50]], from: now - 3_600_000, to: now });
    expect(seriesOf(h, "day", 2, now).points).toEqual([[now - 3_600_000, 55], [now - 15_000, 61]]);
  });

  it("breaks the line where no data is, and finds the point under the pointer", () => {
    const s = { points: [[0, 0], [10, 50], [20, 100], [80, 50], [100, 150]] as [number, number][], from: 0, to: 100 };
    expect(linePath(s, 200, 100, 30)).toBe("M0.0 100.0L20.0 50.0L40.0 0.0M160.0 50.0L200.0 0.0");
    expect(linePath({ points: [], from: 0, to: 1 }, 10, 10, 1)).toBe("");
    expect(nearest(s, 70)).toEqual([80, 50]);
    expect(nearest({ points: [], from: 0, to: 1 }, 0)).toBeNull();
  });

  it("words a time and a place", () => {
    expect([ago(0, 20_000), ago(0, 60_000), ago(0, 5 * 60_000), ago(0, 3 * 3_600_000)]).toEqual(["just now", "1 minute ago", "5 minutes ago", "3 hours ago"]);
    const MB = 1024 * 1024;
    const base = { id: "x", bytes: 1, workDisk: true, parts: [{ name: "installed parts", bytes: 900 * MB }] };
    expect(placeWords({ ...base, kind: "repo", name: "shop" })).toEqual({ name: "shop", note: "Repo · installed parts 900 MB" });
    expect(placeWords({ ...base, kind: "agent", name: "Fix the login", repo: "shop", parts: [] })).toEqual({ name: "Fix the login", note: "Agent · its own copy of shop" });
    expect(placeWords({ ...base, kind: "closed", name: "agent-old", repo: "shop", parts: [] }).note).toBe("A copy of shop that no agent uses");
    expect(placeWords({ ...base, kind: "downloads", name: "Downloads", parts: [] }).note).toBe("");
  });
});
