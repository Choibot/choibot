// server/agents/headless/sendlog.test.ts — the console's log of sent messages: which ones Claude
// took, and which ones go again.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SendLog } from "./sendlog.js";

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "headless-sendlog-")); file = join(dir, "sendlog.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const texts = (l: SendLog) => l.open().map((e) => e.text);

describe("SendLog", () => {
  it("keeps the open entries in its file, in order", () => {
    const a = new SendLog(file);
    a.add("one");
    a.add("two");
    expect(texts(new SendLog(file))).toEqual(["one", "two"]);
  });

  it("a replay with our uuid takes the entry once; its repeat changes nothing", () => {
    const l = new SendLog(file);
    const e = l.add("hi");
    expect(l.ackReplay(e.uuid, "hi")).toEqual({ entry: expect.objectContaining({ uuid: e.uuid, acked: true }), fresh: true });
    expect(l.ackReplay(e.uuid, "hi")).toMatchObject({ fresh: false });
    expect(new SendLog(file).ackReplay(e.uuid, "hi")).toMatchObject({ fresh: false });
    expect(texts(l)).toEqual([]);
  });

  it("a replay with a uuid that the log does not know takes nothing, also with the same text", () => {
    const l = new SendLog(file);
    l.add("continue");
    expect(l.ackReplay("r-1", "continue")).toBeNull();
    expect(texts(l)).toEqual(["continue"]);
  });

  it("only a replay with no uuid takes the oldest open entry with its text", () => {
    const l = new SendLog(file);
    l.add("continue");
    const second = l.add("continue");
    expect(l.ackReplay(null, "continue")).toMatchObject({ fresh: true });
    expect(l.open().map((e) => e.uuid)).toEqual([second.uuid]);
    expect(l.ackReplay(null, "continue")).toMatchObject({ fresh: true });
    expect(l.ackReplay(null, "continue")).toBeNull();
    expect(texts(l)).toEqual([]);
  });

  it("a re-read from 0 that meets the replay of a pruned entry takes no other entry (finding 3)", () => {
    const l = new SendLog(file);
    const old = l.add("go on");
    l.ackReplay(old.uuid, "go on");
    for (let i = 0; i < 250; i++) { const e = l.add(`m${i}`); l.ackReplay(e.uuid, e.text); } // old is pruned now
    const next = l.add("go on");
    const again = new SendLog(file);
    expect(again.ackReplay(old.uuid, "go on")).toBeNull();
    expect(again.open().map((e) => e.uuid)).toEqual([next.uuid]);
  });

  it("a replay of another source takes nothing", () => {
    const l = new SendLog(file);
    l.add("mine");
    expect(l.ackReplay("r-9", "a message from another agent")).toBeNull();
    expect(l.ackReplay(null, "a message from another agent")).toBeNull();
    expect(l.ackReplay(null, "")).toBeNull();
    expect(texts(l)).toEqual(["mine"]);
  });

  it("the end of a command_lifecycle takes its entry by our uuid once; an unknown uuid takes nothing", () => {
    const l = new SendLog(file);
    const a = l.add("/fake-noreplay");
    l.add("other");
    expect(l.ackCommand("not-ours")).toBeNull();
    expect(l.ackCommand(a.uuid)).toMatchObject({ entry: { uuid: a.uuid, acked: true }, fresh: true });
    expect(new SendLog(file).ackCommand(a.uuid)).toMatchObject({ fresh: false });
    expect(l.ackReplay(a.uuid, "/fake-noreplay")).toMatchObject({ fresh: false }); // replay and lifecycle: one take
    expect(texts(l)).toEqual(["other"]);
  });

  it("a command that the relay passed is closed at the next start and given back; a passed message stays open", () => {
    const l = new SendLog(file);
    const clear = l.add("/clear");
    const msg = l.add("a message");
    const later = l.add("/compact"); // not passed: it goes again
    l.markPassed(new Set([clear.uuid, msg.uuid, "not-ours"]));
    const again = new SendLog(file);
    expect(again.open().map((e) => [e.text, e.passed ?? false])).toEqual([["/clear", true], ["a message", true], ["/compact", false]]);
    expect(again.closePassedCommands()).toEqual([{ uuid: clear.uuid, text: "/clear" }]);
    expect(again.closePassedCommands()).toEqual([]);
    expect(new SendLog(file).open().map((e) => e.uuid)).toEqual([msg.uuid, later.uuid]);
    expect(readFileSync(file, "utf8")).not.toContain("/clear");
  });

  it("a close of passed commands whose save fails closes none: they stay open with passed, also after a prune (round 4, 1)", () => {
    const l = new SendLog(file);
    const clear = l.add("/clear");
    l.markPassed(new Set([clear.uuid]));
    for (let i = 0; i < 205; i++) l.ackCommand(l.add(`later ${i}`).uuid); // closed, its save prunes the oldest closed
    mkdirSync(`${file}.tmp`);                                           // the next save fails
    expect(() => l.closePassedCommands()).toThrow();
    expect(l.open().map((e) => [e.text, e.passed])).toEqual([["/clear", true]]);
    rmSync(`${file}.tmp`, { recursive: true });
    expect(l.closePassedCommands()).toEqual([{ uuid: clear.uuid, text: "/clear" }]);
    expect(new SendLog(file).open()).toEqual([]);
  });

  it("a local command is taken by the replay of its name and args; a repeat takes no second one", () => {
    const l = new SendLog(file);
    const a = l.add("/model a");
    const b = l.add("/model b");
    const replay = (args: string) =>
      `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${args}</command-args>`;
    expect(l.ackReplay(null, "/model a")).toBeNull(); // the text as typed is no replay of it
    expect(l.ackReplay(null, replay("a"))?.entry.uuid).toBe(a.uuid);
    expect(new SendLog(file).ackReplay(null, replay("a"))).toBeNull(); // a re-read: b has other args
    expect(l.open().map((e) => e.uuid)).toEqual([b.uuid]);
    expect(l.ackReplay(b.uuid, replay("b"))?.entry.uuid).toBe(b.uuid); // by our uuid (2.1.332)
    const c = l.add("  /compact");
    expect(l.ackReplay(null, "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>")?.entry.uuid).toBe(c.uuid);
    expect(texts(l)).toEqual([]);
  });

  it("a taken entry keeps no text; the log keeps the last 200 taken entries and every open one", () => {
    const l = new SendLog(file);
    const open = l.add("open");
    const first = l.add("secret words");
    l.ackReplay(first.uuid, "secret words");
    expect(JSON.stringify(new SendLog(file))).not.toContain("secret words");
    expect(readFileSync(file, "utf8")).not.toContain("secret words");
    for (let i = 0; i < 250; i++) { const e = l.add(`m${i}`); l.ackReplay(e.uuid, e.text); }
    const again = new SendLog(file);
    expect(texts(again)).toEqual(["open"]);
    expect((JSON.parse(readFileSync(file, "utf8")) as unknown[]).length).toBe(201);
    expect(again.ackReplay(open.uuid, "open")).toMatchObject({ fresh: true });
  });

  it("starts empty on a broken file", () => {
    writeFileSync(file, "{not json");
    expect(texts(new SendLog(file))).toEqual([]);
    writeFileSync(file, JSON.stringify([{ uuid: 1 }, { uuid: "a", text: "ok", at: 1, acked: false, slash: false },
      { uuid: "b", text: "bad", at: 1, acked: false, slash: false, passed: "yes" }]));
    expect(texts(new SendLog(file))).toEqual(["ok"]);
  });
});
