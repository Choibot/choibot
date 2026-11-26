// src/lib/share.test.ts — the Queue's "Share outside" client: the hit words, and that the browser
// sends only the ticked hits (never HTML) and keeps the one-tap link in memory only.
import { describe, expect, it, vi } from "vitest";
import { hitWords, oneTaps, publishShare } from "./share";

describe("hitWords", () => {
  it("names the kind of a hit in plain words and keeps the text the tool found", () => {
    expect(hitWords({ level: "blocked", text: "email: ...ops@example.invalid..." })).toEqual({ what: "An e-mail address", text: "...ops@example.invalid..." });
    expect(hitWords({ level: "blocked", text: "blocked word 'acme': ...acme deal..." })).toEqual({ what: "A word on your blocked list 'acme'", text: "...acme deal..." });
    expect(hitWords({ level: "warning", text: "secret thing: x" })).toEqual({ what: "Secret thing", text: "x" });
    expect(hitWords({ level: "warning", text: "no kind here" })).toEqual({ what: "Something", text: "no kind here" });
  });
});

describe("publishShare", () => {
  it("posts only the ticked hits, and keeps the one-tap link in this tab", async () => {
    const f = vi.fn(async (_u: string, _o?: RequestInit) => new Response(JSON.stringify({
      item: { id: "q1" }, link: "https://s.example.test/d", oneTap: "https://s.example.test/d#pw=X", password: "X",
    }), { status: 200 }));
    const r = await publishShare("q1", ["email: a"], { fetch: f as unknown as typeof fetch, storage: null });
    expect(r).toMatchObject({ ok: true, oneTap: "https://s.example.test/d#pw=X", password: "X" });
    expect(f.mock.calls[0]![0]).toBe("/api/queue/q1/share");
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ accept: ["email: a"] });
    expect(oneTaps.get("q1")).toBe("https://s.example.test/d#pw=X");
  });
});
