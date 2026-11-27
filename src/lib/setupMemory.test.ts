// src/lib/setupMemory.test.ts — the memory of the Set-up page for the first agent and its ticket:
// a poll with the same data keeps the old object (no new draw), the merge step does not start
// from a view older than its own state, and a ticket is read once before its step opens.
import { beforeEach, describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import type { FirstView } from "../../server/setup/firstagent";
import { firstMemory, firstStart, hasTicket, keepSame, rememberFirst, ticketMemory, warmTicket } from "./setupMemory";
import { applySet, type Shown } from "./viewCache";

const view = (o: Partial<FirstView>) => ({ agent: null, ticket: null, repo: "app", repos: ["app"], task: "t", now: 1, ...o }) as unknown as FirstView;
const ticket = (id: string, title = "Docs") => ({ id, title, body: "", state: "open" }) as unknown as QueueItem;

beforeEach(() => {
  firstMemory.delete("first");
  for (const id of ["q1", "q2", "q3"]) ticketMemory.delete(id);
});

describe("keepSame", () => {
  it("gives the old object for a read with the same data, and the new one for new data", () => {
    const a = ticket("q1");
    expect(keepSame(a, ticket("q1"))).toBe(a);
    const b = ticket("q1", "Docs, checks green");
    expect(keepSame(a, b)).toBe(b);
    expect(keepSame(null, a)).toBe(a);
  });
});

describe("a poll of the ticket", () => {
  it("with the same data keeps the shown state (React draws nothing again); new data draws", () => {
    const shown: Shown<QueueItem | null> = { key: "q1", value: ticket("q1") };
    expect(applySet(ticketMemory, shown, "q1", (p) => keepSame(p, ticket("q1")))).toBe(shown);
    const next = applySet(ticketMemory, shown, "q1", (p) => keepSame(p, ticket("q1", "Docs, checks green")));
    expect(next).not.toBe(shown);
    expect(next.value?.title).toBe("Docs, checks green");
  });
});

describe("firstStart", () => {
  it("starts from the last view of this page load", () => {
    expect(firstStart()).toBeNull();
    const v = view({ now: 5 });
    rememberFirst(v);
    expect(firstStart()).toBe(v);
  });

  it("the merge step does not start from a view with no ticket (older than the state that opened it)", () => {
    rememberFirst(view({ ticket: null }));
    expect(firstStart(hasTicket)).toBeNull();
    const v = view({ ticket: { id: "q1", state: "open" } as FirstView["ticket"] });
    rememberFirst(v);
    expect(firstStart(hasTicket)).toBe(v);
  });
});

describe("warmTicket", () => {
  it("reads a ticket once, and not again while a copy is in memory", async () => {
    let reads = 0;
    const read = async (id: string) => { reads++; return ticket(id); };
    await Promise.all([warmTicket("q2", read), warmTicket("q2", read)]);
    expect(reads).toBe(1);
    expect(ticketMemory.get("q2")?.id).toBe("q2");
    await warmTicket("q2", read);
    expect(reads).toBe(1);
  });

  it("a failed read keeps nothing, and the next one reads again", async () => {
    await warmTicket("q3", async () => { throw new Error("502"); });
    expect(ticketMemory.has("q3")).toBe(false);
    await warmTicket("q3", async (id) => ticket(id));
    expect(ticketMemory.has("q3")).toBe(true);
  });
});
