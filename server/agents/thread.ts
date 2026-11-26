// server/agents/thread.ts — pure parsing of a Claude Code session file
// (<config dir>/projects/<cwd slug>/<sessionId>.jsonl) into the items of the
// Agents thread view: what the user sent, what the agent said, and the tool
// steps between. One JSONL line in, zero or more items out. File access stays
// in threadfile.ts; this module is string → shape.
//
// The session format is the harness's, not ours: every field is checked, and a
// line that does not fit yields nothing (fail soft per line).
import { createHash } from "node:crypto";
import { consoleNote } from "./consoleline.js";

// A message in the agent's wait line. A prompt that arrives while the agent
// works is not a turn yet: the harness writes a "queue-operation" line
// (enqueue) and takes the message later. It then writes "remove" and hands the
// text to the model in the middle of the turn (an attachment), or "dequeue"
// and starts the next turn with it (a user line). "popAll": the user took the
// waiting text back into the input box. These lines have no uuid, so the id is
// made from the time and `h`, a short hash of the kind and the text: the key
// that joins an enqueue with the line that takes it out.
export type QueuedMessage =
  | { kind: "user"; id: string; ts: number; text: string; via?: "queue" | "events" | "reminder" | "command" | "shell"; ref?: string }
  | { kind: "peer"; id: string; ts: number; text: string; from?: string };

export type ThreadItem =
  // A prompt the agent received as a user turn. `via` names a prompt the user
  // did not type as plain text: a queue answer ("[queue <id>] …", ref = the
  // id), a console event line ("[events] …"), a reminder the console delivered
  // ("[reminder <id>] …", ref = the id), a slash command, a "!" shell line.
  // `mid`: the agent got it in the middle of a turn (it waited in the line).
  // `q` is set by the client only (src/lib/thread.ts): a message that left the
  // wait line unread ("lost": its session ended first; "back": the user took
  // it back into the input box).
  | { kind: "user"; id: string; ts: number; text: string; via?: "queue" | "events" | "reminder" | "command" | "shell"; ref?: string; mid?: true; q?: "lost" | "back" }
  // A message from another Claude session (SendMessage).
  | { kind: "peer"; id: string; ts: number; text: string; from?: string; mid?: true; q?: "lost" | "back" }
  // A message that went into the wait line. Whether it still waits is for the
  // reader of the whole list to tell (queueView in src/lib/thread.ts).
  | { kind: "queued"; id: string; ts: number; h: string; msg: QueuedMessage }
  // Something left the wait line. "remove": taken in the middle of a turn (the
  // message itself follows as a `mid` item). "pop": taken back by the user.
  // "dequeue": the next turn starts with the head of the line (the harness
  // does not say which text; the user line that follows does). "line": a user
  // line that is not shown (a harness prompt) and may have waited in the line.
  // `as`: the kind of message it was, when the line says.
  | { kind: "unqueue"; id: string; ts: number; op: "remove" | "pop" | "dequeue" | "line"; h?: string; as?: "user" | "peer" }
  // `final` (subagent files only): the message that ended a turn.
  | { kind: "assistant"; id: string; ts: number; text: string; final?: true }
  // One tool call. `end` is the time of its result; absent while it runs.
  // A subagent launch (Agent, Task) gets `agent`, the subagent's id, from its
  // result; with `bg` that result is only the launch ("Async agent launched"),
  // so `end` is not when the subagent finished (see subagents.ts for that).
  | { kind: "step"; id: string; ts: number; tool: string; label: string; end?: number; error?: boolean; agent?: string; bg?: true }
  // The result of a step that is not in the same page (the reader folds the
  // others into their step). The client applies it to the step by id.
  | { kind: "end"; id: string; ts: number; error?: boolean; agent?: string; bg?: true }
  // A one-line marker: an interrupt, a compaction, a harness error.
  | { kind: "note"; id: string; ts: number; text: string };

export const MAX_ITEM_TEXT = 60_000;
export const MAX_STEP_LABEL = 140;

// Top-level line types that can hold thread items. Every other type (the
// api-request blobs are megabytes each) is skipped before JSON.parse.
const WANTED = new Set(["user", "assistant", "attachment", "system", "queue-operation"]);
const TYPE_FIRST_RE = /^\{"type":"([A-Za-z_-]+)"/;

// False for a line whose first key is a `type` this module never reads. A line
// with another first key (message lines start with parentUuid) is parsed.
export function wantsLine(head: string): boolean {
  const m = TYPE_FIRST_RE.exec(head);
  return m === null || WANTED.has(m[1]);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function clip(text: string, max = MAX_ITEM_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n\n… (truncated)`;
}

function oneLine(text: string, max = MAX_STEP_LABEL): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

// The last two segments of a path: enough to know the file, short enough for a line.
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : `…/${parts.slice(-2).join("/")}`;
}

function host(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

// The line a step shows: the tool's own description when it has one (Bash,
// Agent), else a short form of its input. Never the full input.
export function stepLabel(tool: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const desc = str(i.description).trim();
  switch (tool) {
    case "Bash": return oneLine(desc || str(i.command).split("\n")[0] || "Run a command");
    case "Agent":
    case "Task": return oneLine(`${desc || "Run a subagent"} (subagent)`);
    case "Read": return oneLine(`Read ${shortPath(str(i.file_path))}`);
    case "Edit":
    case "MultiEdit": return oneLine(`Edit ${shortPath(str(i.file_path))}`);
    case "Write": return oneLine(`Write ${shortPath(str(i.file_path))}`);
    case "NotebookEdit": return oneLine(`Edit ${shortPath(str(i.notebook_path))}`);
    case "Grep": return oneLine(`Search for ${str(i.pattern)}`);
    case "Glob": return oneLine(`Find files ${str(i.pattern)}`);
    case "WebFetch": return oneLine(`Fetch ${host(str(i.url))}`);
    case "WebSearch": return oneLine(`Search the web: ${str(i.query)}`);
    case "Skill": return oneLine(`Use skill ${str(i.skill)}`);
    case "ToolSearch": return oneLine(`Find tools: ${str(i.query)}`);
    case "TodoWrite": return "Update the plan";
    case "TaskCreate": return oneLine(`Add task: ${str(i.subject)}`);
    case "TaskUpdate": return oneLine(`Update task ${str(i.taskId)}${str(i.status) ? `: ${str(i.status)}` : ""}`);
    case "SendMessage": return oneLine(`Message ${str(i.to) || str(i.recipient)}${str(i.summary) ? `: ${str(i.summary)}` : ""}`);
    case "ScheduleWakeup": return oneLine(str(i.reason) || "Schedule a wakeup");
    default: break;
  }
  if (desc) return oneLine(desc);
  // mcp__<server>__<tool> → "<server>: <tool>".
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const name = mcp ? `${mcp[1].replace(/^plugin_/, "").replace(/_/g, " ")}: ${mcp[2].replace(/_/g, " ")}` : tool;
  const first = Object.values(i).find((v): v is string => typeof v === "string" && v.trim() !== "");
  return oneLine(first ? `${name} ${first}` : name);
}

// A subagent's id as the harness writes it ("a" + 16 hex today). It becomes a
// file name (subagents/agent-<id>.jsonl), so the check is strict: letters and
// digits only.
const AGENT_ID_RE = /^[A-Za-z0-9]{6,64}$/;
export function isSubagentId(v: unknown): v is string {
  return typeof v === "string" && AGENT_ID_RE.test(v);
}
export const isSubagentTool = (tool: string): boolean => tool === "Agent" || tool === "Task";

// The end of a background subagent arrives as a <task-notification> user turn
// (the summary is `Agent "<description>" finished`). It becomes one short
// note; the notification's own text (the subagent's whole result) is not
// shown. Null for every other notification (a background command, a monitor
// event) and for a subagent that only waits on its own background work.
const AGENT_SUMMARY_RE = /^Agent "([\s\S]*)" (finished|came to rest|failed|was stopped|is waiting)\b/;
export function subagentNote(text: string): string | null {
  // A newer harness puts a "[SYSTEM NOTIFICATION …]" paragraph before the tag.
  const at = text.slice(0, 1024).indexOf("<task-notification>");
  if (at < 0) return null;
  // The tags sit before <result>, which holds text the subagent wrote.
  const head = text.slice(at, at + 4096).split("<result>")[0];
  const hit = AGENT_SUMMARY_RE.exec(tag(head, "summary"));
  if (!hit || hit[2] === "is waiting") return null;
  const status = tag(head, "status");
  const what = hit[2] === "failed" || status === "failed" ? "failed"
    : hit[2] === "was stopped" || status === "killed" || status === "stopped" ? "stopped" : "finished";
  return oneLine(`Subagent ${what}: ${hit[1]}`, MAX_STEP_LABEL + 24);
}

// Harness text that arrives as a user turn but is not a message.
const NOISE_PREFIXES = [
  "<task-notification>", "<system-reminder>", "<local-command-", "<bash-stdout>", "<bash-stderr>",
  "<user-prompt-submit-hook>", "Caveat: The messages below were generated by the user while running local commands",
];
const PEER_INTRO = "Another Claude session sent a message";
// In the wait line a peer's message is the bare tag, with no intro.
const PEER_TAG = "<cross-session-message";
// Harness notices that wait in the line like a prompt and are never shown.
const QUEUE_NOISE = ["[Cross-session idle notice]", "Your claude.ai usage limit has reset"];
const PEER_RE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/;
const tag = (text: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? "";

type Meta = { id: string; ts: number; originKind: string; isMeta: boolean };

// One user-turn text → its item, or null for harness noise.
export function classifyUserText(raw: string, m: Meta): ThreadItem | null {
  const text = raw.trim();
  if (!text) return null;
  const { id, ts } = m;
  if (m.originKind === "task-notification" || text.startsWith("<task-notification>")) {
    const note = subagentNote(text);
    return note ? { kind: "note", id, ts, text: note } : null;
  }
  if (m.originKind === "peer" || text.startsWith(PEER_INTRO) || text.startsWith(PEER_TAG)) {
    const hit = PEER_RE.exec(text);
    const from = hit ? /\bfrom-name="([^"]*)"/.exec(hit[1])?.[1] : undefined;
    const body = (hit ? hit[2] : text).trim();
    return body ? { kind: "peer", id, ts, text: clip(body), ...(from ? { from } : {}) } : null;
  }
  if (m.isMeta) return null;
  if (NOISE_PREFIXES.some((p) => text.startsWith(p))) return null;
  // A line that the console typed itself (after a move to another login: "go on"): a quiet
  // note, not a message of the user.
  const fromConsole = consoleNote(text);
  if (fromConsole) return { kind: "note", id, ts, text: fromConsole };
  if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) {
    const name = tag(text, "command-name");
    if (!name) return null;
    const args = tag(text, "command-args");
    return { kind: "user", id, ts, text: clip(args ? `${name} ${args}` : name), via: "command" };
  }
  if (text.startsWith("<bash-input>")) {
    const cmd = tag(text, "bash-input");
    return cmd ? { kind: "user", id, ts, text: clip(`! ${cmd}`), via: "shell" } : null;
  }
  if (text.startsWith("[Request interrupted by user")) return { kind: "note", id, ts, text: "Interrupted" };
  const queue = /^\[queue ([\w.-]{1,64})\]\s*/.exec(text);
  if (queue) return { kind: "user", id, ts, text: clip(text.slice(queue[0].length)), via: "queue", ref: queue[1] };
  const reminder = /^\[reminder ([\w.-]{1,64})\]\s*/.exec(text);
  if (reminder) return { kind: "user", id, ts, text: clip(text.slice(reminder[0].length)), via: "reminder", ref: reminder[1] };
  if (text.startsWith("[events]")) return { kind: "user", id, ts, text: clip(text.slice("[events]".length).trim()), via: "events" };
  return { kind: "user", id, ts, text: clip(text) };
}

// The text of a user message: a string, or the text blocks of an array (an
// image block becomes a marker; a reminder block the harness added is dropped).
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "text" && typeof b.text === "string") {
      if (!b.text.trimStart().startsWith("<system-reminder>")) parts.push(b.text);
    } else if (b.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

// The key of a message in the wait line: its kind and its text (before the
// cut of a long text; a queue answer or a reminder keeps its id in the key).
function queueKey(it: QueuedMessage, full: string): string {
  const head = it.kind === "user" ? `user:${it.via ?? ""}:${it.ref ?? ""}` : "peer";
  return createHash("sha1").update(`${head}\0${full}`).digest("hex").slice(0, 12);
}

// A text of the wait line → the message it is and its key. Null for harness
// text (a task notification, a notice) and for text that is not a message.
function queuedOf(raw: unknown, id: string, ts: number): { msg: QueuedMessage; h: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || QUEUE_NOISE.some((p) => text.startsWith(p))) return null;
  const it = classifyUserText(text, { id, ts, originKind: "", isMeta: false });
  if (!it || (it.kind !== "user" && it.kind !== "peer")) return null;
  // The key is of the whole text: two long texts with the same first 60 000 chars differ.
  const full = it.text.length < MAX_ITEM_TEXT ? it.text : text;
  return { msg: it, h: queueKey(it, full) };
}

// One "queue-operation" line. It has no uuid: the id is the time, the
// operation and the key (the same line read twice gives the same id).
function parseQueueLine(o: Obj): ThreadItem[] {
  const ts = Date.parse(str(o.timestamp)) || 0;
  const op = str(o.operation);
  if (op === "dequeue") return [{ kind: "unqueue", id: `u:${ts}:dequeue`, ts, op: "dequeue" }];
  if (op !== "enqueue" && op !== "remove" && op !== "popAll") return [];
  const q = queuedOf(o.content, "", ts);
  if (op === "popAll") {
    // The text is of every message that waited, joined: the key fits one message only.
    return [{ kind: "unqueue", id: `u:${ts}:pop`, ts, op: "pop", ...(q ? { h: q.h, as: q.msg.kind } : {}) }];
  }
  if (!q) return [];
  if (op === "remove") return [{ kind: "unqueue", id: `u:${ts}:remove:${q.h}`, ts, op: "remove", h: q.h, as: q.msg.kind }];
  const id = `q:${ts}:${q.h}`;
  return [{ kind: "queued", id, ts, h: q.h, msg: { ...q.msg, id } }];
}

// `sidechain`: the file is a subagent's own (subagents/agent-<id>.jsonl), whose
// lines all have isSidechain true. The main file's reader drops such lines.
export type ParseOpts = { sidechain?: boolean };

// One JSONL line → its thread items, in line order. Never throws.
export function parseSessionLine(line: string, opts: ParseOpts = {}): ThreadItem[] {
  if (!line || line.charCodeAt(0) !== 123 /* { */ || !wantsLine(line.slice(0, 48))) return [];
  let o: unknown;
  try { o = JSON.parse(line); } catch { return []; }
  if (!isObj(o) || (o.isSidechain === true) !== (opts.sidechain === true)) return [];
  if (o.type === "queue-operation") return opts.sidechain === true ? [] : parseQueueLine(o);
  const uuid = str(o.uuid);
  if (!uuid) return [];
  const ts = Date.parse(str(o.timestamp)) || 0;
  const msg = isObj(o.message) ? o.message : null;

  if (o.type === "assistant" && msg && Array.isArray(msg.content)) {
    const out: ThreadItem[] = [];
    msg.content.forEach((b: unknown, n: number) => {
      if (!isObj(b)) return;
      const id = n === 0 ? uuid : `${uuid}:${n}`;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const text = b.text.trim();
        if (o.isApiErrorMessage === true) out.push({ kind: "note", id, ts, text: oneLine(text, 300) });
        // The harness's own filler for a turn that needed no answer.
        else if (!(msg.model === "<synthetic>" && text === "No response requested.")) {
          const final = opts.sidechain === true && (msg.stop_reason === "end_turn" || msg.stop_reason === "stop_sequence");
          out.push({ kind: "assistant", id, ts, text: clip(text), ...(final ? { final: true as const } : {}) });
        }
      } else if (b.type === "tool_use" && typeof b.id === "string" && b.id && typeof b.name === "string") {
        out.push({ kind: "step", id: b.id, ts, tool: b.name, label: stepLabel(b.name, b.input) });
      }
    });
    return out;
  }

  if (o.type === "user" && msg) {
    const content = msg.content;
    if (Array.isArray(content) && content.some((b) => isObj(b) && b.type === "tool_result")) {
      const out: ThreadItem[] = [];
      for (const b of content) {
        if (isObj(b) && b.type === "tool_result" && typeof b.tool_use_id === "string" && b.tool_use_id) {
          out.push({ kind: "end", id: b.tool_use_id, ts, ...(b.is_error === true ? { error: true } : {}) });
        }
      }
      // A subagent launch: the harness's own record of the result names the
      // subagent (one result per line, so it belongs to that one step).
      const r = isObj(o.toolUseResult) ? o.toolUseResult : null;
      const only = out.length === 1 ? out[0] : null;
      if (r && only && only.kind === "end" && isSubagentId(r.agentId)) {
        only.agent = r.agentId;
        if (r.isAsync === true || r.status === "async_launched") only.bg = true;
      }
      return out;
    }
    // The summary a compaction writes is the model's context, not a message
    // (the compact_boundary system line gives the marker).
    if (o.isCompactSummary === true) return [];
    const origin = isObj(o.origin) ? str(o.origin.kind) : "";
    const text = userText(content);
    const item = classifyUserText(text, { id: uuid, ts, originKind: origin, isMeta: o.isMeta === true });
    if (item) return [item];
    // A harness prompt (not shown) can come out of the wait line too: its key
    // lets the reader take it out of the line.
    if (o.isMeta === true && opts.sidechain !== true) {
      const q = queuedOf(text, uuid, ts);
      if (q) return [{ kind: "unqueue", id: `u:${uuid}`, ts, op: "line", h: q.h, as: q.msg.kind }];
    }
    return [];
  }

  // A message the user sent while the agent worked: the harness hands it to
  // the model as an attachment, not as a user line.
  if (o.type === "attachment" && isObj(o.attachment) && o.attachment.type === "queued_command") {
    const a = o.attachment;
    // A string, or blocks when the message has an image.
    const prompt = userText(a.prompt);
    if (!prompt) return [];
    const origin = isObj(a.origin) ? str(a.origin.kind) : "";
    const item = classifyUserText(prompt, { id: uuid, ts, originKind: origin, isMeta: false });
    if (item && (item.kind === "user" || item.kind === "peer")) item.mid = true;
    return item ? [item] : [];
  }

  if (o.type === "system" && o.subtype === "compact_boundary") {
    return [{ kind: "note", id: uuid, ts, text: "Context compacted" }];
  }
  return [];
}

// Give each step the end of its result when both are in `items`, and keep an
// `end` item only for a step that is not there. Order is kept.
export function foldEnds(items: ThreadItem[]): ThreadItem[] {
  const steps = new Map<string, Extract<ThreadItem, { kind: "step" }>>();
  for (const it of items) if (it.kind === "step") steps.set(it.id, it);
  const out: ThreadItem[] = [];
  for (const it of items) {
    if (it.kind !== "end") { out.push(it); continue; }
    const step = steps.get(it.id);
    if (!step) { out.push(it); continue; }
    step.end = it.ts;
    if (it.error) step.error = true;
    if (it.agent && isSubagentTool(step.tool)) {
      step.agent = it.agent;
      if (it.bg) step.bg = true;
    }
  }
  return out;
}

export const isMessage = (it: ThreadItem): boolean => it.kind === "user" || it.kind === "assistant" || it.kind === "peer";
