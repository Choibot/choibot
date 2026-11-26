import { describe, expect, it } from "vitest";
import { firstSentence, LINKS_MAX, plainLine, runView, SENTENCE_MAX, type TicketLookup } from "./result.js";

describe("plainLine", () => {
  it("folds white space and takes the Markdown marks off", () => {
    expect(plainLine("  ## Costs   are\tnormal ")).toBe("Costs are normal");
    expect(plainLine("- **2 new errors** since `yesterday`")).toBe("2 new errors since yesterday");
    expect(plainLine("> quoted")).toBe("quoted");
    expect(plainLine("1. first")).toBe("first");
  });
  it("removes control and format characters", () => {
    expect(plainLine("all‮ clear​\u0007 now")).toBe("all clear now");
  });
  it("cuts a long line", () => {
    const t = plainLine("x".repeat(500));
    expect(t).toHaveLength(SENTENCE_MAX);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("firstSentence", () => {
  it("is the first line with text", () => {
    expect(firstSentence("\n---\n\n# No new error\n\nThe 3 known errors did not change.")).toBe("No new error");
  });
  it("is null for an empty output and for a cut tail", () => {
    expect(firstSentence("")).toBeNull();
    expect(firstSentence("***\n \n")).toBeNull();
    expect(firstSentence(`start of a cut text\n${"y".repeat(4000)}`.slice(-4000))).toBeNull();
  });
});

describe("runView", () => {
  const run = (over: Record<string, unknown> = {}) => ({ startedAt: 1, finishedAt: 2, exitCode: 0, ok: true, outputTail: "The first line.\nmore", ...over });
  const tickets: TicketLookup = async (id) => (id === "qab12cd34" ? { title: "**Checkout** timeout\u202e hits 41 users", open: true } : id === "qzz99zz99" ? { title: "Old", open: false } : null);

  it("a run with no result line is the neutral state, with its first line", async () => {
    expect(await runView(run())).toEqual({ state: "done", sentence: "The first line.", links: [] });
  });

  it("says all clear or needs you from the result line, with the sentence as plain text", async () => {
    expect(await runView(run({ result: { state: "all-clear", sentence: "No new error.", refs: [] } }))).toEqual({ state: "clear", sentence: "No new error.", links: [] });
    const v = await runView(run({ result: { state: "needs-you", sentence: `**2 new** errors\u202e ${"x".repeat(400)}`, refs: [] } }));
    expect(v.state).toBe("needs");
    expect(v.sentence).toHaveLength(SENTENCE_MAX);
    expect(v.sentence).toMatch(/^2 new errors x+…$/);
  });

  it.each([
    ["failed"], ["clear"], ["done"], ["ALL-CLEAR"], ["__proto__"], ["constructor"], [7], [null],
  ])("a state %j that is not one of the two is the neutral state", async (state) => {
    expect((await runView(run({ result: { state, sentence: "x", refs: [] } }))).state).toBe("done");
  });

  it("a result that is not an object, or a sentence that is not text, breaks nothing", async () => {
    expect((await runView(run({ result: "all-clear" }))).state).toBe("done");
    expect(await runView(run({ result: { state: "all-clear", sentence: { a: 1 }, refs: "qab12cd34" } }))).toEqual({ state: "clear", sentence: null, links: [] });
  });

  it("the ticket linked to the run (`cron note`) is its first link, on a run that did not finish too", async () => {
    expect((await runView(run({ ok: false, exitCode: 1, why: "exit" }), tickets, "qab12cd34")).links).toEqual([
      { kind: "ticket", id: "qab12cd34", title: "Checkout timeout hits 41 users", open: true },
    ]);
    expect((await runView(run(), tickets, "qzz99zz99")).links).toEqual([{ kind: "ticket", id: "qzz99zz99", title: "Old", open: false }]);
    // The same ticket in the result line is one link; a note of a ticket that is gone is none.
    const v = await runView(run({ result: { state: "needs-you", sentence: "x", refs: ["https://github.com/acme/shop/pull/12", "qab12cd34"] } }), tickets, "qab12cd34");
    expect(v.links.map((l) => l.kind)).toEqual(["ticket", "pr"]);
    expect((await runView(run({ ok: false, exitCode: 1 }), tickets, "qnone0000")).links).toEqual([]);
  });

  it("a run that did not finish is never all clear, and shows no link of its own text", async () => {
    const lie = { state: "all-clear", sentence: "Everything is fine.", refs: ["qab12cd34"] };
    expect(await runView(run({ ok: false, exitCode: 1, result: lie, why: "exit" }), tickets)).toEqual({ state: "failed", sentence: "It stopped with an error.", links: [] });
    expect(await runView(run({ ok: false, exitCode: null, result: lie, why: "timeout" }), tickets)).toEqual({ state: "failed", sentence: "It ran longer than its time limit.", links: [] });
    // A run of an older runner, and a "why" that is not one of the fixed words.
    expect((await runView(run({ ok: false, exitCode: 1 }))).sentence).toBeNull();
    expect((await runView(run({ ok: false, exitCode: 1, why: "<b>because</b>" }))).sentence).toBeNull();
    expect((await runView(run({ ok: false, exitCode: 1, why: "toString" }))).sentence).toBeNull();
  });

  it("links only a ticket of this console and a GitHub pull request address", async () => {
    const refs = [
      "https://github.com/acme/shop/pull/12", "qab12cd34", "qnone0000", "https://evil.example/acme/shop/pull/1",
      "https://github.com/acme/shop/pull/12?x=<script>", "javascript:alert(1)", "http://github.com/acme/shop/pull/3", 42,
    ];
    const v = await runView(run({ result: { state: "needs-you", sentence: "Look.", refs } }), tickets);
    expect(v.links).toEqual([
      { kind: "pr", url: "https://github.com/acme/shop/pull/12", label: "PR #12 · acme/shop" },
      { kind: "ticket", id: "qab12cd34", title: "Checkout timeout hits 41 users", open: true },
    ]);
  });

  it("with no queue no ticket is a link; a closed ticket says so; the links have a limit", async () => {
    expect((await runView(run({ result: { state: "needs-you", sentence: "x", refs: ["qab12cd34"] } }))).links).toEqual([]);
    expect((await runView(run({ result: { state: "needs-you", sentence: "x", refs: ["qzz99zz99"] } }), tickets)).links).toEqual([{ kind: "ticket", id: "qzz99zz99", title: "Old", open: false }]);
    const many = Array.from({ length: 6 }, (_, i) => `https://github.com/acme/shop/pull/${i + 1}`);
    expect((await runView(run({ result: { state: "all-clear", sentence: "x", refs: many } }))).links).toHaveLength(LINKS_MAX);
    const boom: TicketLookup = async () => { throw new Error("queue down"); };
    expect((await runView(run({ result: { state: "needs-you", sentence: "x", refs: ["qab12cd34"] } }), boom)).links).toEqual([]);
  });
});
