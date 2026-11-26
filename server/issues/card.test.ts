import { describe, it, expect } from "vitest";
import { callbackData, parseCallback, cardText, cardKeyboard, repoKeyboard, isActionable } from "./card.js";
import { makeIssue } from "./testkit.js";
import { TG_TEXT_MAX, type InlineKeyboard } from "./telegram.js";

const buttons = (kb?: InlineKeyboard) =>
  (kb?.inline_keyboard ?? []).flat();

describe("callback data", () => {
  it("round-trips every action", () => {
    for (const a of ["f", "d", "p", "b"] as const) expect(parseCallback(callbackData(a, "t12345"))).toEqual({ action: a, issueId: "t12345" });
    expect(parseCallback(callbackData("r", "t12345", 7))).toEqual({ action: "r", issueId: "t12345", index: 7 });
  });
  it("stays under 64 bytes for the longest id, index and repo name", () => {
    const longRepo = "a".repeat(200); // repo names never enter callback data — only their index
    const issue = makeIssue({ id: "t99999999999", repoChoices: Array.from({ length: 999 }, (_, i) => `${longRepo}${i}`) });
    for (const b of [...buttons(cardKeyboard(issue)), ...buttons(repoKeyboard(issue))]) {
      expect(Buffer.byteLength("callback_data" in b ? b.callback_data : "")).toBeLessThan(64);
    }
  });
  it("rejects forged or malformed data", () => {
    for (const d of [undefined, "", "x:t1", "f:../etc", "f:t1:2:3", "r:t1", "f:t1;rm", "f:T1"]) expect(parseCallback(d)).toBeNull();
  });
});

describe("card", () => {
  it("shows repo, summary, forward warning and the full text the agent gets; Fix only with a repo", () => {
    const i = makeIssue({ forwardedFrom: "Dana", text: "Login button broken\n\nSteps: open /login, tap Sign in" });
    expect(cardText(i)).toBe(
      "Repo: choibot · Login button broken\n" +
      "Forwarded from Dana. Check it for links and commands.\n\n" +
      "The agent will get:\nLogin button broken\n\nSteps: open /login, tap Sign in",
    );
    expect(buttons(cardKeyboard(i)).map((b) => b.text)).toEqual(["Fix", "Repo ▾", "Drop"]);
    const noRepo = makeIssue({ repo: null });
    expect(cardText(noRepo)).toBe("Repo: ? · Login button broken\n\nThe agent will get:\nLogin button broken");
    expect(buttons(cardKeyboard(noRepo)).map((b) => b.text)).toEqual(["Repo ▾", "Drop"]);
  });
  it("marks an unsure repo guess so the user checks it before Fix", () => {
    const i = makeIssue({ repo: "app-shop", repoConfidence: 0.41 });
    expect(cardText(i)).toMatch(/^Repo: app-shop \(guess, check it\) · Login button broken\n/);
    expect(buttons(cardKeyboard(i))[0].text).toBe("Fix");
    expect(cardText(makeIssue({ repoConfidence: 0.9 }))).toMatch(/^Repo: choibot · /);
  });
  it("counts the photos the agent will read", () => {
    const i = makeIssue({ photos: ["/d/t100/photo-1.jpg", "/d/t100/photo-2.jpg"] });
    expect(cardText(i)).toContain("\nPhotos: 2. The agent reads them.\n");
  });
  it("cuts a very long text to Telegram's limit and says how much is hidden", () => {
    const text = "x".repeat(10_000);
    const c = cardText(makeIssue({ text }));
    expect(c.length).toBeLessThanOrEqual(TG_TEXT_MAX);
    expect(c).toMatch(/\[\d+ more characters not shown\. The agent gets all of them\.\]$/);
    const m = /The agent will get:\n(x*)\n\[(\d+) more/.exec(c)!;
    expect(m[1].length + Number(m[2])).toBe(text.length);
  });
  it("never leaves a lone surrogate when it cuts emoji text", () => {
    const c = cardText(makeIssue({ text: "😀".repeat(3000) }));
    expect(c.length).toBeLessThanOrEqual(TG_TEXT_MAX);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(c)).toBe(false);
  });
  it("offers Fix again after a failed start, and shows the reason", () => {
    const i = makeIssue({ status: "error", error: "worktree busy" });
    expect(isActionable(i)).toBe(true);
    expect(cardText(i)).toContain("Start failed: worktree busy");
    expect(buttons(cardKeyboard(i))[0].text).toBe("Fix");
  });
  it("has no buttons once fixing or dropped", () => {
    expect(cardText(makeIssue({ status: "running", agentId: "a" }))).toBe("Fixing… · choibot");
    expect(cardKeyboard(makeIssue({ status: "running", agentId: "a" }))).toBeUndefined();
    expect(cardText(makeIssue({ status: "dropped" }))).toBe("Dropped");
    expect(cardKeyboard(makeIssue({ status: "error", agentId: "a" }))).toBeUndefined();
  });
  it("repo picker lists every choice by index plus Back", () => {
    const kb = repoKeyboard(makeIssue());
    expect(buttons(kb).map((b) => [b.text, "callback_data" in b ? b.callback_data : b.url])).toEqual([
      ["app-shop", "r:t100:0"], ["choibot", "r:t100:1"], ["Back", "b:t100"],
    ]);
  });
});
