import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueStore, ISSUE_ID_RE, summaryOf, telegramIssueId, uiIssueId, type Issue } from "./store.js";
import { makeIssue } from "./testkit.js";

async function tmpStore(onChange?: (i: Issue) => void) {
  const dir = await mkdtemp(join(tmpdir(), "issues-"));
  return { dir, store: new IssueStore(dir, onChange) };
}

describe("IssueStore", () => {
  it("create is idempotent: an existing issue wins", async () => {
    const { store } = await tmpStore();
    const first = await store.create(makeIssue({ text: "first" }));
    const again = await store.create(makeIssue({ text: "second" }));
    expect(first.created).toBe(true);
    expect(again).toEqual({ issue: expect.objectContaining({ text: "first" }), created: false });
  });

  it("update returns null and writes nothing when fn returns null (compare-and-set)", async () => {
    const changes: Issue[] = [];
    const { store } = await tmpStore((i) => changes.push(i));
    await store.create(makeIssue());
    const lost = await store.update("t100", (cur) => (cur.status === "running" ? { ...cur, status: "done" } : null));
    expect(lost).toBeNull();
    expect((await store.get("t100"))?.status).toBe("pending");
    expect(changes).toHaveLength(1); // the create only
  });

  it("serializes concurrent updates so no write is lost", async () => {
    const { store } = await tmpStore();
    await store.create(makeIssue({ chatMessageIds: [] }));
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        store.update("t100", (cur) => ({ ...cur, chatMessageIds: [...cur.chatMessageIds, n] }))),
    );
    expect((await store.get("t100"))?.chatMessageIds.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n));
  });

  it("emits every write through onChange and writes atomically", async () => {
    const changes: Issue[] = [];
    const { store, dir } = await tmpStore((i) => changes.push(i));
    await store.create(makeIssue());
    await store.update("t100", (cur) => ({ ...cur, status: "starting" }));
    expect(changes.map((c) => c.status)).toEqual(["pending", "starting"]);
    expect(JSON.parse(await readFile(join(dir, "t100", "issue.json"), "utf8")).status).toBe("starting");
  });

  it("list is newest first and skips torn, invalid and stray entries", async () => {
    const { store, dir } = await tmpStore();
    await store.create(makeIssue({ id: "t1", createdAt: 1 }));
    await store.create(makeIssue({ id: "t2", createdAt: 2 }));
    await mkdir(join(dir, "t3"));
    await writeFile(join(dir, "t3", "issue.json"), "{ torn");
    await mkdir(join(dir, "t4"));
    await writeFile(join(dir, "t4", "issue.json"), JSON.stringify({ id: "t4" }));
    await mkdir(join(dir, "t5")); // photo dir with no issue.json yet
    await writeFile(join(dir, "offset.json"), JSON.stringify({ offset: 9 }));
    expect((await store.list()).map((i) => i.id)).toEqual(["t2", "t1"]);
  });

  it("rejects ids that are not issue ids", async () => {
    const { store } = await tmpStore();
    expect(await store.get("../etc")).toBeNull();
    expect(() => store.issueDir("../etc")).toThrow();
  });

  it("finds the issue that owns a message id", async () => {
    const { store } = await tmpStore();
    await store.create(makeIssue({ id: "t7", chatMessageIds: [7, 1001] }));
    expect((await store.findByMessageId(1001))?.id).toBe("t7");
    expect(await store.findByMessageId(5)).toBeNull();
  });
});

describe("ids and summary", () => {
  it("builds both id shapes", () => {
    expect(telegramIssueId(12345)).toBe("t12345");
    const u = uiIssueId();
    expect(u).toMatch(/^u[0-9a-z]{8}$/);
    expect(ISSUE_ID_RE.test(u)).toBe(true);
  });
  it("summary is the first non-empty line, ≤ 80 chars, or (photo)", () => {
    expect(summaryOf("\n\n  Login broken  \nmore")).toBe("Login broken");
    expect(summaryOf("x".repeat(500))).toHaveLength(80);
    expect(summaryOf("   \n ")).toBe("(photo)");
  });
  it("summary never splits a surrogate pair at the cut", () => {
    const s = summaryOf("x".repeat(78) + "😀" + "tail");
    expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(s)).toHaveLength(80);
    expect(s).toBe("x".repeat(78) + "😀…");
  });
});
