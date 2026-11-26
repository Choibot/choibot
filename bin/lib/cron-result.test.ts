// bin/lib/cron-result.test.ts — the result line that a run ends with.
import { describe, expect, it } from "vitest";
import {
  RESULT_INSTRUCTION, RESULT_REFS_MAX, RESULT_SENTENCE_MAX, RUN_WHYS, TASK_NAME_RE, TELEGRAM_MAX, WHY_WORDS,
  readResultLine, runMessageHtml, taskPageUrl, withResultInstruction,
} from "./cron-result.mjs";
import { NAME_RE } from "./cronspec.js";

describe("withResultInstruction", () => {
  it("puts the fixed paragraph after the task's own instructions", () => {
    expect(withResultInstruction("Check the backup.\n")).toBe(`Check the backup.\n\n${RESULT_INSTRUCTION}`);
    expect(RESULT_INSTRUCTION).toContain("RESULT: all-clear | ");
    expect(RESULT_INSTRUCTION).toContain("RESULT: needs-you | ");
  });
});

describe("readResultLine", () => {
  it("reads the state and the sentence of the last line", () => {
    expect(readResultLine("The backup is complete: 14 files.\n\nRESULT: all-clear | The backup of last night is complete.\n")).toEqual({
      result: { state: "all-clear", sentence: "The backup of last night is complete.", refs: [] },
      text: "The backup is complete: 14 files.",
    });
  });

  it("reads a ticket id and a pull request address after the sentence", () => {
    const r = readResultLine("x\nRESULT: needs-you | Checkout is slow for 41 users. | qab12cd34 | https://github.com/acme/shop/pull/12");
    expect(r.result).toEqual({ state: "needs-you", sentence: "Checkout is slow for 41 users.", refs: ["qab12cd34", "https://github.com/acme/shop/pull/12"] });
    expect(r.text).toBe("x");
  });

  it.each([
    ["**RESULT:** all-clear | Fine.", "all-clear", "Fine."],
    ["`RESULT: needs-you | Look.`", "needs-you", "Look."],
    ["> result: ALL-CLEAR | Fine.", "all-clear", "Fine."],
    ["RESULT: all-clear", "all-clear", ""],
    ["RESULT : needs-you|No space.", "needs-you", "No space."],
  ])("takes %j", (line, state, sentence) => {
    expect(readResultLine(`text\n${line}`).result).toMatchObject({ state, sentence });
  });

  it.each([
    "", "no line here", "RESULT: ok | fine", "RESULT: failed | no", "The RESULT: all-clear | is not at the start",
    "RESULT: all-clear | Fine.\nmore\ntext\nafter\nit",
  ])("%j has no result line", (out) => {
    expect(readResultLine(out)).toEqual({ result: null, text: out.trim() });
  });

  it("takes the line when a few words come after it, and the last of two lines", () => {
    expect(readResultLine("RESULT: all-clear | Fine.\n\nDone.").result?.sentence).toBe("Fine.");
    expect(readResultLine("RESULT: all-clear | One.\nRESULT: needs-you | Two.").result).toMatchObject({ state: "needs-you", sentence: "Two." });
  });

  it("cuts a long sentence, and keeps a few different links only", () => {
    const refs = Array.from({ length: 9 }, (_, i) => `q${String(i).padStart(8, "0")}`);
    const r = readResultLine(`RESULT: needs-you | ${"a".repeat(900)} | ${refs.join(" | ")} | ${refs[0]}`).result!;
    expect(r.sentence).toHaveLength(RESULT_SENTENCE_MAX);
    expect(r.refs).toEqual(refs.slice(0, RESULT_REFS_MAX));
  });
});

describe("the words of a run", () => {
  it("has the words of every reason, and the task name of cronspec", () => {
    expect(Object.keys(WHY_WORDS).sort()).toEqual([...RUN_WHYS].sort());
    expect(TASK_NAME_RE.source).toBe(NAME_RE.source);
  });
  it("taskPageUrl: the console's address and a task name, or null", () => {
    expect(taskPageUrl("https://c.example.ts.net/", "nightly")).toBe("https://c.example.ts.net/#recurring=nightly");
    expect(taskPageUrl("http://127.0.0.1:3100", "a-1")).toBe("http://127.0.0.1:3100/#recurring=a-1");
    for (const [o, n] of [[undefined, "a"], ["", "a"], ["ftp://x", "a"], ["https://x y", "a"], ['https://x"y', "a"], ["https://x", "Bad"], ["https://x", "a/b"]]) {
      expect(taskPageUrl(o, n as string)).toBeNull();
    }
  });
  it("runMessageHtml: the name, the state in the user's words, one plain escaped sentence and the link", () => {
    expect(runMessageHtml({ name: "nightly", state: "needs-you", sentence: "## 2 <new> errors\n& a slow page", url: "https://c/#recurring=nightly" }))
      .toBe('<b>Recurring · nightly</b>: Needs you. 2 &lt;new&gt; errors &amp; a slow page\n<a href="https://c/#recurring=nightly">Open the task</a>');
    expect(runMessageHtml({ name: "nightly", state: "did-not-finish", sentence: WHY_WORDS.timeout, url: null }))
      .toBe("<b>Recurring · nightly</b>: Did not finish. It ran longer than its time limit.");
    expect(runMessageHtml({ name: "nightly", state: "all-clear", sentence: "" })).toBe("<b>Recurring · nightly</b>: All clear.");
  });
});

// The owner's tasks are digests: the answer is what Telegram is for (the console lead's review of #106).
describe("runMessageHtml: the task's answer folded under the headline", () => {
  const URL = "https://c/#recurring=costs";
  const DIGEST = "Costs this week: 41 USD\n- EC2 30 <same>\n- S3 & co 11";
  const FOLDED = "<blockquote expandable>Costs this week: 41 USD\n- EC2 30 &lt;same&gt;\n- S3 &amp; co 11</blockquote>";
  it("all clear and needs you: headline, link, then the answer, escaped, in an expandable quote", () => {
    expect(runMessageHtml({ name: "costs", state: "all-clear", sentence: "Costs are flat.", url: URL, text: DIGEST }))
      .toBe(`<b>Recurring · costs</b>: All clear. Costs are flat.\n<a href="${URL}">Open the task</a>\n${FOLDED}`);
    expect(runMessageHtml({ name: "costs", state: "needs-you", sentence: "EC2 is up 40%.", url: null, text: DIGEST }))
      .toBe(`<b>Recurring · costs</b>: Needs you. EC2 is up 40%.\n${FOLDED}`);
  });
  it("did not finish: the fixed reason only, never text of the run", () => {
    expect(runMessageHtml({ name: "costs", state: "did-not-finish", sentence: WHY_WORDS.exit, url: URL, text: "exit 3: <secret> stack" }))
      .toBe(`<b>Recurring · costs</b>: Did not finish. It stopped with an error.\n<a href="${URL}">Open the task</a>`);
  });
  it("no quote for an empty answer or an answer that says only the sentence", () => {
    for (const text of [undefined, null, "", "  \n ", "Costs are flat.", "  Costs   are flat.\n"]) {
      expect(runMessageHtml({ name: "costs", state: "all-clear", sentence: "Costs are flat.", text })).toBe("<b>Recurring · costs</b>: All clear. Costs are flat.");
    }
  });
  it("the whole message stays within the Telegram limit; a long answer keeps its end, with no half escape", () => {
    const text = `${"first line\n"}${"a&b<c>\"d\n".repeat(900)}the last line`;
    const m = runMessageHtml({ name: "a".repeat(41), state: "needs-you", sentence: "s".repeat(400), url: `https://c.example.ts.net/#recurring=${"a".repeat(41)}`, text });
    expect(m.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(m).toMatch(/<blockquote expandable>…\n[^]*the last line<\/blockquote>$/);
    expect(m).not.toContain("first line");
    expect(m).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
    // The answer of today's runner (3900 characters at most) with the longest headline.
    const big = runMessageHtml({ name: "a".repeat(41), state: "all-clear", sentence: "s".repeat(400), url: "https://c/#recurring=a", text: "&".repeat(3900) });
    expect(big.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  });
});

