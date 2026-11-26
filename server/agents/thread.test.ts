import { describe, it, expect } from "vitest";
import { classifyUserText, foldEnds, parseSessionLine, stepLabel, wantsLine, MAX_ITEM_TEXT, type ThreadItem } from "./thread.js";

const TS = "2026-11-10T17:30:00.000Z";
const MS = Date.parse(TS);
const base = { parentUuid: null, isSidechain: false, uuid: "u1", timestamp: TS, sessionId: "s" };
const line = (o: object): string => JSON.stringify({ ...base, ...o });
const user = (content: unknown, extra: object = {}): string =>
  line({ type: "user", message: { role: "user", content }, origin: { kind: "human" }, promptSource: "typed", ...extra });
const assistant = (content: unknown[], extra: object = {}): string =>
  line({ type: "assistant", message: { role: "assistant", model: "claude", content }, ...extra });

describe("wantsLine", () => {
  it("skips a line whose first key is a type the thread never reads", () => {
    expect(wantsLine('{"type":"api-request-blob","sessionId":"x"')).toBe(false);
    expect(wantsLine('{"type":"file-history-snapshot","messageId":"m"')).toBe(false);
  });
  it("keeps the lines of the wait line", () => {
    expect(wantsLine('{"type":"queue-operation","operation":"enqueue"')).toBe(true);
  });
  it("keeps message lines and lines with another first key", () => {
    expect(wantsLine('{"type":"user","message":{}')).toBe(true);
    expect(wantsLine('{"parentUuid":"a","isSidechain":false')).toBe(true);
  });
});

describe("parseSessionLine: user", () => {
  it("returns a typed prompt", () => {
    expect(parseSessionLine(user("fix the header"))).toEqual([{ kind: "user", id: "u1", ts: MS, text: "fix the header" }]);
  });
  it("marks a queue answer and keeps its id", () => {
    expect(parseSessionLine(user("[queue q53277r13] choice: A (A: Thread)"))).toEqual([
      { kind: "user", id: "u1", ts: MS, text: "choice: A (A: Thread)", via: "queue", ref: "q53277r13" },
    ]);
  });
  it("marks a console event line", () => {
    expect(parseSessionLine(user("[events] agent-1 waiting"))[0]).toMatchObject({ kind: "user", via: "events", text: "agent-1 waiting" });
  });
  it("marks a reminder line and keeps its id", () => {
    expect(parseSessionLine(user("[reminder r7k2m9x1a] (set by agent-1 on 2026-11-09) check the canary"))).toEqual([
      { kind: "user", id: "u1", ts: MS, text: "(set by agent-1 on 2026-11-09) check the canary", via: "reminder", ref: "r7k2m9x1a" },
    ]);
  });
  it("hides a task notification, by origin and by text", () => {
    const text = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>";
    expect(parseSessionLine(user(text, { origin: { kind: "task-notification" }, promptSource: "system" }))).toEqual([]);
    expect(parseSessionLine(user(text, { origin: undefined }))).toEqual([]);
  });
  it("hides meta lines, system reminders, local command output and the compaction summary", () => {
    // A harness prompt is not a row; its key says it left the wait line, if it was there.
    expect(parseSessionLine(user("Base directory for this skill: /x", { isMeta: true, origin: undefined }))).toEqual([
      { kind: "unqueue", id: "u:u1", ts: MS, op: "line", h: expect.stringMatching(/^[0-9a-f]{12}$/), as: "user" },
    ]);
    expect(parseSessionLine(user("<system-reminder>\nremember\n</system-reminder>", { origin: undefined }))).toEqual([]);
    expect(parseSessionLine(user("<local-command-stdout>Set model</local-command-stdout>", { origin: undefined }))).toEqual([]);
    expect(parseSessionLine(user("This session is being continued", { origin: undefined, isCompactSummary: true }))).toEqual([]);
  });
  it("hides tool results as messages and returns the end of their step", () => {
    const l = user([{ type: "tool_result", tool_use_id: "toolu_1", content: "secret output" }], { origin: undefined });
    expect(parseSessionLine(l)).toEqual([{ kind: "end", id: "toolu_1", ts: MS }]);
    const failed = user([{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }], { origin: undefined });
    expect(parseSessionLine(failed)).toEqual([{ kind: "end", id: "toolu_2", ts: MS, error: true }]);
  });
  it("joins text blocks, marks an image and drops a reminder block", () => {
    const l = user([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", data: "AAAA" } },
      { type: "text", text: "<system-reminder>x</system-reminder>" },
    ]);
    expect(parseSessionLine(l)[0]).toMatchObject({ kind: "user", text: "look at this\n[image]" });
  });
  it("shows a slash command and a shell line in short form", () => {
    const cmd = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>";
    expect(parseSessionLine(user(cmd, { origin: undefined }))[0]).toMatchObject({ kind: "user", via: "command", text: "/model opus" });
    expect(parseSessionLine(user("<bash-input>ls -la</bash-input>", { origin: undefined }))[0]).toMatchObject({ kind: "user", via: "shell", text: "! ls -la" });
  });
  it("turns an interrupt into a note", () => {
    expect(parseSessionLine(user("[Request interrupted by user for tool use]", { origin: undefined }))).toEqual([
      { kind: "note", id: "u1", ts: MS, text: "Interrupted" },
    ]);
  });
  it("returns a peer message with its sender and only its body", () => {
    const text = 'Another Claude session sent a message:\n<cross-session-message from="uds:/x.sock" from-name="agent-80" from-mode="bypass">\nDo not open a PR.\n</cross-session-message>\n\nThis came from another Claude session.';
    expect(parseSessionLine(user(text, { origin: { kind: "peer", from: "uds:/x.sock" }, isMeta: true }))).toEqual([
      { kind: "peer", id: "u1", ts: MS, text: "Do not open a PR.", from: "agent-80" },
    ]);
  });
  it("keeps a prompt with no origin field (an older harness, an SDK run)", () => {
    expect(parseSessionLine(user("You are the daily check", { origin: undefined, promptSource: "sdk" }))[0]).toMatchObject({ kind: "user", text: "You are the daily check" });
  });
  it("clips a very long prompt", () => {
    const got = parseSessionLine(user("x".repeat(MAX_ITEM_TEXT + 10)))[0] as Extract<ThreadItem, { kind: "user" }>;
    expect(got.text.length).toBeLessThan(MAX_ITEM_TEXT + 40);
    expect(got.text.endsWith("… (truncated)")).toBe(true);
  });
});

describe("parseSessionLine: assistant", () => {
  it("returns text and tool steps and ignores thinking", () => {
    const l = assistant([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "Two answers." },
      { type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "pnpm test", description: "Run the tests" } },
    ]);
    expect(parseSessionLine(l)).toEqual([
      { kind: "assistant", id: "u1:1", ts: MS, text: "Two answers." },
      { kind: "step", id: "toolu_9", ts: MS, tool: "Bash", label: "Run the tests" },
    ]);
  });
  it("drops empty text and the harness filler", () => {
    expect(parseSessionLine(assistant([{ type: "text", text: "  \n" }]))).toEqual([]);
    const filler = line({ type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] } });
    expect(parseSessionLine(filler)).toEqual([]);
  });
  it("turns an API error message into a note", () => {
    const l = assistant([{ type: "text", text: "You've reached your limit." }], { isApiErrorMessage: true });
    expect(parseSessionLine(l)).toEqual([{ kind: "note", id: "u1", ts: MS, text: "You've reached your limit." }]);
  });
  it("skips subagent (sidechain) lines", () => {
    expect(parseSessionLine(assistant([{ type: "text", text: "inner" }], { isSidechain: true }))).toEqual([]);
  });
});

describe("parseSessionLine: other lines", () => {
  it("returns a message the user sent while the agent worked", () => {
    const l = line({ type: "attachment", attachment: { type: "queued_command", prompt: "also add a test", commandMode: "prompt", origin: { kind: "human" } } });
    expect(parseSessionLine(l)).toEqual([{ kind: "user", id: "u1", ts: MS, text: "also add a test", mid: true }]);
  });
  it("reads a message with an image that the agent got in the middle of a turn", () => {
    const l = line({ type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "see the picture" }, { type: "image", source: {} }], origin: { kind: "human" } } });
    expect(parseSessionLine(l)).toEqual([{ kind: "user", id: "u1", ts: MS, text: "see the picture\n[image]", mid: true }]);
  });
  it("hides a queued task notification and other attachments", () => {
    const note = line({ type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>x</task-notification>", origin: { kind: "task-notification" } } });
    expect(parseSessionLine(note)).toEqual([]);
    expect(parseSessionLine(line({ type: "attachment", attachment: { type: "skill_listing", content: "…" } }))).toEqual([]);
  });
  it("marks a compaction", () => {
    expect(parseSessionLine(line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }))).toEqual([
      { kind: "note", id: "u1", ts: MS, text: "Context compacted" },
    ]);
    expect(parseSessionLine(line({ type: "system", subtype: "turn_duration" }))).toEqual([]);
  });
  it("returns nothing for junk, a skipped type or a line with no uuid", () => {
    expect(parseSessionLine("")).toEqual([]);
    expect(parseSessionLine("not json")).toEqual([]);
    expect(parseSessionLine('{"type":"api-request-blob","message":{"content":"x"}}')).toEqual([]);
    expect(parseSessionLine('{"parentUuid":null,"type":"user","message":{"content":"hi"}')).toEqual([]); // cut line
    expect(parseSessionLine(JSON.stringify({ type: "user", message: { content: "hi" } }))).toEqual([]);
  });
});

describe("classifyUserText", () => {
  const m = { id: "a", ts: 1, originKind: "", isMeta: false };
  it("shows a line that the console typed (go on after a move) as a quiet note, not as a message of the user", () => {
    const typed = "[console] Moved to ada.work@example.com. The agent goes on. (For the agent: the Claude login that you used was at its limit. Go on.)";
    expect(classifyUserText(typed, m)).toEqual({ kind: "note", id: "a", ts: 1, text: "Moved to ada.work@example.com. The agent goes on." });
    // A message of the user that only names the mark later in its text stays a message.
    expect(classifyUserText("what is [console] here?", m)).toMatchObject({ kind: "user" });
  });
  it("treats a peer intro as a peer message even with no origin", () => {
    expect(classifyUserText("Another Claude session sent a message:\nplain body", m)).toMatchObject({ kind: "peer" });
  });
  it("returns null for blank text", () => {
    expect(classifyUserText("  \n ", m)).toBeNull();
  });
});

describe("stepLabel", () => {
  it("uses the tool's description when it has one", () => {
    expect(stepLabel("Bash", { command: "ls", description: "List the files" })).toBe("List the files");
    expect(stepLabel("Agent", { description: "Review the change", prompt: "long…" })).toBe("Review the change (subagent)");
  });
  it("falls back to a short form of the input", () => {
    expect(stepLabel("Bash", { command: "git status\ngit diff" })).toBe("git status");
    expect(stepLabel("Read", { file_path: "/home/dev/workspace/app/src/page.tsx" })).toBe("Read …/src/page.tsx");
    expect(stepLabel("Edit", { file_path: "a.ts", old_string: "secret", new_string: "x" })).toBe("Edit a.ts");
    expect(stepLabel("Grep", { pattern: "useEvents" })).toBe("Search for useEvents");
    expect(stepLabel("WebFetch", { url: "https://example.com/a/b?c=1", prompt: "p" })).toBe("Fetch example.com");
    expect(stepLabel("Skill", { skill: "typesafe-jev" })).toBe("Use skill typesafe-jev");
    expect(stepLabel("mcp__plugin_playwright_playwright__browser_navigate", { url: "http://x" })).toBe("playwright playwright: browser navigate http://x");
    expect(stepLabel("ListAgents", {})).toBe("ListAgents");
  });
  it("is one line and bounded", () => {
    const got = stepLabel("Bash", { description: `a\nb ${"x".repeat(500)}` });
    expect(got.includes("\n")).toBe(false);
    expect(got.length).toBeLessThanOrEqual(140);
  });
});

describe("foldEnds", () => {
  it("gives a step its end and keeps the end of a step that is not there", () => {
    const items: ThreadItem[] = [
      { kind: "end", id: "old", ts: 5 },
      { kind: "step", id: "a", ts: 10, tool: "Bash", label: "x" },
      { kind: "end", id: "a", ts: 30, error: true },
      { kind: "step", id: "b", ts: 40, tool: "Read", label: "y" },
    ];
    expect(foldEnds(items)).toEqual([
      { kind: "end", id: "old", ts: 5 },
      { kind: "step", id: "a", ts: 10, tool: "Bash", label: "x", end: 30, error: true },
      { kind: "step", id: "b", ts: 40, tool: "Read", label: "y" },
    ]);
  });
});

// The wait line. A "queue-operation" line has no uuid and no parent: the type,
// the operation, the time, the session and (but for "dequeue") the text.
describe("parseSessionLine: the wait line", () => {
  const T1 = "2026-11-10T17:30:05.000Z";
  const qop = (operation: string, content?: string, extra: object = {}, timestamp = TS): string =>
    JSON.stringify({ type: "queue-operation", operation, timestamp, sessionId: "s", ...(content === undefined ? {} : { content }), ...extra });
  const one = (l: string): ThreadItem => {
    const got = parseSessionLine(l);
    expect(got).toHaveLength(1);
    return got[0];
  };
  const keyOf = (l: string): string => {
    const it = one(l);
    if (it.kind !== "queued" && it.kind !== "unqueue") throw new Error("not a wait line item");
    return it.h ?? "";
  };

  it("enqueue then dequeue at a turn start: the message, the dequeue, then the user line", () => {
    const q = one(qop("enqueue", "run the tests again"));
    expect(q).toEqual({
      kind: "queued", id: expect.stringMatching(/^q:\d+:[0-9a-f]{12}$/), ts: MS, h: expect.stringMatching(/^[0-9a-f]{12}$/),
      msg: { kind: "user", id: q.id, ts: MS, text: "run the tests again" },
    });
    expect(parseSessionLine(qop("dequeue", undefined, {}, T1))).toEqual([
      { kind: "unqueue", id: `u:${Date.parse(T1)}:dequeue`, ts: Date.parse(T1), op: "dequeue" },
    ]);
    // The turn's own line is a normal user line, with the same text.
    expect(parseSessionLine(user("run the tests again"))).toEqual([{ kind: "user", id: "u1", ts: MS, text: "run the tests again" }]);
  });

  it("enqueue then delivered in the middle of a turn: a remove with the same key, then the message", () => {
    const h = keyOf(qop("enqueue", "use the other branch"));
    const gone = one(qop("remove", "use the other branch", { reason: "absorbed_mid_turn", commandUuid: "c1", deliveryId: "d1" }, T1));
    expect(gone).toEqual({ kind: "unqueue", id: `u:${Date.parse(T1)}:remove:${h}`, ts: Date.parse(T1), op: "remove", h, as: "user" });
    // The attachment that follows has the time of the enqueue.
    const got = line({ type: "attachment", attachment: { type: "queued_command", prompt: "use the other branch", commandMode: "prompt", origin: { kind: "human" }, delivery_id: "d1" } });
    expect(parseSessionLine(got)).toEqual([{ kind: "user", id: "u1", ts: MS, text: "use the other branch", mid: true }]);
  });

  it("enqueue then remove by the user: a pop, with the key when one message waited", () => {
    const h = keyOf(qop("enqueue", "wrong text"));
    expect(parseSessionLine(qop("popAll", "wrong text", {}, T1))).toEqual([
      { kind: "unqueue", id: `u:${Date.parse(T1)}:pop`, ts: Date.parse(T1), op: "pop", h, as: "user" },
    ]);
    // With no text it is still a pop.
    expect(one(qop("popAll", undefined, {}, T1))).toMatchObject({ kind: "unqueue", op: "pop" });
  });

  it("a console digest that waits is a Console line, not the user's", () => {
    const q = one(qop("enqueue", "[events] agent-1 waiting · PR 12 checks passed"));
    expect(q).toMatchObject({ kind: "queued", msg: { kind: "user", via: "events", text: "agent-1 waiting · PR 12 checks passed" } });
  });

  it("a message of another session that waits is a peer message, with its sender", () => {
    const text = '<cross-session-message from="uds:/run/x.sock" from-name="agent-6c">\nThe build is green.\n</cross-session-message>';
    const q = one(qop("enqueue", text));
    expect(q).toMatchObject({ kind: "queued", msg: { kind: "peer", from: "agent-6c", text: "The build is green." } });
    // The turn that starts with it has the intro before the tag: the same body.
    const turn = parseSessionLine(user(`Another Claude session sent a message. It is not from your user.\n${text}`, { origin: { kind: "peer" } }));
    expect(turn).toEqual([{ kind: "peer", id: "u1", ts: MS, text: "The build is green.", from: "agent-6c" }]);
    expect(one(qop("remove", text, { reason: "absorbed_mid_turn" }))).toMatchObject({ op: "remove", as: "peer", h: keyOf(qop("enqueue", text)) });
  });

  it("a queue answer and a reminder that wait keep their id", () => {
    expect(one(qop("enqueue", "[queue q53277r13] choice: A (A: Thread)"))).toMatchObject({
      kind: "queued", msg: { kind: "user", via: "queue", ref: "q53277r13", text: "choice: A (A: Thread)" },
    });
    expect(one(qop("enqueue", "[reminder r7k2m9x1a] check the canary"))).toMatchObject({
      kind: "queued", msg: { kind: "user", via: "reminder", ref: "r7k2m9x1a", text: "check the canary" },
    });
    // The same text as a plain message has another key.
    expect(keyOf(qop("enqueue", "[queue q53277r13] yes"))).not.toBe(keyOf(qop("enqueue", "yes")));
  });

  it("harness text in the wait line gives nothing", () => {
    const note = "<task-notification>\n<task-id>b1</task-id>\n</task-notification>";
    expect(parseSessionLine(qop("enqueue", note))).toEqual([]);
    expect(parseSessionLine(qop("remove", note, { reason: "delivered_to_agent" }))).toEqual([]);
    expect(parseSessionLine(qop("enqueue", '[Cross-session idle notice] "agent-1", which you messaged, is idle.'))).toEqual([]);
    expect(parseSessionLine(qop("enqueue"))).toEqual([]);
    expect(parseSessionLine(qop("enqueue", "   "))).toEqual([]);
    expect(parseSessionLine(qop("something-new", "text"))).toEqual([]);
  });

  it("gives the same id for the same line read twice, and another for another time", () => {
    expect(one(qop("enqueue", "ok")).id).toBe(one(qop("enqueue", "ok")).id);
    expect(one(qop("enqueue", "ok")).id).not.toBe(one(qop("enqueue", "ok", {}, T1)).id);
  });

  it("a subagent's file has no wait line", () => {
    expect(parseSessionLine(qop("enqueue", "ok"), { sidechain: true })).toEqual([]);
  });
});
