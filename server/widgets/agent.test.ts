// server/widgets/agent.test.ts — agent fallback messages, typing and the rate limit.
import { describe, it, expect } from "vitest";
import { AgentTyper, askMessage, refreshMessage } from "./agent.js";
import { WidgetError } from "./errors.js";

function fakeTerminals(live = true, ready = true) {
  const writes: string[] = [];
  return {
    writes,
    has: () => live,
    hasSession: async () => live,
    inputReady: () => live && ready,
    reattach: async () => null,
    write: (_id: string, d: string) => { writes.push(d); },
  };
}
const rec = (over: { kind?: "issue"; status?: "running" | "idle" | "done" | "error" } = {}) =>
  ({ id: "a1", status: "idle" as const, ...over });

describe("messages", () => {
  it("builds the refresh text, with Args only when args were passed", () => {
    expect(refreshMessage("ratex", "/d/a1/ratex")).toBe(
      "[widget ratex] Refresh: get fresh data and write it as JSON to /d/a1/ratex/data.json.");
    expect(refreshMessage("ratex", "/d/a1/ratex", { day: 1 })).toBe(
      "[widget ratex] Refresh: get fresh data and write it as JSON to /d/a1/ratex/data.json. Args: {\"day\":1}");
  });
  it("prefixes ask text and cuts it to 2000 chars", () => {
    expect(askMessage("w", "why?")).toBe("[widget w] why?");
    expect(askMessage("w", "x".repeat(3000))).toBe(`[widget w] ${"x".repeat(2000 - "[widget w] ".length)}`);
  });
  it("collapses whitespace and drops controls, so the confirm bar shows all that is typed", () => {
    expect(askMessage("w", "  a\n\n\n\nb\t c\r\n\x1b[201~d  ")).toBe("[widget w] a b c [201~d");
    expect(refreshMessage("w", "/d", { s: "x\u2028\u2029y" })).toBe(
      "[widget w] Refresh: get fresh data and write it as JSON to /d/data.json. Args: {\"s\":\"x y\"}");
  });
  it("keeps the whole typed message within 2000 chars", () => {
    expect(askMessage("w", "x".repeat(3000)).length).toBe(2000);
    const big = { s: "x".repeat(1950) };
    expect(() => refreshMessage("w", "/d", big)).toThrow("args too long");
    try { refreshMessage("w", "/d", big); } catch (e) { expect(e).toMatchObject({ code: 400 }); }
    expect(refreshMessage("w", "/d", { s: "x".repeat(1800) }).length).toBeLessThanOrEqual(2000);
  });
});

describe("AgentTyper", () => {
  it("types the text as one bracketed paste, then Enter", async () => {
    const t = fakeTerminals();
    await new AgentTyper({ terminals: t, sleep: async () => {} }).type(rec(), "w", "[widget w] hi");
    expect(t.writes).toEqual(["\x1b[200~[widget w] hi\x1b[201~", "\r"]);
  });
  it("409 for issue agents and for agents that are not running", async () => {
    const t = fakeTerminals();
    const typer = new AgentTyper({ terminals: t, sleep: async () => {} });
    expect(() => typer.check(rec({ kind: "issue" }), "w")).toThrow("not for issue agents");
    await expect(typer.type(rec({ status: "done" }), "w", "x")).rejects.toMatchObject({ code: 409, message: "agent not running" });
    expect(t.writes).toEqual([]);
  });
  it("409 when the agent has no live terminal, and that try does not use the rate slot", async () => {
    const typer = new AgentTyper({ terminals: fakeTerminals(false), sleep: async () => {} });
    await expect(typer.type(rec(), "w", "x")).rejects.toMatchObject({ code: 409, message: "agent not running" });
    expect(() => typer.check(rec(), "w")).not.toThrow();
  });
  it("checkReady: a PTY that is not input-ready → 409, nothing typed, and the rate slot is freed", async () => {
    const t = fakeTerminals(true, false);
    const typer = new AgentTyper({ terminals: t, sleep: async () => {}, checkReady: true });
    const err = await typer.type(rec(), "w", "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WidgetError);
    expect(err).toMatchObject({ code: 409, message: "agent not running" });
    expect(t.writes).toEqual([]);
    expect(() => typer.check(rec(), "w")).not.toThrow();
  });
  it("flag off: without checkReady a PTY that is not input-ready is typed into as today", async () => {
    const t = fakeTerminals(true, false);
    await new AgentTyper({ terminals: t, sleep: async () => {} }).type(rec(), "w", "x");
    expect(t.writes).toEqual(["\x1b[200~x\x1b[201~", "\r"]);
  });
  it("one message per widget per 10 s: 429 inside, ok after; other widgets are free", async () => {
    let now = 1_000_000;
    const typer = new AgentTyper({ terminals: fakeTerminals(), sleep: async () => {}, now: () => now });
    await typer.type(rec(), "w", "x");
    now += 9_999;
    await expect(typer.type(rec(), "w", "x")).rejects.toMatchObject({ code: 429 });
    await typer.type(rec(), "other", "x");
    now += 1;
    await typer.type(rec(), "w", "x");
  });
});
