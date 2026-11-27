// server/agents/headless/stream.test.ts — the line builders, and the parser on the captured lines
// of 2.1.332 (../testdata/headless/README.md says where they come from).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_MAX_BYTES, frame, interruptLine, parseEvent, tooLargeWhy, userLine, wellFormed, type StreamEvent } from "./stream.js";
import { SendLog } from "./sendlog.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../testdata/headless/${name}`, import.meta.url)), "utf8").split("\n").filter(Boolean);
const HOLDER = fileURLToPath(new URL("./holder.sh", import.meta.url));
const lines = fixture("stream-2.1.332.txt");
const commands = fixture("stream-2.1.332-commands.txt");
const SESSION = "7d7161d6-77cb-4668-bce9-b9a7f82a5386";
// A lifecycle line by its state; "-": a line that the parser skips.
const kindsOf = (ls: string[]) => ls.map((l) => {
  const e = parseEvent(l);
  return !e ? "-" : e.kind === "lifecycle" ? e.state : e.kind;
}).join(" ");
// Our inputs: the command_uuid of each "queued" line, in order.
const oursOf = (ls: string[]) => ls.map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((v) => v.type === "command_lifecycle" && v.state === "queued").map((v) => v.command_uuid as string);

describe("parseEvent on the captured lines of 2.1.332", () => {
  it("reads the 5 kinds and skips every other line", () => {
    expect(kindsOf(lines)).toBe([
      "- - - - - - - - - - queued started init ack - - queued - - - ack started - - - - completed result completed", // hooks; a tool turn; a message joins it
      "queued started init ack - - - control - result cancelled",                       // an interrupt
      "queued started init - ack result completed",                                     // /model
      "queued started - - - - - - - - - - - - init - - - ack ack result completed",     // /compact
      "queued started init - - ack - - result completed",                               // a last message
    ].join(" "));
  });

  it("gives the fields that the host uses", () => {
    const all = lines.map((l) => parseEvent(l)).filter((e): e is StreamEvent => e !== null);
    expect(all[0]).toEqual({ kind: "lifecycle", commandUuid: "0201e489-c90b-4d06-90ea-1f09f469360c", state: "queued" });
    const ev = all.filter((e) => e.kind !== "lifecycle");
    expect(ev[0]).toEqual({ kind: "init", sessionId: SESSION, model: "claude-haiku-5-5", version: "2.1.332" });
    expect(ev[1]).toMatchObject({ kind: "ack", uuid: "0201e489-c90b-4d06-90ea-1f09f469360c", local: false });
    const res = ev.filter((e) => e.kind === "result");
    expect(res.map((e) => [e.subtype, e.isError, e.text, e.turns])).toEqual([
      ["success", false, "SECOND", 2],                        // the joined message: one result, its text
      ["error_during_execution", true, null, 3],              // no "result" key
      ["success", false, "Set model to `Haiku 5.5` for this session only", 0],
      ["success", false, "", 0],
      ["success", false, "END", 1],
    ]);
    expect(res.every((e) => e.sessionId === SESSION)).toBe(true);
    expect(ev.find((e) => e.kind === "control")).toEqual({ kind: "control", requestId: "int-capture-1", ok: true });
    // A local command: its replay is a string with its name and args; its stdout is a local ack.
    expect(ev.filter((e) => e.kind === "ack" && e.text.startsWith("<command-name>")).map((e) => (e as { text: string }).text)).toEqual([
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>",
      "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>",
    ]);
    expect(ev.filter((e) => e.kind === "ack" && e.local)).toEqual([
      { kind: "ack", uuid: "2f463e34-8b38-4433-b976-123794a2fb1a", text: "<local-command-stdout>Compacted </local-command-stdout>", local: true },
    ]);
  });

  it("skips a line of an unknown kind, and never throws", () => {
    const odd: unknown[] = [
      '{"type":"brand_new_kind","x":1}', '{"type":"system","subtype":"brand_new"}', '{"type":"stream_event","event":{}}',
      "not json", "", "[]", "null", "42", '"text"', '{"type":null}', '{"type":"user"}', '{"type":"user","isReplay":"true"}',
      null, undefined, 7, [], { type: "system" }, { type: "control_request" },
    ];
    for (const v of odd) expect(() => parseEvent(v)).not.toThrow();
    expect(odd.map((v) => parseEvent(v))).toEqual(odd.map(() => null));
  });

  it("takes a changed field as absent, and keeps the kind", () => {
    expect(parseEvent({ type: "system", subtype: "init", session_id: 5, model: ["m"], claude_code_version: 3 }))
      .toEqual({ kind: "init", sessionId: null, model: null, version: null });
    // is_error as a text, num_turns as a text, no result, no session.
    expect(parseEvent({ type: "result", subtype: "success", is_error: "true", num_turns: "1" }))
      .toEqual({ kind: "result", subtype: "success", isError: false, sessionId: null, text: null, turns: null });
    // The content as one text, as blocks with other kinds, or missing.
    expect(parseEvent({ type: "user", isReplay: true, uuid: "u1", message: { content: "plain" } })).toMatchObject({ text: "plain", uuid: "u1" });
    expect(parseEvent({ type: "user", isReplay: true, message: { content: [{ type: "image" }, { type: "text", text: "a" }, { type: "text", text: "b" }] } }))
      .toEqual({ kind: "ack", uuid: null, text: "a\nb", local: false });
    expect(parseEvent({ type: "user", isReplay: true })).toEqual({ kind: "ack", uuid: null, text: "", local: false });
    expect(parseEvent({ type: "user", isReplay: true, isSynthetic: true, message: { content: "x" } })).toBeNull();
    expect(parseEvent({ type: "control_response", response: { subtype: "error", error: "x" } }))
      .toEqual({ kind: "control", requestId: null, ok: false });
    expect(parseEvent({ type: "control_response" })).toEqual({ kind: "control", requestId: null, ok: false });
    expect(parseEvent({ type: "command_lifecycle", command_uuid: 7, state: ["completed"] })).toEqual({ kind: "lifecycle", commandUuid: null, state: null });
  });
});

describe("the send log on the captured lines", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "headless-stream-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("each of the 6 inputs is taken once, by its own replay; a second read of all lines takes nothing", () => {
    const ours = oursOf(lines);
    expect(ours).toHaveLength(6);
    const log = new SendLog(join(dir, "sendlog.json"));
    const texts = ["Use the Bash tool to run exactly `sleep 8; echo tick`. Then reply with the single word DONE.",
      "Reply with the single word SECOND.",
      "Use the Bash tool to run exactly `sleep 30; echo late`. Then reply with the single word LATE.",
      "/model haiku", "/compact", "Reply with the single word END."];
    texts.forEach((t, i) => log.add(t, { uuid: ours[i] }));
    const pass = () => {
      const taken: Array<string | null> = [];
      for (const l of lines) {
        const e = parseEvent(l);
        if (e?.kind !== "ack" || e.local) continue;
        const r = log.ackReplay(e.uuid, e.text);
        taken.push(r?.fresh ? r.entry.uuid : null);
      }
      return taken;
    };
    expect(pass()).toEqual(ours);
    expect(log.open()).toEqual([]);
    expect(pass()).toEqual(ours.map(() => null));
  });

  it("the end of each lifecycle alone also takes each of the 6 inputs once (the interrupted one by cancelled)", () => {
    const ours = oursOf(lines);
    const log = new SendLog(join(dir, "sendlog.json"));
    ours.forEach((u, i) => log.add(`input ${i}`, { uuid: u }));
    const taken: string[] = [];
    for (const l of lines) {
      const e = parseEvent(l);
      if (e?.kind !== "lifecycle" || !e.commandUuid || (e.state !== "completed" && e.state !== "cancelled")) continue;
      if (log.ackCommand(e.commandUuid)?.fresh) taken.push(`${ours.indexOf(e.commandUuid)} ${e.state}`);
    }
    // In the order of the lines: the joined message (1) ends before the tool turn's own input (0).
    expect(taken).toEqual(["1 completed", "0 completed", "2 cancelled", "3 completed", "4 completed", "5 completed"]);
    expect(log.open()).toEqual([]);
  });
});

describe("the captured commands of 2.1.332 (/clear, an unknown command, a text that starts with \"/\")", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "headless-stream-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const TEXTS = ["/clear", "/nosuchcmd now", "/tmp/x is full", "Reply with the single word END."];

  it("reads the 5 kinds; conversation_reset is skipped", () => {
    expect(kindsOf(commands)).toBe([
      "- - - - - - - - - - queued started - - - - - - - - - - - - init ack result completed", // hooks; /clear: conversation_reset, a task note, the hooks again
      "queued started init - - ack - - - result completed",                                  // /nosuchcmd now: to the model
      "queued started init ack - - - - - - - - - - - - result completed",                     // /tmp/x is full: 2 tool calls
      "queued started init ack - result completed",                                           // a last message
    ].join(" "));
    const reset = commands.map((l) => JSON.parse(l) as Record<string, unknown>).find((v) => v.type === "conversation_reset");
    expect(reset).toMatchObject({ trigger: "clear", user_message_uuid: oursOf(commands)[0] });
    expect(parseEvent(reset)).toBeNull();
  });

  it("the replays: /clear as a command, the others as typed; /clear gives a new session id", () => {
    const ev = commands.map((l) => parseEvent(l)).filter((e): e is StreamEvent => e !== null);
    expect(ev.filter((e) => e.kind === "ack").map((e) => (e as { text: string }).text)).toEqual([
      "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
      ...TEXTS.slice(1),
    ]);
    const before = (JSON.parse(commands[0]!) as { session_id: string }).session_id;
    const after = ev.filter((e) => e.kind === "init").map((e) => (e as { sessionId: string }).sessionId);
    expect(new Set(after).size).toBe(1);
    expect(after[0]).not.toBe(before);
    expect(ev.filter((e) => e.kind === "result").map((e) => (e as { turns: number }).turns)).toEqual([0, 1, 3, 1]);
  });

  it("each of the 4 inputs is taken once by its replay, and once by its lifecycle alone", () => {
    const ours = oursOf(commands);
    expect(ours).toHaveLength(4);
    const byReplay = new SendLog(join(dir, "a.json"));
    const byLifecycle = new SendLog(join(dir, "b.json"));
    TEXTS.forEach((t, i) => { byReplay.add(t, { uuid: ours[i] }); byLifecycle.add(t, { uuid: ours[i] }); });
    const a: string[] = [];
    const b: string[] = [];
    for (const l of [...commands, ...commands]) { // the second read takes nothing
      const e = parseEvent(l);
      if (e?.kind === "ack" && !e.local && byReplay.ackReplay(e.uuid, e.text)?.fresh) a.push(e.uuid!);
      if (e?.kind === "lifecycle" && e.commandUuid && e.state === "completed" && byLifecycle.ackCommand(e.commandUuid)?.fresh) b.push(e.commandUuid);
    }
    expect(a).toEqual(ours);
    expect(b).toEqual(ours);
    expect([...byReplay.open(), ...byLifecycle.open()]).toEqual([]);
  });
});

describe("the line builders", () => {
  it("a message is one JSON line with its uuid, printable ASCII only, with the same text", () => {
    const text = "two\nlines é 😀     \u007f \u0000 \u0001 \t \\ \"";
    const l = userLine("u-1", text);
    expect(l).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(l)).toEqual({
      type: "user", message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null, session_id: "", uuid: "u-1",
    });
    expect(JSON.parse(interruptLine("int-1"))).toEqual({ type: "control_request", request_id: "int-1", request: { subtype: "interrupt" } });
  });

  it("a lone surrogate becomes U+FFFD; a pair stays", () => {
    expect(wellFormed("a\ud800b\udc00c😀")).toBe("a�b�c😀");
    expect((JSON.parse(userLine("u", "x\udc00")) as { message: { content: Array<{ text: string }> } }).message.content[0]!.text).toBe("x�");
  });

  it("a frame: its length is the JSON's bytes; a cut write leaves a short line", () => {
    const json = userLine("u-2", "é😀");
    const f = frame("u-2", json);
    const s = f.toString("latin1");
    expect(s.startsWith("\n") && s.endsWith("\n")).toBe(true);
    const [len, id, ...rest] = s.slice(1, -1).split(" ");
    expect(id).toBe("u-2");
    expect(Number(len)).toBe(Buffer.byteLength(rest.join(" ")));
    expect(f.length).toBe(Buffer.byteLength(s, "latin1"));
  });

  it("refuses a bad id, a byte that is not printable ASCII, and a message above the limit", () => {
    expect(() => frame("a b", "{}")).toThrow();
    expect(() => frame("a_b", "{}")).toThrow();
    expect(() => frame("x".repeat(65), "{}")).toThrow();
    expect(() => frame("ok", "{\n}")).toThrow();
    expect(() => frame("ok", "{\"é\"}")).toThrow();
    expect(() => frame("ok", "{\u007f}")).toThrow();
    const big = userLine("u-3", "a".repeat(HEADLESS_MAX_BYTES));
    expect(tooLargeWhy(big)).toMatch(/^the message is \d+ bytes as JSON; a worker takes at most 1048576$/);
    expect(() => frame("u-3", big)).toThrow(RangeError);
    expect(tooLargeWhy(userLine("u-4", "a".repeat(HEADLESS_MAX_BYTES - 200)))).toBeNull();
  });

  it("the relay's limit (MAX in holder.sh) is HEADLESS_MAX_BYTES", () => {
    expect(/^MAX=(\d+)/m.exec(readFileSync(HOLDER, "utf8"))?.[1]).toBe(String(HEADLESS_MAX_BYTES));
  });
});
