// server/guide/actions.test.ts — the reply of the guide is text and three typed actions, and
// nothing else; the last error of a step is the server's.
import { describe, expect, it } from "vitest";
import { actionError, lastError, parseReply, REPLY_ACTIONS_MAX, REPLY_CARDS_MAX, REPLY_TEXT_MAX } from "./actions.js";
import { IDLE, list } from "./testkit.js";

describe("parseReply", () => {
  it("cuts a reply into text and actions, in order", () => {
    expect(parseReply([
      "GitHub shows no login yet, so this step stays open.",
      "[check github]",
      "[error github]",
      "The code ran out. Here is the card for a new one.",
      "",
      "[card github]",
    ].join("\n"))).toEqual([
      { say: "GitHub shows no login yet, so this step stays open." },
      { do: "check", step: "github" },
      { do: "error", step: "github" },
      { say: "The code ran out. Here is the card for a new one." },
      { do: "card", step: "github" },
    ]);
  });

  it("knows only check, error and card, and only the steps of the list", () => {
    const blocks = parseReply([
      "[done github]", "[mark github done]", "[run rm -rf /]", "[shell ls]", "[start agent]", "[card nothing]", "[check]",
      "[CARD github]", "Text stays.",
    ].join("\n"));
    // A line with the shape of an action that is not one is dropped: not run, not shown.
    expect(blocks).toEqual([{ say: "Text stays." }]);
  });

  it("reads an action only when it is alone on its line", () => {
    expect(parseReply("Press the button, [card github] is below.")).toEqual([{ say: "Press the button, [card github] is below." }]);
    expect(parseReply("  [card repo]  ")).toEqual([{ do: "card", step: "repo" }]);
  });

  it("holds the limits of one reply", () => {
    const many = parseReply(["[card github]", "[card repo]", "[card agent]", "[card merge]"].join("\n"));
    expect(many.filter((b) => "do" in b && b.do === "card")).toHaveLength(REPLY_CARDS_MAX);
    const checks = parseReply(["install", "claude", "access", "pair", "github", "repo", "agent", "merge"].map((s) => `[check ${s}]`).join("\n"));
    expect(checks).toHaveLength(REPLY_ACTIONS_MAX);
    expect(parseReply("[check github]\n[check github]")).toHaveLength(1);
    const long = parseReply(`${"word ".repeat(1000)}\n[card github]\n${"more ".repeat(1000)}`);
    expect(long.filter((b) => "say" in b).map((b) => ("say" in b ? b.say.length : 0)).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(REPLY_TEXT_MAX);
    expect(parseReply("")).toEqual([]);
  });
});

describe("lastError", () => {
  const github = (over = {}) => list({ github: { state: "todo", text: "GitHub is not connected.", error: "GitHub answered: not logged in.", ...over } }).find((s) => s.id === "github")!;

  it("gives the failure of the action of an open step, in plain words", () => {
    const facts = { ...IDLE, login: { state: "failed" as const, reason: "expired" as const } };
    expect(actionError(github(), facts)).toMatch(/code ran out after 15 minutes/);
    expect(lastError(github(), facts)).toMatch(/code ran out after 15 minutes/);
    const clone = { ...IDLE, clone: { state: "failed" as const, repo: "acme/shop", reason: "disk" as const } };
    const repo = list({ repo: "todo" }).find((s) => s.id === "repo")!;
    expect(actionError(repo, clone)).toBe("acme/shop: Your server has no free disk space for the repo.");
  });

  it("gives the error of the check when no action failed", () => {
    expect(actionError(github(), IDLE)).toBeNull();
    expect(lastError(github(), IDLE)).toBe("GitHub answered: not logged in.");
  });

  it("says nothing for a step that is done or that waits", () => {
    const facts = { ...IDLE, login: { state: "failed" as const, reason: "expired" as const } };
    expect(lastError(github({ state: "done" }), facts)).toBeNull();
    expect(lastError(github({ state: "blocked" }), facts)).toBeNull();
    expect(lastError(undefined, facts)).toBeNull();
  });

  it("reads the first agent: a stop with no pull request is an error, work is not", () => {
    const agent = list({ agent: "todo" }).find((s) => s.id === "agent")!;
    const view = (state: string, extra = {}) => ({ ...IDLE, first: { task: "t", repo: "shop", now: 9, ticket: null, agent: { id: "a1", name: "First task", state, startedAt: 1, pullRequest: false, ...extra } } as never });
    expect(actionError(agent, view("working"))).toBeNull();
    expect(actionError(agent, view("waiting"))).toMatch(/stopped and opened no pull request/);
    expect(actionError(agent, view("waiting"))).not.toMatch(/thread/);
    expect(actionError(agent, view("error"))).toMatch(/stopped with an error/);
    expect(actionError(agent, view("waiting", { pullRequest: true }))).toMatch(/ticket did not come/);
    expect(actionError(agent, view("working", { noSession: true }))).toBe("The first agent has no session yet. Claude may wait for an answer on its terminal screen.");
    expect(actionError(agent, { ...IDLE, first: { task: "t", repo: "shop", repos: ["shop"], now: 9, agent: null, ticket: null } })).toBeNull();
  });
});
