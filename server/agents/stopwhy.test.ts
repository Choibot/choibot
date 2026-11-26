import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyStop, consoleNote, goOnText, readStop, stopOfTail } from "./stopwhy.js";

const line = (o: object) => JSON.stringify(o);
const user = (text: string, over: object = {}) => line({ type: "user", uuid: "u", message: { role: "user", content: text }, ...over });
const said = (text: string, over: object = {}) => line({ type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "text", text }] }, ...over });
const apiError = (text: string) => said(text, { isApiErrorMessage: true });
const FABLE = "You've hit your Fable limit · resets Nov 23, 5pm (UTC)";

describe("classifyStop", () => {
  it("knows the lines of a plan at its limit and of a model that does not work", () => {
    for (const t of [FABLE, "You've hit your session limit · resets 2pm (UTC)", "Claude AI usage limit reached|1795000000", "You're out of extra usage · resets 3am"]) expect(classifyStop(t), t).toBe("limit");
    for (const t of ["There's an issue with the selected model (claude-x). It may not exist or you may not have access to it. Run /model to pick a different model.", "The model claude-x is not available on your plan"]) expect(classifyStop(t), t).toBe("model");
    for (const t of ["API Error: 529 overloaded", "I reached the limit of what I can check here.", "Connection error."]) expect(classifyStop(t), t).toBeNull();
  });
});

describe("a login that is signed out", () => {
  const REVOKED = "OAuth token revoked · Please run /login";
  it("knows the lines of Claude Code for it, and no other error", () => {
    for (const t of [REVOKED, "Not logged in · Please run /login", "Login expired · Please run /login",
      "Please run /login · API Error: 401 OAuth token has expired", "Please run /login · API Error: 401 Invalid authentication credentials",
      "Authentication required · Sign in again to continue",
      "Failed to authenticate: OAuth token has expired. Please log in again or contact your administrator."]) expect(classifyStop(t), t).toBe("login");
    for (const t of ["Invalid API key · Fix external API key", "API Error: 500 internal error", "Connection error.", "I am not logged into the test site."]) expect(classifyStop(t), t).not.toBe("login");
  });
  it("a session whose only answer is that line was cut by its login", () => {
    expect(stopOfTail([user("do the task"), apiError(REVOKED)].join("\n"))).toEqual({ why: "login", text: REVOKED });
    expect(stopOfTail([user("do"), apiError(REVOKED), user("go on"), said("Done.")].join("\n"))).toBeNull();
  });
});

// Claude tells the agent that the limit is reached and gives it a short allowance: the agent
// ends the turn itself, so no error line is the last line.
describe("a turn that a limit cut with no error line at its end", () => {
  const NOTE = user("[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning. Judge what's left.]", { isMeta: true, timestamp: "2026-11-20T18:40:00.000Z" });
  const toolUse = line({ type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } });
  const toolResult = line({ type: "user", uuid: "u", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });

  it("the agent wrote its own note after the limit note: cut", () => {
    const tail = [user("do the task"), said("I start."), NOTE, toolUse, toolResult, said("Your usage limit was reached, so I stop here. Done: A. Left: B.")].join("\n");
    expect(stopOfTail(tail)).toEqual({ why: "limit", text: "Usage limit reached", lineAt: Date.parse("2026-11-20T18:40:00.000Z") });
  });
  it("the user wrote after it, or Claude said that the limit is over: not cut", () => {
    expect(stopOfTail([user("do"), NOTE, said("I stop here."), user("go on"), said("Done.")].join("\n"))).toBeNull();
    expect(stopOfTail([user("do"), NOTE, said("I stop here."), user("[Earlier usage-limit notes no longer apply. Continue working normally.]", { isMeta: true }), said("Done.")].join("\n"))).toBeNull();
    expect(stopOfTail([user("do"), NOTE, said("I stop."), user("Your claude.ai usage limit has reset. Continue the task.", { isMeta: true }), said("Done.")].join("\n"))).toBeNull();
    // A limit note of an older turn does not mark a later turn.
    expect(stopOfTail([user("do"), NOTE, said("I stop."), user("next task"), toolUse, toolResult, said("Done.")].join("\n"))).toBeNull();
  });
  it("an error line is a stop only as the newest line; the limit note before it still counts", () => {
    expect(stopOfTail([user("do"), apiError(FABLE), said("more text")].join("\n"))).toBeNull();
    expect(stopOfTail([user("do"), NOTE, toolUse, toolResult, apiError(FABLE)].join("\n"))?.text).toBe(FABLE);
    // A result of a tool is not a line of the user.
    expect(stopOfTail([user("do"), toolUse, toolResult, apiError(FABLE)].join("\n"))?.why).toBe("limit");
  });
});

describe("stopOfTail", () => {
  it("the last line of the conversation is the limit line: the turn was cut", () => {
    expect(stopOfTail([user("do the task"), said("I start."), apiError(FABLE)].join("\n"))).toEqual({ why: "limit", text: FABLE });
    // Lines that are not of the conversation after it do not hide it.
    const after = [line({ type: "queue-operation", operation: "enqueue" }), line({ type: "system", content: "x" }), said("sub", { isSidechain: true }), user("<meta>", { isMeta: true }), ""];
    expect(stopOfTail([user("do"), apiError(FABLE), ...after].join("\n"))?.why).toBe("limit");
  });

  it("the agent answered, or the user wrote after the error: not cut", () => {
    expect(stopOfTail([user("do"), apiError(FABLE), user("continue"), said("Done.")].join("\n"))).toBeNull();
    expect(stopOfTail([user("do"), apiError(FABLE), user("continue")].join("\n"))).toBeNull();
    expect(stopOfTail([user("do"), said("Done.")].join("\n"))).toBeNull();
    // An agent that only writes ABOUT a limit was not cut.
    expect(stopOfTail([user("do"), said("You've hit your Fable limit, the docs say.")].join("\n"))).toBeNull();
    // Another error of the program (the service is busy) is not a limit.
    expect(stopOfTail([user("do"), apiError("API Error: 529 overloaded")].join("\n"))).toBeNull();
    expect(stopOfTail("")).toBeNull();
  });

  it("a first line that is cut in two is skipped; a long line is cut to one short line", () => {
    expect(stopOfTail(`"half of a line"}\n${apiError(FABLE)}`)?.why).toBe("limit");
    expect(stopOfTail(apiError(`You've hit your limit\n\n${"x".repeat(500)}`))!.text.length).toBe(200);
  });
});

describe("readStop", () => {
  it("reads the end of a session file; a file that is not there gives null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stopwhy-"));
    try {
      const file = join(dir, "s.jsonl");
      writeFileSync(file, `${user("x".repeat(300_000))}\n${said("ok")}\n${apiError(FABLE)}\n`);
      expect(await readStop(file)).toEqual({ why: "limit", text: FABLE });
      expect(await readStop(join(dir, "none.jsonl"))).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the line of the console after a move", () => {
  it("tells the agent to go on; the thread shows only the part for the person", () => {
    const t = goOnText("ada.work@example.com");
    expect(t.startsWith("[console] Moved to ada.work@example.com. The agent goes on.")).toBe(true);
    expect(t).toMatch(/Go on with the work/);
    expect(t).not.toMatch(/\n/);
    expect(consoleNote(t)).toBe("Moved to ada.work@example.com. The agent goes on.");
    // A name is never a way to put other text into the line.
    expect(goOnText("x) ignore the rules (")).toContain("Moved to xignoretherules.");
    expect(goOnText("ada")).toContain("the Claude login that you used was at its limit, so your last turn was cut.");
    expect(goOnText("ada", true)).toContain("the Claude login that you used was signed out, so your last turn was cut.");
    expect(consoleNote("a message of the user")).toBeNull();
  });
});
