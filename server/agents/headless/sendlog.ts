// server/agents/headless/sendlog.ts — the console's log of the messages that it sent to one
// headless worker, until Claude took them. In the console's own state folder, never in the
// worker's folder.
//
// An entry is "taken" (acked) by one of two lines of Claude, by the uuid of our line:
//   - its replay: Claude 2.1.332 gives back our uuid for a message, for a local command ("/model …":
//     "<command-name>/model</command-name>…<command-args>…") and for an unknown command (its text
//     as typed; captured);
//   - the end of its command_lifecycle (completed or cancelled; command_uuid = our uuid): for an
//     input that gets no replay.
// A replay with a uuid that the log does not know takes nothing (the entry can be one that the
// log pruned). Only a replay with no uuid takes the oldest open entry with the same text (a local
// command: with the same name and args).
// So an ack is idempotent: a line that the console reads twice (it stopped before it saved its
// offset) finds the entry that it took, and takes no other. (The stdout of a local command,
// "<local-command-stdout>…", is not a replay of a message: the host gives it no ack.)
// Open entries go again after a console restart (a line that the console logged but did not
// write) and after a restart of the program (they waited in its queue). One exception: an entry
// that starts with "/" (Claude reads it as a command) and that the relay passed once is never
// sent again: the program can have run it with no line about it, and a "/clear" or "/compact"
// that runs twice is worse than one that is lost. The next start closes it and gives it back to
// its caller (closePassedCommands).
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

// text: "" when taken (the log keeps only the ids of the entries that Claude took).
// passed: the relay gave it to a program once (marked at the next start).
export type SendEntry = { uuid: string; text: string; at: number; acked: boolean; slash: boolean; passed?: boolean };

// The taken entries that the log keeps (for a repeat of their replay): ids only, no text.
const KEEP_ACKED = 200;

export type Taken = { entry: SendEntry; fresh: boolean };

export class SendLog {
  private entries: SendEntry[] = [];

  constructor(private file: string) { this.load(); }

  private load(): void {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (Array.isArray(v)) this.entries = v.filter(isEntry);
    } catch { this.entries = []; }
  }

  private save(): void {
    const acked = this.entries.filter((e) => e.acked);
    const drop = new Set(acked.slice(0, Math.max(0, acked.length - KEEP_ACKED)));
    this.entries = this.entries.filter((e) => !drop.has(e));
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.entries), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  // Logs a message before its write: a console that stops after this line sends it again.
  add(text: string, o: { uuid?: string; now?: number } = {}): SendEntry {
    const e: SendEntry = { uuid: o.uuid ?? randomUUID(), text, at: o.now ?? Date.now(), acked: false, slash: text.trimStart().startsWith("/") };
    this.entries.push(e);
    this.save();
    return e;
  }

  // A replay: the entry that it belongs to, or null (a message from another source, or an entry
  // that the log pruned). fresh: it took the entry now; false: a repeat of a line that took it.
  ackReplay(uuid: string | null, text: string): Taken | null {
    if (uuid) return this.ackCommand(uuid);
    const cmd = commandOf(text);
    const e = this.entries.find((x) => !x.acked && (x.slash ? cmd !== null && x.text.trim() === cmd : x.text === text));
    return e ? this.take(e) : null;
  }

  // The end of an input's command_lifecycle, or a replay with a uuid: by our uuid only.
  ackCommand(uuid: string): Taken | null {
    const e = this.entries.find((x) => x.uuid === uuid);
    if (!e) return null;
    if (e.acked) return { entry: e, fresh: false };
    return this.take(e);
  }

  // The ids that the relay passed to the program that ended (its `passed` file).
  markPassed(ids: ReadonlySet<string>): void {
    let changed = false;
    for (const e of this.entries) if (!e.acked && !e.passed && ids.has(e.uuid)) { e.passed = true; changed = true; }
    if (changed) this.save();
  }

  // At a start or a reattach: closes each open command that the relay passed once, and gives them
  // back (they are never sent again). A save that fails throws and closes none: they stay open
  // with passed (the host never writes such an entry), and the next start or reattach closes them.
  closePassedCommands(): Array<{ uuid: string; text: string }> {
    const hit = this.entries.filter((e) => !e.acked && e.slash && e.passed);
    if (hit.length === 0) return [];
    const out = hit.map((e) => ({ uuid: e.uuid, text: e.text }));
    const before = this.entries.slice(); // save() can prune an entry before its write fails
    for (const e of hit) { e.acked = true; e.text = ""; }
    try { this.save(); } catch (err) {
      this.entries = before;
      hit.forEach((e, i) => { e.acked = false; e.text = out[i]!.text; });
      throw err;
    }
    return out;
  }

  // The entries that Claude did not take yet, oldest first ("sending…").
  open(): SendEntry[] { return this.entries.filter((e) => !e.acked); }

  private take(e: SendEntry): Taken {
    e.acked = true;
    e.text = "";
    this.save();
    return { entry: e, fresh: true };
  }
}

// The replay of a local command, as the user typed it: "/model haiku". null: not a command.
function commandOf(text: string): string | null {
  const name = /^<command-name>([^<]*)<\/command-name>/.exec(text);
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  return args ? `${name[1]} ${args}` : name[1]!;
}

function isEntry(v: unknown): v is SendEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.uuid === "string" && typeof e.text === "string" && typeof e.at === "number"
    && typeof e.acked === "boolean" && typeof e.slash === "boolean" && (e.passed === undefined || typeof e.passed === "boolean");
}
