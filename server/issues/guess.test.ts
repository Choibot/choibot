import { describe, it, expect } from "vitest";
import { guessRepo, JEV_TEXT_MAX } from "./guess.js";

const raw = (choice: string, confidence: number) =>
  JSON.stringify({ model: "jev", answers: { q: { type: "choice", choice, confidence } } });

describe("guessRepo", () => {
  it("returns the repo jev picks when confidence ≥ 0.7, with argv in --name=value form", async () => {
    const calls: string[][] = [];
    const g = await guessRepo("Issues tab crashes", ["app-shop", "choibot"], async (a) => { calls.push(a); return raw("choibot", 0.92); });
    expect(g).toEqual({ repo: "choibot", confidence: 0.92 });
    expect(calls[0][0]).toBe("choice");
    expect(calls[0]).toEqual(expect.arrayContaining(["--option=app-shop", "--option=choibot", "--text=Issues tab crashes", "--raw"]));
  });

  it("keeps the best guess even when jev is unsure; the user confirms it with Fix", async () => {
    expect(await guessRepo("x", ["a", "b"], async () => raw("a", 0.41))).toEqual({ repo: "a", confidence: 0.41 });
  });

  it("returns null when jev fails, prints junk, or invents a repo", async () => {
    expect(await guessRepo("x", ["a", "b"], async () => { throw new Error("ENOENT"); })).toEqual({ repo: null, confidence: 0 });
    expect(await guessRepo("x", ["a", "b"], async () => "not json")).toEqual({ repo: null, confidence: 0 });
    expect((await guessRepo("x", ["a", "b"], async () => raw("zzz", 0.99))).repo).toBeNull();
  });

  it("does not call jev for 0 or 1 repos", async () => {
    const boom = async (): Promise<string> => { throw new Error("must not run"); };
    expect(await guessRepo("x", [], boom)).toEqual({ repo: null, confidence: 0 });
    expect(await guessRepo("x", ["only"], boom)).toEqual({ repo: "only", confidence: 1 });
  });

  it("caps the text at 4 000 chars and sends a placeholder for photo-only issues", async () => {
    const calls: string[][] = [];
    const run = async (a: string[]) => { calls.push(a); return raw("a", 0.9); };
    await guessRepo("-".repeat(100_000), ["a", "b"], run);
    await guessRepo("   ", ["a", "b"], run);
    const text0 = calls[0].find((a) => a.startsWith("--text="))!;
    expect(text0.length).toBe("--text=".length + JEV_TEXT_MAX);
    expect(calls[1]).toContain("--text=(no text — screenshot only)");
  });

  it("drops repo names jev cannot take as an option", async () => {
    const calls: string[][] = [];
    await guessRepo("x", ["a=b", "good", "also-good"], async (a) => { calls.push(a); return raw("good", 0.9); });
    expect(calls[0]).not.toContain("--option=a=b");
  });
});
