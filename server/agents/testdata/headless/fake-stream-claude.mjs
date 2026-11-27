#!/usr/bin/env node
// server/agents/testdata/headless/fake-stream-claude.mjs — a fake `claude -p` with a message
// stream, for the tests of the headless host. No model, no network. As claude 2.1.332
// (stream-2.1.332.txt, stream-2.1.332-commands.txt and README.md here):
//   - input lines end at "\n" only (not at U+2028/U+2029); an empty line is skipped; a line that is
//     not JSON ends it at once, with claude's error text (exit 1);
//   - each input: command_lifecycle queued (command_uuid = the uuid of our line), started, …,
//     completed: a message that joined a turn before the result, the turn's own input after it;
//     at an interrupt: the result, then cancelled;
//   - a message: init, its replay (with our uuid), an assistant text, a result;
//   - a message that comes during a turn joins it: its replay, one more turn, and the result has
//     the text of the last reply;
//   - an input that starts with "/" never joins a turn. A known local command (/compact, /model,
//     /clear, /context) waits until the turn ends. /model: init, the assistant text, the replay
//     "<command-name>/model</command-name>…" with our uuid, a result with the same text, 0 turns.
//     /compact as the real one (status, init, compact_boundary, a synthetic user line, a synthetic
//     assistant line, the replay of its stdout with a new uuid, its own replay with our uuid, a
//     result with "", 0 turns). /clear as the real one: conversation_reset (user_message_uuid =
//     our uuid), a new session id, init, its replay, a result with "", 0 turns. An unknown
//     command ("/nosuchcmd now") is a message to the model, as "/tmp/x is full";
//   - /fake-noreplay (the fake's own): a local command with no replay (an input that only its
//     command_lifecycle closes);
//   - an interrupt: control_response success, "[Request interrupted by user]", then a result
//     error_during_execution with no "result" key.
// Knobs at the start of a message: "[fake sleep=<ms> split=<ms>]": the turn takes <ms>; the
// result line is written in two parts, <ms> apart.
// FAKE_LOG: each input line that it read, appended as one JSON line (for the tests).
// FAKE_ENV_LOG: at start, {env, umask} of this process, as one JSON line.
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const at = args.indexOf("--resume");
let sessionId = at >= 0 && args[at + 1] ? args[at + 1] : randomUUID();
let model = "claude-haiku-5-5";
let lastText = "";
const queue = [];
// While a message runs: { timer, uuids (its commands), turns, text, split, joinable }.
let turn = null;

if (process.env.FAKE_ENV_LOG) {
  const umask = /^Umask:\s*(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? null;
  appendFileSync(process.env.FAKE_ENV_LOG, `${JSON.stringify({ env: process.env, umask })}\n`);
}

const out = (v) => writeSync(1, `${JSON.stringify(v)}\n`);
const usage = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 7 };
const lifecycle = (uuid, state) => out({ type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: sessionId });

function init() {
  out({
    type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["Bash", "Read", "Edit"],
    mcp_servers: [], model, permissionMode: "bypassPermissions", slash_commands: ["compact", "context", "model", "clear"],
    apiKeySource: "none", claude_code_version: "2.1.332", output_style: "default", agents: ["general-purpose"], skills: [],
    plugins: [], uuid: randomUUID(), user_message_uuids: [],
  });
}
const assistant = (text) => {
  lastText = text;
  out({
    type: "assistant", parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(),
    message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: null, usage },
  });
};
const replay = (message, uuid) => out({ type: "user", message, parent_tool_use_id: null, session_id: sessionId, uuid, timestamp: new Date().toISOString(), isReplay: true });
// As 2.1.332: "type" is not the first key; an error result has no "result" key.
const result = (subtype, text, turns, isError = false) => ({
  duration_api_ms: turns ? 10 : 0, stop_reason: isError ? null : "end_turn", session_id: sessionId, type: "result", subtype,
  is_error: isError, duration_ms: 12, num_turns: turns, ...(isError ? {} : { result: text }), total_cost_usd: 0, usage,
  modelUsage: {}, permission_denials: [], uuid: randomUUID(),
});
const textOf = (m) => (typeof m?.content === "string" ? m.content
  : Array.isArray(m?.content) ? m.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");
const command = (name, a) => `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${a}</command-args>`;

function knobs(text) {
  const m = /^\[fake([^\]]*)\]/.exec(text);
  const get = (k) => Number((new RegExp(`${k}=(\\d+)`).exec(m?.[1] ?? "") ?? [])[1] ?? 0);
  return { sleep: get("sleep"), split: get("split") };
}

// The end of a turn: completed of the joined messages, the result line (whole or in two parts: a
// cut line in out.jsonl for a while), completed of the turn's own input.
function end(uuids, line, split) {
  for (const u of uuids.slice(1)) lifecycle(u, "completed");
  const buf = Buffer.from(`${JSON.stringify(line)}\n`);
  const done = () => { if (uuids[0]) lifecycle(uuids[0], "completed"); turn = null; next(); };
  if (!split) { writeSync(1, buf); done(); return; }
  const half = Math.floor(buf.length / 2) + 1; // may cut a UTF-8 char: the reader must wait anyway
  writeSync(1, buf.subarray(0, half));
  turn = { timer: setTimeout(() => { writeSync(1, buf.subarray(half)); done(); }, split), uuids: [], joinable: false };
}

function local(msg, text) {
  const uuid = msg.uuid ?? randomUUID();
  const [name, ...rest] = text.trim().split(/\s+/);
  const a = rest.join(" ");
  lifecycle(uuid, "started");
  if (name === "/compact") {
    out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId, uuid: randomUUID() });
    out({ type: "system", subtype: "status", status: null, session_id: sessionId, uuid: randomUUID() });
    init();
    out({ type: "system", subtype: "compact_boundary", session_id: sessionId, uuid: randomUUID(), compact_metadata: { trigger: "manual", pre_tokens: 36000 } });
    out({ type: "user", message: { role: "user", content: "This session is being continued from a previous conversation." }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), isReplay: false, isSynthetic: true });
    if (lastText) assistant(lastText);
    replay({ role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, randomUUID());
    replay({ role: "user", content: command(name, a) }, uuid);
    end([uuid], result("success", "", 0), 0);
    return;
  }
  if (name === "/clear") {
    const conv = randomUUID(); // as captured: the new session id is another uuid
    out({ type: "conversation_reset", new_conversation_id: conv, uuid: conv, trigger: "clear", user_message_uuid: uuid, timestamp: new Date().toISOString(), session_id: sessionId });
    sessionId = randomUUID();
  }
  init();
  let said = "";
  if (name === "/model") said = `Set model to \`${a}\` for this session only`;
  else if (name !== "/clear") said = `Ran ${name}`;
  if (said) assistant(said);
  if (name !== "/fake-noreplay") replay({ role: "user", content: command(name, a) }, uuid);
  if (name === "/model") model = `claude-${a}-5-5`;
  end([uuid], result("success", said, 0), 0);
}

const LOCAL = new Set(["/compact", "/model", "/clear", "/context", "/fake-noreplay"]);

function next() {
  if (turn || queue.length === 0) return;
  const msg = queue.shift();
  const text = textOf(msg.message);
  if (LOCAL.has(text.trim().split(/\s+/)[0])) { local(msg, text); return; }
  const k = knobs(text);
  const uuid = msg.uuid ?? randomUUID();
  lifecycle(uuid, "started");
  init();
  replay(msg.message, uuid);
  assistant(`echo: ${text.slice(0, 40)}`);
  turn = { uuids: [uuid], turns: 1, text: `echo: ${text.slice(0, 40)}`, split: k.split, joinable: true };
  turn.timer = setTimeout(() => end(turn.uuids, result("success", turn.text, turn.turns), turn.split), k.sleep);
}

// A message during a turn: Claude takes it into the turn (captured).
function join(msg) {
  const text = textOf(msg.message);
  const uuid = msg.uuid ?? randomUUID();
  replay(msg.message, uuid);
  lifecycle(uuid, "started");
  assistant(`echo: ${text.slice(0, 40)}`);
  turn.uuids.push(uuid);
  turn.turns += 1;
  turn.text = `echo: ${text.slice(0, 40)}`;
}

function interrupt(requestId) {
  out({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { still_queued: [] } } });
  if (!turn?.joinable) return;
  clearTimeout(turn.timer);
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString() });
  out(result("error_during_execution", "", turn.turns, true));
  for (const u of turn.uuids) lifecycle(u, "cancelled");
  turn = null;
  next();
}

function onLine(line) {
  if (line.trim() === "") return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) {
    process.stderr.write(`Error parsing streaming input line (type=user, ${line.length} chars): ${e}\n`);
    process.exit(1);
  }
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(msg)}\n`);
  if (msg?.type === "control_request" && msg.request?.subtype === "interrupt") { interrupt(msg.request_id); return; }
  if (msg?.type !== "user") return;
  lifecycle(msg.uuid ?? randomUUID(), "queued");
  if (turn?.joinable && !textOf(msg.message).startsWith("/") && queue.length === 0) { join(msg); return; }
  queue.push(msg);
  next();
}

// Lines end at "\n" only, as claude reads them (readline would also end one at U+2028/U+2029).
let pending = Buffer.alloc(0);
process.stdin.on("data", (d) => {
  pending = Buffer.concat([pending, d]);
  let i;
  while ((i = pending.indexOf(0x0a)) >= 0) {
    const line = pending.subarray(0, i).toString("utf8");
    pending = pending.subarray(i + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => {
  if (pending.length) onLine(pending.toString("utf8"));
  const quit = () => { if (turn || queue.length) setTimeout(quit, 20); else process.exit(0); };
  quit();
});
