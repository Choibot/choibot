// server/chief/deploy/ticket.test.ts — the words of the Update ticket (the release variant of the
// console's own ticket, server/update): one short line for each state, the notes as plain text.
import { describe, expect, it } from "vitest";
import { NOTE_CHARS, UPDATE_STATES, isRunning, plainNote, stepWords, ticketLine, updateBody, updateLine, updateTitle, updateVersions, type UpdateRun } from "./ticket.js";

const run = (state: UpdateRun["state"], step?: string): UpdateRun => ({ state, via: "tab", askedAt: 1, from: 848, to: 849, ...(step ? { step } : {}) });

describe("the Update ticket's words", () => {
  it("one line for each state; 'nothing lost' only when the way back passed", () => {
    expect(UPDATE_STATES.map((s) => updateLine(run(s, "health")))).toEqual([
      "Update asked",
      "Updating",
      "The server did not start the update.",
      "Update refused at the health check. Nothing changed.",
      "The release could not be downloaded. Nothing changed.",
      "The update did not finish.",
      "Updated to version 849",
      "Failed at the health check. Back on version 848. Nothing lost.",
      "Update failed. The console needs help.",
    ]);
    expect(updateLine(run("failed-stuck"))).not.toMatch(/lost/i);
    // The press limit is the person's own case: no "refused at", and what to do.
    expect(updateLine(run("refused", "limit"))).toBe("Too many presses in an hour. Press again later.");
    expect(updateLine(run("refused", "layout"))).toBe("Update refused at the code folder check. Nothing changed.");
    expect(updateLine(run("refused", "replay"))).toBe("Update refused at the check against an older release list. Nothing changed.");
    expect(updateLine(undefined)).toBe("");
  });

  it("the title, the body (the notes only) and the versions line", () => {
    expect(updateTitle(849)).toBe("ChoiBot 849 is ready");
    expect(updateBody({ notes: ["a", "b"], more: 0 })).toBe("a\nb");
    expect(updateBody({ notes: [], more: 0 })).toBe("No notes for this release.");
    const many = Array.from({ length: 15 }, (_, n) => `n${n}`);
    const body = updateBody({ notes: many, more: 2 }).split("\n");
    expect(body.at(-1)).toBe("and 5 more");
    expect(body).toHaveLength(13);
    expect(updateVersions({ version: 849, running: { version: 0, commit: null } })).toBe("Version 0 → 849");
  });

  it("a note is one plain line of at most 200 characters", () => {
    expect(plainNote("  a\u0007b\nc d\u009be ")).toBe("a b c d e");
    expect(plainNote("x".repeat(500))).toHaveLength(NOTE_CHARS);
    expect(plainNote("<b>bold</b> [link](https://x)")).toBe("<b>bold</b> [link](https://x)"); // kept as text; rendered as text
  });

  it("a press under way counts as running (no second button on a card)", () => {
    expect(isRunning({ live: "", target: "", count: 0, prs: [], more: 0, update: run("asked") })).toBe(true);
    expect(isRunning({ live: "", target: "", count: 0, prs: [], more: 0, update: run("refused") })).toBe(false);
    expect(ticketLine({ live: "", target: "", count: 0, prs: [], more: 0, update: run("running") })).toBe("Updating");
  });
});

describe("root's step words in a sentence", () => {
  it("names each step of root's list in plain words, and shows another word as it is", () => {
    // release-format.md §10, the full list, and the older "rootParts".
    const list = ["download", "inputs", "signature", "index", "channel", "expired", "replay", "arch", "hold", "bad", "limit", "version", "size", "disk", "hash", "entries", "build", "root-parts", "layout", "port", "stage", "stop", "swap", "start", "health", "repair", "clean-up", "rootParts"];
    for (const w of list) expect([w, stepWords(w) !== w && /^(the|a) /.test(stepWords(w))]).toEqual([w, true]);
    expect(stepWords("signature")).toBe("the signature check");
    expect(stepWords("rootParts")).toBe("the root files check");
    expect(stepWords("newstep")).toBe("newstep");
    expect(stepWords(undefined)).toBe("a step");
  });
});
