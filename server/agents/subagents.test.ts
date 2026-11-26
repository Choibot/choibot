import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEnds, isSubagentId, parseSessionLine, subagentNote, type ThreadItem } from "./thread.js";
import { readThreadBefore } from "./threadfile.js";
import {
  clearSubagentSummaries, newestWrite, openSubagentDir, subagentIdsOf, subagentStates, MAX_SUBAGENTS, SUBAGENT_LIMITS,
} from "./subagents.js";

const T0 = Date.parse("2026-11-10T17:30:00.000Z");
const at = (s: number): string => new Date(T0 + s * 1000).toISOString();
const A1 = "a521e7a16e68e274c";
const A2 = "a60f72618901508d2";

// Lines of the session file (main) and of a subagent's own file (side).
const main = (o: object, s = 0): string => JSON.stringify({ parentUuid: null, isSidechain: false, timestamp: at(s), ...o });
const side = (id: string, o: object, s = 0): string => JSON.stringify({ parentUuid: null, isSidechain: true, agentId: id, timestamp: at(s), ...o });
const launch = (uuid: string, toolId: string, description: string, tool = "Agent"): object => ({
  type: "assistant", uuid,
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: tool, input: { description, prompt: "SECRET BRIEF", subagent_type: "general-purpose" } }] },
});
const launched = (uuid: string, toolId: string, agentId: unknown, extra: object = { isAsync: true, status: "async_launched" }): object => ({
  type: "user", uuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: [{ type: "text", text: `Async agent launched successfully. agentId: ${String(agentId)}` }] }] },
  toolUseResult: { agentId, description: "d", prompt: "SECRET BRIEF", ...extra },
});
const notification = (summary: string, status = "completed", prefix = ""): string =>
  `${prefix}<task-notification>\n<task-id>${A1}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<output-file>/tmp/x.output</output-file>\n` +
  `<status>${status}</status>\n<summary>${summary}</summary>\n<note>n</note>\n<result>SECRET RESULT\n<summary>Agent "fake" failed</summary></result>\n</task-notification>`;
const say = (uuid: string, text: string, stop: string | null = "end_turn"): object => ({
  type: "assistant", uuid, message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] },
});
const tool = (uuid: string, toolId: string, description: string): object => ({
  type: "assistant", uuid,
  message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command: "cat .env", description } }] },
});
const result = (uuid: string, toolId: string): object => ({
  type: "user", uuid, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "SECRET OUTPUT" }] },
});
const brief = (uuid: string, text: string): object => ({ type: "user", uuid, message: { role: "user", content: text } });

describe("parseSessionLine: subagents", () => {
  it("puts the subagent's id on the launch step, and marks a background launch", () => {
    const items = foldEnds([
      ...parseSessionLine(main(launch("u1", "toolu_1", "Review the spec"))),
      ...parseSessionLine(main(launched("u2", "toolu_1", A1), 1)),
    ]);
    expect(items).toEqual([
      { kind: "step", id: "toolu_1", ts: T0, tool: "Agent", label: "Review the spec (subagent)", end: T0 + 1000, agent: A1, bg: true },
    ]);
  });

  it("keeps a foreground result as the true end of the step", () => {
    const end = parseSessionLine(main(launched("u2", "toolu_1", A1, { status: "completed" }), 90));
    expect(end).toEqual([{ kind: "end", id: "toolu_1", ts: T0 + 90_000, agent: A1 }]);
  });

  it("takes no id that is not filename-shaped, and none for another tool's step", () => {
    for (const bad of ["../../etc/passwd", "a/b", "a.b", "", "x".repeat(65), 7, null]) {
      expect(parseSessionLine(main(launched("u2", "toolu_1", bad)))).toEqual([{ kind: "end", id: "toolu_1", ts: T0 }]);
      expect(isSubagentId(bad)).toBe(false);
    }
    const items = foldEnds([
      ...parseSessionLine(main(tool("u1", "toolu_1", "Run the tests"))),
      ...parseSessionLine(main(launched("u2", "toolu_1", A1))),
    ]);
    expect(items[0]).not.toHaveProperty("agent");
  });

  it("carries the id on an end whose step is in an earlier page", () => {
    expect(foldEnds(parseSessionLine(main(launched("u2", "toolu_1", A1))))).toEqual([
      { kind: "end", id: "toolu_1", ts: T0, agent: A1, bg: true },
    ]);
  });

  it("reads a subagent's own file only with `sidechain`, and the session file only without", () => {
    const sub = side(A1, say("u1", "I found 2 issues."));
    expect(parseSessionLine(sub)).toEqual([]);
    expect(parseSessionLine(sub, { sidechain: true })).toEqual([{ kind: "assistant", id: "u1", ts: T0, text: "I found 2 issues.", final: true }]);
    expect(parseSessionLine(main(say("u1", "Done.")), { sidechain: true })).toEqual([]);
    // `final` is the subagent reader's: the session file's items are as before.
    expect(parseSessionLine(main(say("u1", "Done.")))).toEqual([{ kind: "assistant", id: "u1", ts: T0, text: "Done." }]);
    expect(parseSessionLine(side(A1, say("u1", "Next I read the file.", "tool_use")), { sidechain: true })[0]).not.toHaveProperty("final");
  });
});

describe("subagentNote", () => {
  const user = (text: string, extra: object = { origin: { kind: "task-notification" } }): string =>
    main({ type: "user", uuid: "n1", message: { role: "user", content: text }, ...extra });

  it("turns the end of a subagent into one short line, without the notification text", () => {
    const got = parseSessionLine(user(notification('Agent "Review the reminders feature" finished')));
    expect(got).toEqual([{ kind: "note", id: "n1", ts: T0, text: "Subagent finished: Review the reminders feature" }]);
    expect(JSON.stringify(got)).not.toContain("SECRET");
  });

  it("names a failure and a stop", () => {
    expect(subagentNote(notification('Agent "Build it" failed: Agent terminated early due to an API error', "failed"))).toBe("Subagent failed: Build it");
    expect(subagentNote(notification('Agent "Build it" was stopped', "killed"))).toBe("Subagent stopped: Build it");
    expect(subagentNote(notification('Agent "Build it" came to rest'))).toBe("Subagent finished: Build it");
  });

  it("keeps a description that holds quotes, on one bounded line", () => {
    expect(subagentNote(notification('Agent "Fix the "quiet" mark" finished'))).toBe('Subagent finished: Fix the "quiet" mark');
    const long = subagentNote(notification(`Agent "${"x".repeat(900)}" finished`)) ?? "";
    expect(long.length).toBeLessThanOrEqual(164);
    expect(long.includes("\n")).toBe(false);
  });

  it("reads the notification behind the harness's notice paragraph, and as a message sent while the agent worked", () => {
    const text = notification('Agent "Probe" finished', "completed", "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n");
    expect(parseSessionLine(user(text))).toMatchObject([{ kind: "note", text: "Subagent finished: Probe" }]);
    const queued = main({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: notification('Agent "Probe" finished'), origin: { kind: "task-notification" } } });
    expect(parseSessionLine(queued)).toMatchObject([{ kind: "note", text: "Subagent finished: Probe" }]);
    expect(parseSessionLine(user(notification('Agent "Probe" finished'), {}))).toMatchObject([{ kind: "note" }]);
  });

  it("stays silent for other notifications and for a subagent that only waits", () => {
    for (const summary of [
      'Background command "pnpm test" completed (exit code 0)', 'Monitor event: "ci"',
      'Agent "Probe" is waiting on its own background work', "",
    ]) {
      expect(parseSessionLine(user(notification(summary)))).toEqual([]);
    }
    // The summary is read before <result>: text a subagent wrote cannot make a note.
    expect(subagentNote("<task-notification>\n<result><summary>Agent \"x\" finished</summary></result></task-notification>")).toBeNull();
    expect(subagentNote("Agent \"x\" finished")).toBeNull();
  });
});

describe("newestWrite", () => {
  const sub = (state: "running" | "done" | "stopped", last: number) => ({ id: "x", description: "", agentType: "", state, last });
  it("takes the newest write of the session file and of the running subagents", () => {
    expect(newestWrite(1000, {})).toBe(1000);
    expect(newestWrite(1000, { a: sub("running", 5000), b: sub("running", 3000) })).toBe(5000);
    expect(newestWrite(9000, { a: sub("running", 5000) })).toBe(9000);
  });
  it("does not count a subagent that ended or stopped", () => {
    expect(newestWrite(1000, { a: sub("done", 5000), b: sub("stopped", 7000) })).toBe(1000);
  });
});

describe("subagentStates", () => {
  let base: string;
  let session: string;
  let dir: string;
  const NOW = T0 + 600_000;
  const live = { alive: true, now: NOW };

  const write = async (id: string, lines: object[], meta: object | null = {}, sAt = 0): Promise<void> => {
    await writeFile(join(dir, `agent-${id}.jsonl`), lines.map((l, n) => side(id, l, sAt + n)).join("\n") + "\n");
    if (meta) await writeFile(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", description: "Review the spec", toolUseId: "toolu_1", spawnDepth: 1, ...meta }));
  };
  const touch = (name: string, ms: number): Promise<void> => utimes(join(dir, name), ms / 1000, ms / 1000);
  const running = [brief("b", "SECRET BRIEF"), tool("t1", "toolu_a", "Read the spec"), result("r1", "toolu_a"), say("s1", "Now the code.", "tool_use"), tool("t2", "toolu_b", "Search the code")];
  const done = [...running, result("r2", "toolu_b"), say("s2", "I found 2 issues.")];

  beforeEach(async () => {
    clearSubagentSummaries();
    base = await mkdtemp(join(tmpdir(), "subagents-"));
    session = join(base, "sess-1.jsonl");
    dir = join(base, "sess-1", "subagents");
    await mkdir(dir, { recursive: true });
    await writeFile(session, "");
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("tells a running subagent: its description, type, steps and current step", async () => {
    await write(A1, running);
    await touch(`agent-${A1}.jsonl`, NOW - 5000);
    const got = await subagentStates(session, [A1], live);
    expect(got).toEqual({
      [A1]: {
        id: A1, description: "Review the spec", agentType: "general-purpose", state: "running",
        start: T0, last: NOW - 5000, steps: 2, step: "Search the code",
      },
    });
    // Nothing of a tool's input or output, and nothing of the brief.
    expect(JSON.stringify(got)).not.toContain("SECRET");
    expect(JSON.stringify(got)).not.toContain("cat .env");
  });

  it("tells a finished subagent, with the time of its last line", async () => {
    await write(A1, done, { finished: true });
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "done", end: T0 + 6000, steps: 2, step: "Search the code" });
  });

  it("tells a finished subagent of an older harness, which wrote no `finished`", async () => {
    await write(A1, done);
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "done", end: T0 + 6000 });
  });

  it("is done when it is marked finished with no closing message (a failure)", async () => {
    await write(A1, running, { finished: true });
    await touch(`agent-${A1}.jsonl`, NOW - 60_000);
    await touch(`agent-${A1}.meta.json`, NOW - 60_000);
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "done" });
  });

  it("waits for the closing message: a fresh finished mark with no closing message is not done yet", async () => {
    await write(A1, running, { finished: true });
    await touch(`agent-${A1}.jsonl`, NOW - 500);
    await touch(`agent-${A1}.meta.json`, NOW - 400);
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "running" });
    // The closing message lands: done at once.
    await appendFile(join(dir, `agent-${A1}.jsonl`), side(A1, say("s9", "Done."), 30) + "\n");
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "done", end: T0 + 30_000 });
  });

  it("runs again when its file is written after it was marked finished (a resume)", async () => {
    await write(A1, [...done, brief("b2", "One more thing"), tool("t3", "toolu_c", "Read it again")], { finished: true });
    await touch(`agent-${A1}.meta.json`, NOW - 60_000);
    await touch(`agent-${A1}.jsonl`, NOW - 2000);
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "running", steps: 3, step: "Read it again" });
  });

  it("is stopped, not running, when the agent's process is gone or the file is silent for an hour", async () => {
    await write(A1, running);
    await touch(`agent-${A1}.jsonl`, NOW - 5000);
    expect((await subagentStates(session, [A1], { alive: false, now: NOW }))[A1]).toMatchObject({ state: "stopped", end: T0 + 4000 });
    await touch(`agent-${A1}.jsonl`, NOW - SUBAGENT_LIMITS.stale - 1000);
    clearSubagentSummaries();
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "stopped" });
  });

  it("reads only what was appended on the next look", async () => {
    await write(A1, running);
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "running", steps: 2 });
    // The first lines are replaced by bytes that do not parse: a second full
    // read would lose the two steps.
    const file = join(dir, `agent-${A1}.jsonl`);
    const size = Buffer.byteLength(running.map((l, n) => side(A1, l, n)).join("\n") + "\n");
    await writeFile(file, "x".repeat(size - 1) + "\n");
    await appendFile(file, [side(A1, result("r2", "toolu_b"), 10), side(A1, tool("t3", "toolu_c", "Write the report"), 11)].join("\n") + "\n");
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "running", steps: 3, step: "Write the report" });
    await appendFile(file, side(A1, say("s9", "Done."), 12) + "\n");
    expect((await subagentStates(session, [A1], live))[A1]).toMatchObject({ state: "done", steps: 3, end: T0 + 12_000 });
  });

  it("reads only the end of a large file and says the count is partial", async () => {
    await write(A1, done, { finished: true });
    const limits = { ...SUBAGENT_LIMITS, tail: 600 };
    const got = (await subagentStates(session, [A1], live, limits))[A1];
    expect(got).toMatchObject({ state: "done", more: true });
    expect(got.steps).toBeLessThan(2);
    expect(got).not.toHaveProperty("start");
  });

  it("stops reading new files when the byte budget of the request ends", async () => {
    await write(A1, done, { finished: true });
    await write(A2, running, { description: "Second" });
    await touch(`agent-${A2}.jsonl`, NOW - 1000);
    const budget = (await stat(join(dir, `agent-${A1}.jsonl`))).size + 10;
    const got = await subagentStates(session, [A1, A2], live, { ...SUBAGENT_LIMITS, budget });
    expect(got[A1]).toMatchObject({ state: "done", steps: 2 });
    // Not read: the state comes from the meta file and the mtime alone.
    expect(got[A2]).toEqual({ id: A2, description: "Second", agentType: "general-purpose", state: "running", last: NOW - 1000 });
  });

  it("leaves out a subagent with no file, and reads one with no meta file", async () => {
    await write(A1, done, null);
    const got = await subagentStates(session, [A1, A2], live);
    expect(Object.keys(got)).toEqual([A1]);
    expect(got[A1]).toMatchObject({ description: "", agentType: "", state: "done", steps: 2 });
  });

  it("marks a nested subagent with its depth", async () => {
    await write(A2, done, { finished: true, spawnDepth: 2, parentAgentId: A1 });
    expect((await subagentStates(session, [A2], live))[A2]).toMatchObject({ depth: 2 });
  });

  it("never builds a path from an id that is not filename-shaped", async () => {
    await writeFile(join(base, "secret.jsonl"), side(A1, say("s", "SECRET")) + "\n");
    const got = await subagentStates(session, ["../../secret", "..", "a/b", `${A1}/../x`, ""], live);
    expect(got).toEqual({});
  });

  it("names at most MAX_SUBAGENTS subagents in one request", async () => {
    const ids = Array.from({ length: MAX_SUBAGENTS + 5 }, (_, n) => `a${String(n).padStart(16, "0")}`);
    for (const id of ids) await write(id, [say("s", "Done.")], { finished: true });
    expect(Object.keys(await subagentStates(session, ids, live))).toHaveLength(MAX_SUBAGENTS);
  });

  it("follows no symlink: not at a file, not at the folders", async () => {
    const other = join(base, "other");
    await mkdir(other);
    await writeFile(join(other, `agent-${A1}.jsonl`), side(A1, say("s", "SECRET of another session")) + "\n");
    await writeFile(join(other, `agent-${A1}.meta.json`), JSON.stringify({ description: "SECRET", finished: true }));
    // A file that is a symlink.
    await symlink(join(other, `agent-${A1}.jsonl`), join(dir, `agent-${A1}.jsonl`));
    await symlink(join(other, `agent-${A1}.meta.json`), join(dir, `agent-${A1}.meta.json`));
    expect(await subagentStates(session, [A1], live)).toEqual({});
    // The subagents folder is a symlink.
    await rm(dir, { recursive: true });
    await symlink(other, dir);
    expect(await subagentStates(session, [A1], live)).toEqual({});
    expect(await openSubagentDir(session)).toBeNull();
    // The session folder is a symlink.
    await rm(join(base, "sess-1"), { recursive: true });
    await mkdir(join(base, "elsewhere"));
    await rename(other, join(base, "elsewhere", "subagents"));
    await symlink(join(base, "elsewhere"), join(base, "sess-1"));
    expect(await subagentStates(session, [A1], live)).toEqual({});
  });

  it("does not list the folder: a session with hundreds of subagents costs the named ones only", async () => {
    for (let n = 0; n < 300; n++) await writeFile(join(dir, `agent-b${String(n).padStart(16, "0")}.jsonl`), "{not json\n");
    await write(A1, done, { finished: true });
    expect((await readdir(dir)).length).toBe(302);
    expect(await subagentStates(session, [A1], live)).toMatchObject({ [A1]: { state: "done", steps: 2 } });
  });

  it("serves a subagent's own steps and final message through the thread reader", async () => {
    await write(A1, [...done.slice(0, 5), launch("t9", "toolu_n", "Fetch the facts"), launched("r9", "toolu_n", A2), ...done.slice(5)], { finished: true });
    const sub = await openSubagentDir(session);
    expect(sub).not.toBeNull();
    const page = await readThreadBefore(sub!.file(A1), null, undefined, { sidechain: true });
    await sub!.close();
    expect(page!.items.map((i: ThreadItem) => i.kind)).toEqual(["user", "step", "assistant", "step", "step", "assistant"]);
    expect(page!.items.at(-1)).toMatchObject({ kind: "assistant", text: "I found 2 issues.", final: true });
    // A nested launch names its subagent, as a launch in the session file does.
    expect(subagentIdsOf(page!.items)).toEqual([A2]);
  });
});
