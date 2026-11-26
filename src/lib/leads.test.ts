import { describe, it, expect, vi } from "vitest";
import { fetchLeads, fetchLeadsState, leadLooks, reportAge } from "./leads";

const deps = (res: Response) => ({ fetch: vi.fn(async () => res) as unknown as typeof fetch, storage: null });

describe("fetchLeads", () => {
  it("maps 404 to []", async () => {
    expect(await fetchLeads(deps(new Response("", { status: 404 })))).toEqual([]);
  });
  it("maps 200 to rows", async () => {
    const rows = [{ area: "app-shop", repos: ["app-shop"], leadId: "lead-app-shop", status: "idle", reportAt: 5 }];
    expect(await fetchLeads(deps(new Response(JSON.stringify(rows), { status: 200 })))).toEqual(rows);
  });
  it("throws on other errors", async () => {
    await expect(fetchLeads(deps(new Response("", { status: 500 })))).rejects.toThrow("leads: 500");
  });
});

describe("fetchLeadsState", () => {
  it("flags a 404 as missing so the poll can stop", async () => {
    expect(await fetchLeadsState(deps(new Response("", { status: 404 })))).toEqual({ rows: [], missing: true });
    expect(await fetchLeadsState(deps(new Response("[]", { status: 200 })))).toEqual({ rows: [], missing: false });
  });
});

describe("reportAge", () => {
  it("formats the age", () => {
    expect(reportAge(null)).toBe("no report");
    expect(reportAge(0, 1000)).toBe("no report");
    expect(reportAge(1000, 31_000)).toBe("30s ago");
    expect(reportAge(1000, 301_000)).toBe("5m ago");
    expect(reportAge(1000, 7_201_000)).toBe("2h ago");
  });
});

describe("leadLooks", () => {
  it("every read of the leads notes the areas that have a lead, each with its avatar pick", async () => {
    const rows = [
      { area: "app-shop", repos: [], leadId: "lead-app-shop", status: "idle", avatar: 4 },
      { area: "console", repos: [], leadId: "lead-console", status: "running" },
      { area: "docs", repos: [], leadId: null, status: null, avatar: 2 },
      { area: "bad", repos: [], leadId: "lead-bad", status: "idle", avatar: 99 },
    ];
    await fetchLeadsState(deps(new Response(JSON.stringify(rows), { status: 200 })));
    expect([...leadLooks()]).toEqual([["app-shop", 4], ["console", 0], ["bad", 0]]);
    // The same map while nothing changed (a subscriber does not render again).
    const before = leadLooks();
    await fetchLeadsState(deps(new Response(JSON.stringify(rows), { status: 200 })));
    expect(leadLooks()).toBe(before);
    await fetchLeadsState(deps(new Response("", { status: 404 })));
    expect(leadLooks().size).toBe(0);
  });
});
