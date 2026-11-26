import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readThreadAfter, readThreadBefore, sessionFileFor, type ThreadLimits } from "./threadfile.js";
import { foldEnds, parseSessionLine, type ThreadItem } from "./thread.js";
import type { AgentRecord } from "./store.js";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "threadfile-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;
const stamp = (n: number): string => new Date(Date.UTC(2026, 10, 10, 12, 0, n)).toISOString();
const userLine = (text: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, origin: { kind: "human" }, uuid: `u${++seq}`, timestamp: stamp(seq) });
const sayLine = (text: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, uuid: `a${++seq}`, timestamp: stamp(seq) });
const toolLine = (id: string, description: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "x", description } }] }, uuid: `t${++seq}`, timestamp: stamp(seq) });
const resultLine = (id: string, size = 10): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "o".repeat(size) }] }, uuid: `r${++seq}`, timestamp: stamp(seq) });
const blobLine = (size: number): string => JSON.stringify({ type: "api-request-blob", sessionId: "s", hash: "h", message: "b".repeat(size) });

// A session with every shape the reader meets: turns with steps, blobs between
// them (some far over the line cap), and a pasted prompt larger than a chunk.
function sessionLines(turns: number): string[] {
  const out: string[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(userLine(`prompt ${t} é ✓`));
    out.push(blobLine(t % 3 === 0 ? 5000 : 300));
    out.push(toolLine(`tool-${t}-a`, `step ${t} a`));
    out.push(resultLine(`tool-${t}-a`, t % 4 === 0 ? 900 : 20));
    out.push(JSON.stringify({ type: "mode", mode: "x", sessionId: "s" }));
    out.push(toolLine(`tool-${t}-b`, `step ${t} b`));
    out.push(resultLine(`tool-${t}-b`));
    out.push(sayLine(t === 2 ? `long answer ${"w".repeat(700)}` : `answer ${t}`));
  }
  return out;
}

const whole = (lines: string[]): ThreadItem[] => foldEnds(lines.flatMap((l) => parseSessionLine(l)));
const small: ThreadLimits = { chunk: 256, maxLine: 2000, scan: 1 << 20, forward: 1 << 20, messages: 5, items: 40 };

async function fileOf(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

// Page backwards from the end to the start and return everything in file order.
async function pageAll(path: string, limits: ThreadLimits): Promise<{ items: ThreadItem[]; pages: number }> {
  let before: number | null = null;
  const pages: ThreadItem[][] = [];
  for (let n = 0; n < 10_000; n++) {
    const page = await readThreadBefore(path, before, limits);
    if (!page) throw new Error("unreadable");
    pages.unshift(page.items);
    if (page.start === null) return { items: foldEnds(pages.flat()), pages: pages.length };
    expect(before === null || page.start < before).toBe(true); // every page makes progress
    before = page.start;
  }
  throw new Error("paging did not end");
}

describe("readThreadBefore", () => {
  it("returns the tail first, then older pages, with nothing lost or repeated", async () => {
    const lines = sessionLines(12);
    const path = await fileOf("paged.jsonl", lines.join("\n") + "\n");
    const want = whole(lines.filter((l) => l.length <= small.maxLine));
    for (const chunk of [64, 256, 1000, 1 << 20]) {
      const got = await pageAll(path, { ...small, chunk });
      expect(got.items).toEqual(want);
      expect(got.pages).toBeGreaterThan(3);
    }
  });

  it("stops a page at the message limit and gives a cursor for the rest", async () => {
    const lines = sessionLines(12);
    const path = await fileOf("limit.jsonl", lines.join("\n") + "\n");
    const page = await readThreadBefore(path, null, small);
    expect(page!.items.filter((i) => i.kind === "user" || i.kind === "assistant")).toHaveLength(5);
    expect(page!.items.at(-1)).toMatchObject({ kind: "assistant", text: "answer 11" });
    expect(page!.start).toBeGreaterThan(0);
    expect(page!.end).toBe(Buffer.byteLength(lines.join("\n") + "\n"));
  });

  it("gives a step its end, and an end item when the step is in an older page", async () => {
    const lines = [userLine("go"), toolLine("slow", "wait"), sayLine("one"), sayLine("two"), resultLine("slow"), sayLine("three")];
    const path = await fileOf("ends.jsonl", lines.join("\n") + "\n");
    const page = await readThreadBefore(path, null, { ...small, messages: 3 });
    expect(page!.items.map((i) => i.kind)).toEqual(["assistant", "assistant", "end", "assistant"]);
    const older = await readThreadBefore(path, page!.start, small);
    expect(older!.items).toMatchObject([{ kind: "user" }, { kind: "step", id: "slow" }]);
    expect(older!.start).toBeNull();
  });

  it("skips a line over the cap without losing its neighbours", async () => {
    const lines = [userLine("before"), blobLine(50_000), userLine("x".repeat(3000)), sayLine("after")];
    const path = await fileOf("huge.jsonl", lines.join("\n") + "\n");
    const got = await pageAll(path, { ...small, chunk: 512 });
    expect(got.items.map((i) => (i as { text: string }).text)).toEqual(["before", "after"]);
  });

  it("leaves a last line that is still being written for the next read", async () => {
    const done = [userLine("hello"), sayLine("hi")].join("\n") + "\n";
    const partial = sayLine("not finished").slice(0, 40);
    const path = await fileOf("partial.jsonl", done + partial);
    const page = await readThreadBefore(path, null, small);
    expect(page!.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(page!.end).toBe(Buffer.byteLength(done));
    expect(page!.start).toBeNull();
  });

  it("ends the scan at its budget and still makes progress on the next call", async () => {
    const lines = [userLine("first"), ...Array.from({ length: 40 }, () => blobLine(400)), sayLine("last")];
    const path = await fileOf("budget.jsonl", lines.join("\n") + "\n");
    const limits = { ...small, chunk: 512, scan: 2048 };
    const first = await readThreadBefore(path, null, limits);
    expect(first!.items.map((i) => (i as { text: string }).text)).toEqual(["last"]);
    expect(first!.start).not.toBeNull();
    const got = await pageAll(path, limits);
    expect(got.items.map((i) => (i as { text: string }).text)).toEqual(["first", "last"]);
  });

  it("handles an empty file, a file with no newline, and a cursor at 0", async () => {
    expect(await readThreadBefore(await fileOf("empty.jsonl", ""), null, small)).toMatchObject({ items: [], start: null, end: 0 });
    expect(await readThreadBefore(await fileOf("nonl.jsonl", userLine("no newline yet")), null, small)).toMatchObject({ items: [], start: null, end: 0 });
    const path = await fileOf("zero.jsonl", userLine("a") + "\n");
    expect(await readThreadBefore(path, 0, small)).toMatchObject({ items: [], start: null });
  });

  it("returns null for a missing file, a directory and a symlink", async () => {
    expect(await readThreadBefore(join(dir, "ghost.jsonl"), null, small)).toBeNull();
    expect(await readThreadBefore(dir, null, small)).toBeNull();
    const target = await fileOf("target.jsonl", userLine("secret") + "\n");
    const link = join(dir, "link.jsonl");
    await symlink(target, link);
    expect(await readThreadBefore(link, null, small)).toBeNull();
    expect(await readThreadAfter(link, 0, small)).toBeNull();
  });
});

describe("lastEntryAt", () => {
  it("is the time of the last write to the file, in both readers, with no new bytes too", async () => {
    const path = await fileOf("quiet.jsonl", [userLine("start"), toolLine("q1", "a long build")].join("\n") + "\n");
    const at = Date.UTC(2026, 10, 10, 12, 0, 0);
    await utimes(path, at / 1000, at / 1000);
    const tail = await readThreadBefore(path, null, small);
    expect(tail!.lastEntryAt).toBe(at);
    // A poll that finds nothing new still tells how old the last line is.
    expect(await readThreadAfter(path, tail!.end, small)).toEqual({ items: [], start: null, end: tail!.end, lastEntryAt: at });
    // A line of a type the thread never shows is output of the session too.
    await appendFile(path, JSON.stringify({ type: "mode", mode: "x", sessionId: "s" }) + "\n");
    const later = at + 15 * 60_000;
    await utimes(path, later / 1000, later / 1000);
    expect(await readThreadAfter(path, tail!.end, small)).toMatchObject({ items: [], lastEntryAt: later });
  });
});

describe("readThreadAfter", () => {
  it("returns only what was appended, across chunk borders", async () => {
    const path = await fileOf("live.jsonl", [userLine("start"), sayLine("ok")].join("\n") + "\n");
    const tail = await readThreadBefore(path, null, small);
    expect(await readThreadAfter(path, tail!.end, small)).toMatchObject({ items: [], start: null, end: tail!.end });
    const more = [toolLine("t1", "build"), blobLine(5000), resultLine("t1"), sayLine("done é")];
    await appendFile(path, more.join("\n") + "\n");
    for (const chunk of [64, 300, 1 << 20]) {
      const next = await readThreadAfter(path, tail!.end, { ...small, chunk });
      expect(next).not.toBe("reset");
      const page = next as Exclude<typeof next, "reset" | null>;
      expect(page.items).toMatchObject([{ kind: "step", id: "t1", label: "build", end: expect.any(Number) }, { kind: "assistant", text: "done é" }]);
      expect(page.end).toBe(tail!.end + Buffer.byteLength(more.join("\n") + "\n"));
    }
  });

  it("waits for a line that is still being written", async () => {
    const path = await fileOf("writing.jsonl", userLine("start") + "\n");
    const tail = await readThreadBefore(path, null, small);
    const next = sayLine("slow line");
    await appendFile(path, next.slice(0, 30));
    expect(await readThreadAfter(path, tail!.end, small)).toMatchObject({ items: [], start: null, end: tail!.end });
    await appendFile(path, next.slice(30) + "\n");
    const page = await readThreadAfter(path, tail!.end, small);
    expect(page).toMatchObject({ items: [{ kind: "assistant", text: "slow line" }] });
  });

  it("returns the end of a step that started before the cursor", async () => {
    const path = await fileOf("endafter.jsonl", [userLine("go"), toolLine("bg", "long job")].join("\n") + "\n");
    const tail = await readThreadBefore(path, null, small);
    expect(tail!.items[1]).toMatchObject({ kind: "step", id: "bg" });
    expect((tail!.items[1] as { end?: number }).end).toBeUndefined();
    await appendFile(path, resultLine("bg") + "\n");
    expect(await readThreadAfter(path, tail!.end, small)).toMatchObject({ items: [{ kind: "end", id: "bg" }] });
  });

  it("asks for a reset when the cursor is past the end or the gap is too large", async () => {
    const path = await fileOf("reset.jsonl", [userLine("a"), blobLine(4000), sayLine("b")].join("\n") + "\n");
    expect(await readThreadAfter(path, 10_000_000, small)).toBe("reset");
    expect(await readThreadAfter(path, 0, { ...small, forward: 1000 })).toBe("reset");
    expect(await readThreadAfter(join(dir, "ghost.jsonl"), 0, small)).toBeNull();
  });
});

describe("sessionFileFor", () => {
  const rec = (over: Partial<AgentRecord>): AgentRecord => ({
    id: "a1", label: "", repo: "/r", worktree: "/w/tree.x", branch: "b", baseBranch: "m",
    sessionId: "sess-1", hookToken: "t", status: "idle", createdAt: 1, runtime: "claude", ...over,
  });
  let root: string;
  beforeAll(async () => {
    root = join(dir, "projects");
    await mkdir(join(root, "-w-tree-x"), { recursive: true });
    await writeFile(join(root, "-w-tree-x", "sess-1.jsonl"), "");
    await mkdir(join(root, "-other-cwd"), { recursive: true });
    await writeFile(join(root, "-other-cwd", "sess-moved.jsonl"), "");
  });
  const ctx = () => ({ workspaceDir: "/ws", projectsRoot: root });

  it("finds the file Claude derives from the agent's cwd", async () => {
    expect(await sessionFileFor(rec({}), ctx())).toEqual({ ok: true, path: join(root, "-w-tree-x", "sess-1.jsonl"), sessionId: "sess-1" });
  });
  it("finds a session filed under another project dir", async () => {
    expect(await sessionFileFor(rec({ sessionId: "sess-moved" }), ctx())).toEqual({ ok: true, path: join(root, "-other-cwd", "sess-moved.jsonl"), sessionId: "sess-moved" });
  });
  it("says why there is no file", async () => {
    expect(await sessionFileFor(rec({ runtime: "codex" }), ctx())).toEqual({ ok: false, reason: "runtime" });
    expect(await sessionFileFor(rec({ sessionId: null }), ctx())).toEqual({ ok: false, reason: "no-session" });
    expect(await sessionFileFor(rec({ sessionId: "sess-none" }), ctx())).toEqual({ ok: false, reason: "no-file" });
    expect(await sessionFileFor(rec({}), { workspaceDir: "/ws", projectsRoot: join(dir, "nowhere") })).toEqual({ ok: false, reason: "no-file" });
  });
  it("never builds a path from an id that is not filename-shaped", async () => {
    for (const bad of ["../../etc/passwd", "..", "a/b", "x\0y", ""]) {
      expect(await sessionFileFor(rec({ sessionId: bad }), ctx())).toEqual({ ok: false, reason: "no-session" });
    }
  });
});

// The wait line is read from the file like every other line: a message that
// waits, the line that takes it out, and the message where the agent got it.
describe("the wait line in a session file", () => {
  const qop = (operation: string, content?: string): string =>
    JSON.stringify({ type: "queue-operation", operation, timestamp: stamp(++seq), sessionId: "s", ...(content === undefined ? {} : { content }) });
  const midLine = (prompt: string): string =>
    JSON.stringify({ parentUuid: null, isSidechain: false, type: "attachment", attachment: { type: "queued_command", prompt, commandMode: "prompt", origin: { kind: "human" } }, uuid: `q${++seq}`, timestamp: stamp(seq) });

  it("reads a message that still waits at the end of the file, in both directions", async () => {
    const path = join(dir, "wait.jsonl");
    const head = [userLine("start the work"), toolLine("w1", "run the build")];
    await writeFile(path, head.join("\n") + "\n");
    const tail = await readThreadBefore(path, null);
    expect(tail?.items.map((i) => i.kind)).toEqual(["user", "step"]);
    await appendFile(path, qop("enqueue", "also update the docs") + "\n");
    const more = await readThreadAfter(path, tail!.end);
    expect(more).not.toBe("reset");
    expect((more as { items: ThreadItem[] }).items).toMatchObject([{ kind: "queued", msg: { kind: "user", text: "also update the docs" } }]);
    const again = await readThreadBefore(path, null);
    expect(again?.items.map((i) => i.kind)).toEqual(["user", "step", "queued"]);
  });

  it("leaves a wait-line line that is a moment old for the next read", async () => {
    // A message to an idle agent: enqueue, dequeue and the user line arrive in a few ms.
    const path = join(dir, "settle.jsonl");
    await writeFile(path, [userLine("start the work"), sayLine("Done.")].join("\n") + "\n");
    const tail = await readThreadBefore(path, null);
    const enq = qop("enqueue", "one more thing");
    const at = Date.parse(JSON.parse(enq).timestamp);
    await appendFile(path, enq + "\n" + qop("dequeue") + "\n");
    // 100 ms after the enqueue: nothing yet, and the cursor does not move past it.
    const early = await readThreadAfter(path, tail!.end, undefined, { now: () => at + 100 });
    expect(early).toMatchObject({ items: [], end: tail!.end });
    const earlyTail = await readThreadBefore(path, null, undefined, { now: () => at + 100 });
    expect(earlyTail?.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(earlyTail?.end).toBe(tail!.end);
    // The user line arrives: the three lines come together.
    await appendFile(path, userLine("one more thing") + "\n");
    const whole = await readThreadAfter(path, tail!.end, undefined, { now: () => at + 120 });
    expect((whole as { items: ThreadItem[] }).items.map((i) => i.kind)).toEqual(["queued", "unqueue", "user"]);
  });

  it("shows a message that waits once it is older than the moment", async () => {
    const path = join(dir, "settle2.jsonl");
    await writeFile(path, [userLine("start the work"), toolLine("s1", "run the build")].join("\n") + "\n");
    const tail = await readThreadBefore(path, null);
    const enq = qop("enqueue", "one more thing");
    const at = Date.parse(JSON.parse(enq).timestamp);
    await appendFile(path, enq + "\n");
    const late = await readThreadAfter(path, tail!.end, undefined, { now: () => at + 600 });
    expect((late as { items: ThreadItem[] }).items.map((i) => i.kind)).toEqual(["queued"]);
    const lateTail = await readThreadBefore(path, null, undefined, { now: () => at + 600 });
    expect(lateTail?.items.map((i) => i.kind)).toEqual(["user", "step", "queued"]);
  });

  it("reads the remove and the message the agent got in the middle of the turn", async () => {
    const path = join(dir, "mid.jsonl");
    const lines = [
      userLine("start the work"), toolLine("m1", "run the build"), qop("enqueue", "also update the docs"),
      resultLine("m1"), qop("remove", "also update the docs"), midLine("also update the docs"), sayLine("I update the docs too."),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const page = await readThreadBefore(path, null);
    expect(page?.items.map((i) => (i.kind === "unqueue" ? `unqueue:${i.op}` : i.kind))).toEqual(["user", "step", "queued", "unqueue:remove", "user", "assistant"]);
    expect(page?.items[4]).toMatchObject({ kind: "user", text: "also update the docs", mid: true });
  });
});
