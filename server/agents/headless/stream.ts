// server/agents/headless/stream.ts — the lines of claude's message stream (`-p --input-format
// stream-json --output-format stream-json --verbose --replay-user-messages`), as 2.1.332 writes them.
//
// In: one JSON line per user message or control request, framed for the relay (holder.sh). The
// JSON is printable ASCII only (every other char as \uXXXX), so the relay can refuse any other byte.
// Out: the parser reads 5 kinds and skips every other line (assistant text, tool events, hooks,
// status, rate limits, conversation_reset, …). It never throws: a new Claude Code version can add
// or change lines.
//   init       system/init: before every turn, also of a local command (captured)
//   ack        a user line with isReplay (not isSynthetic): Claude took a message into the session.
//              Its uuid is the uuid of our line, also for a local command ("<command-name>…") and
//              for an unknown command (its text as typed); the stdout of a local command
//              ("<local-command-stdout>…") has a new uuid (captured)
//   lifecycle  command_lifecycle: the state of one input (queued, started, completed, cancelled),
//              with the uuid of our line as command_uuid (captured)
//   result     the end of a turn: the worker is idle
//   control    control_response: the answer to an interrupt
// The fixture and its source: ../testdata/headless/README.md.

// A frame id: the relay checks it with the same pattern.
export const FRAME_ID = /^[A-Za-z0-9-]{1,64}$/;

// The longest frame JSON, in bytes: MAX in holder.sh (a test checks that both say the same).
// Claude ends on an input line above 268435456 chars; a message of this size is a fault.
export const HEADLESS_MAX_BYTES = 1_048_576;

// A lone surrogate becomes U+FFFD (String.prototype.toWellFormed, which the TS lib here lacks).
export function wellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

// JSON with printable ASCII only: JSON.stringify escapes the control chars; this escapes DEL and
// every char above it (U+2028 too, and each half of a surrogate pair).
function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// A message of the user. `uuid` is the id of the message in the session: Claude gives it back in
// the replay (captured). The send log also matches the text, in order, for a version that does not.
export function userLine(uuid: string, text: string): string {
  return asciiJson({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: wellFormed(text) }] },
    parent_tool_use_id: null,
    session_id: "",
    uuid,
  });
}

// Ends the turn now. A message that waits in Claude's queue runs next (measured).
export function interruptLine(requestId: string): string {
  return asciiJson({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } });
}

// The refusal of a message that is too large, or null.
export function tooLargeWhy(json: string): string | null {
  const n = json.length; // ASCII: chars = bytes
  return n > HEADLESS_MAX_BYTES ? `the message is ${n} bytes as JSON; a worker takes at most ${HEADLESS_MAX_BYTES}` : null;
}

// "\n<bytes> <id> <json>\n": the "\n" in front ends a line that an earlier write cut.
export function frame(id: string, json: string): Buffer {
  if (!FRAME_ID.test(id)) throw new Error(`bad frame id ${id}`);
  if (/[^\x20-\x7e]/.test(json)) throw new Error("a frame holds printable ASCII only");
  const why = tooLargeWhy(json);
  if (why) throw new RangeError(why);
  return Buffer.from(`\n${json.length} ${id} ${json}\n`, "latin1");
}

export type StreamEvent =
  | { kind: "init"; sessionId: string | null; model: string | null; version: string | null }
  // local: the stdout of a local command (/compact), not a message of the user.
  | { kind: "ack"; uuid: string | null; text: string; local: boolean }
  | { kind: "lifecycle"; commandUuid: string | null; state: string | null }
  | { kind: "result"; subtype: string | null; isError: boolean; sessionId: string | null; text: string | null; turns: number | null }
  | { kind: "control"; requestId: string | null; ok: boolean };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The text of a message: a string, or the text blocks of a content list.
function textOf(message: unknown): string {
  if (!isObj(message)) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => (b as Obj).text as string).join("\n");
}

// One line of out.jsonl (its text, or the parsed value). null: a line of another kind.
export function parseEvent(line: unknown): StreamEvent | null {
  let v: unknown = line;
  if (typeof line === "string") {
    try { v = JSON.parse(line); } catch { return null; }
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "system":
      if (v.subtype !== "init") return null;
      return { kind: "init", sessionId: str(v.session_id), model: str(v.model), version: str(v.claude_code_version) };
    case "user": {
      if (v.isReplay !== true || v.isSynthetic === true) return null;
      const text = textOf(v.message);
      return { kind: "ack", uuid: str(v.uuid), text, local: text.startsWith("<local-command-") };
    }
    case "result":
      return {
        kind: "result", subtype: str(v.subtype), isError: v.is_error === true, sessionId: str(v.session_id),
        text: str(v.result), turns: num(v.num_turns),
      };
    case "command_lifecycle":
      return { kind: "lifecycle", commandUuid: str(v.command_uuid), state: str(v.state) };
    case "control_response": {
      const r = isObj(v.response) ? v.response : {};
      return { kind: "control", requestId: str(r.request_id), ok: r.subtype === "success" };
    }
    default:
      return null;
  }
}
