import { describe, expect, it } from "vitest";
import { ageWord, aiLine, confirmAllLine, confirmLine, fetchAudit, headLine, removable, removeAllSafe, removeRow, rowsOf, startAudit, sum, sureWord, type Row } from "./serverAudit";

const res = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as never;
const GB = 1024 ** 3;
const row = (id: string, group: Row["group"], bytes: number): Row => ({ id, where: `~/${id}`, kind: "build-output", group, bytes, ageDays: 3, what: "x", effect: "y", sure: "high", notes: [], byAi: false });

describe("the Clean-up tab's data", () => {
  it("reads the audit and words a refusal", async () => {
    expect(await fetchAudit({ fetch: res(200, { state: "none" }) })).toEqual({ ok: true, view: { state: "none" } });
    expect(await fetchAudit({ fetch: res(403, { error: "pair-required" }) })).toMatchObject({ ok: false, text: expect.stringContaining("paired device") });
    expect(await fetchAudit({ fetch: res(403, { error: "needs-pairing", text: "Pair a device first." }) })).toEqual({ ok: false, text: "Pair a device first." });
    expect(await fetchAudit({ fetch: (async () => { throw new Error("offline"); }) as never })).toEqual({ ok: false, text: "Your server did not answer." });
  });

  it("starts an audit; one that runs already is no error", async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetch = (async (_u: string, init?: RequestInit) => { calls.push(init); return new Response("{}", { status: 202 }); }) as never;
    expect(await startAudit({ fetch })).toEqual({ ok: true });
    expect(calls[0]).toEqual({ method: "POST" });
    expect(await startAudit({ fetch: res(409, { error: "busy" }) })).toEqual({ ok: true });
    expect(await startAudit({ fetch: res(403, { error: "pair-required" }) })).toMatchObject({ ok: false });
  });

  it("removes a row by its id and the time of the result, never by a path", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetch = (async (u: string, init?: RequestInit) => { calls.push([u, init]); return new Response("{}", { status: 202 }); }) as never;
    expect(await removeRow("c3", 4242, { fetch })).toEqual({ ok: true });
    expect(await removeAllSafe(4242, { fetch })).toEqual({ ok: true });
    expect(calls.map((c) => [c[0], c[1]?.method, c[1]?.body])).toEqual([
      ["/api/server/audit/remove", "POST", JSON.stringify({ id: "c3", checkedAt: 4242 })],
      ["/api/server/audit/remove", "POST", JSON.stringify({ all: "safe", checkedAt: 4242 })],
    ]);
    expect(await removeRow("c3", 1, { fetch: res(409, { error: "not-removed", text: "An agent uses this copy now: it is not removed." }) })).toEqual({ ok: false, text: "An agent uses this copy now: it is not removed." });
  });

  it("the confirm says what goes, its size and what happens after; a check-first row says more", () => {
    const safe = { ...row("a", "safe", 3 * GB), what: "A build output of the repo shop.", effect: "The next build makes it again." };
    expect(confirmLine(safe)).toBe("Remove for good: A build output of the repo shop (3.0 GB)? The next build makes it again.");
    expect(confirmLine({ ...safe, group: "check" })).toBe("This cannot be undone, and the audit cannot know if you need it. Remove for good: A build output of the repo shop (3.0 GB)? The next build makes it again.");
    const rows = [safe, row("b", "safe", 2 * GB), { ...row("c", "safe", 9 * GB), noRemove: "This page does not remove it." }];
    expect(removable(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(confirmAllLine(rows)).toBe("Remove 2 things (5.0 GB) for good? A tool makes each of them again. It stops at the first one that cannot be removed.");
    expect(headLine({ safeBytes: 0, checkBytes: 0, rows: [], freedCount: 2 })).toBe("You removed everything of the list.");
  });

  it("words the total from the server's own sums", () => {
    const rows = [row("a", "safe", 3 * GB), row("b", "check", 2 * GB)];
    expect(headLine({ safeBytes: 3 * GB, checkBytes: 2 * GB, rows })).toBe("You can free about 3.0 GB. 2.0 GB more can come back after you check.");
    expect(headLine({ safeBytes: 3 * GB, checkBytes: 0, rows })).toBe("You can free about 3.0 GB.");
    expect(headLine({ safeBytes: 0, checkBytes: 2 * GB, rows })).toBe("Nothing is safe to remove with no check. 2.0 GB can come back after you check.");
    expect(headLine({ safeBytes: 0, checkBytes: 0, rows: [] })).toBe("The audit found nothing big to remove.");
    expect([rowsOf(rows, "safe").map((r) => r.id), sum(rows)]).toEqual([["a"], 5 * GB]);
  });

  it("says why the AI part did not run, and words the age and the confidence", () => {
    expect(aiLine("ok")).toBeNull();
    expect(aiLine("limit")).toBe("The AI part did not run: your Claude plan is at its limit. The list is complete; its words are the fixed ones.");
    expect(aiLine("login")).toContain("not logged in");
    expect(aiLine("down")).toContain("gave no answer");
    expect([ageWord(null), ageWord(0), ageWord(1), ageWord(40)]).toEqual(["", "changed today", "changed 1 day ago", "changed 40 days ago"]);
    expect([sureWord("high"), sureWord("medium"), sureWord("low")]).toEqual(["Sure", "Quite sure", "Not sure"]);
  });
});
