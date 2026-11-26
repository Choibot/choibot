import { describe, expect, it } from "vitest";
import type { QueueItem } from "../../server/chief/queue/types";
import { deliverySlot, optimisticDelivery, planAction, runAnswer, undeliveredText } from "./queueActions";

const OPTS = [{ key: "A", label: "a" }, { key: "B", label: "b" }];
const item = (o: Partial<QueueItem>): QueueItem =>
  ({ id: "q1", kind: "choice", agentId: "worker-1", status: "open", choice: { options: OPTS }, ...o }) as QueueItem;
const rec = { value: "B", why: "w", ruleIds: [], by: "fleet-master", at: 1 };
const NOW = 1_000_000;
const ctx = (focused: QueueItem | undefined, o: Partial<{ readOnly: boolean; draft: string; now: number; images: string[]; imagesWait: boolean }> = {}) =>
  ({ focused, readOnly: false, draft: "", snoozeMin: 60, now: NOW, ...o });

describe("deliverySlot with a waiting merged notice (decision 60)", () => {
  it("Resend acts on the stuck withdrawal, not on the notice that waits for its agent", () => {
    const i = item({ kind: "pr", status: "withdrawn", lastError: "merged",
      delivery: { msgId: "q1-m", state: "failed", attempts: 1, lastError: "not-live" }, withdrawal: { msgId: "q1-w1", state: "failed", attempts: 1 } });
    expect(deliverySlot(i)).toBe("withdrawal");
    expect(deliverySlot({ ...i, delivery: { msgId: "q1-m", state: "unknown", attempts: 1 } })).toBe("answer");
  });
});

describe("planAction", () => {
  it("guards: read-only, no focus, not an Open row", () => {
    expect(planAction({ t: "approve" }, ctx(item({ kind: "pr" }), { readOnly: true }))).toBeNull();
    expect(planAction({ t: "approve" }, ctx(undefined))).toBeNull();
    expect(planAction({ t: "approve" }, ctx(item({ kind: "pr", status: "answered" })))).toBeNull();
  });
  it("approve answers a preview only; on a pr it never answers: it plans the server's merge check (decision 60)", () => {
    const pv = item({ kind: "preview" });
    expect(planAction({ t: "approve" }, ctx(pv))).toEqual({ t: "answer", item: pv, value: "approve" });
    const pr = item({ kind: "pr" });
    expect(planAction({ t: "approve" }, ctx(pr))).toEqual({ t: "checkPr", item: pr });
    expect(planAction({ t: "approve" }, ctx(item({})))).toBeNull();
  });
  it("no action on a pr item plans an approve answer", () => {
    const pr = item({ kind: "pr", recommend: { value: "approve", why: "w", ruleIds: ["r_abc12"], by: "fleet-master", at: 1 } });
    const all = [{ t: "approve" }, { t: "accept" }, { t: "pick", key: "A" }, { t: "send" }, { t: "changes" }, { t: "reply" }, { t: "open" }, { t: "snooze" }] as const;
    for (const a of all) {
      const p = planAction(a, ctx(pr, { draft: "approve" }));
      expect(p?.t === "answer" && p.value === "approve", a.t).toBe(false);
    }
    // The reply box sends `changes`, with its text.
    expect(planAction({ t: "send" }, ctx(pr, { draft: "approve" }))).toEqual({ t: "answer", item: pr, value: "changes", text: "approve", sent: true });
  });
  it("read-only: no merge check either", () => {
    expect(planAction({ t: "approve" }, ctx(item({ kind: "pr" }), { readOnly: true }))).toBeNull();
  });
  it("pick only a real option of a choice", () => {
    const c = item({});
    expect(planAction({ t: "pick", key: "A" }, ctx(c))).toEqual({ t: "answer", item: c, value: "A" });
    expect(planAction({ t: "pick", key: "F" }, ctx(c))).toBeNull();
    expect(planAction({ t: "pick", key: "A" }, ctx(item({ kind: "question" })))).toBeNull();
  });
  it("accept: choice sends the value, question sends reply + text; none without recommend or for persistent agents", () => {
    const c = item({ recommend: rec });
    expect(planAction({ t: "accept" }, ctx(c))).toEqual({ t: "answer", item: c, value: "B" });
    const q = item({ kind: "question", recommend: { ...rec, value: "yes" } });
    expect(planAction({ t: "accept" }, ctx(q))).toEqual({ t: "answer", item: q, value: "reply", text: "yes" });
    expect(planAction({ t: "accept" }, ctx(item({})))).toBeNull();
    expect(planAction({ t: "accept" }, ctx(item({ recommend: rec, agentId: "fleet-master" })))).toBeNull();
    expect(planAction({ t: "accept" }, ctx(item({ kind: "pr", recommend: rec })))).toBeNull();
  });
  it("snooze carries the minutes", () => {
    const c = item({});
    expect(planAction({ t: "snooze" }, ctx(c))).toEqual({ t: "snooze", item: c, minutes: 60 });
  });
  it("open: the pr on GitHub (the url of the Open PR link), else the preview url, else nothing", () => {
    const gh = "https://github.com/o/r/pull/1";
    expect(planAction({ t: "open" }, ctx(item({ kind: "pr", pr: { url: gh, number: 1 } } as Partial<QueueItem>)))).toEqual({ t: "open", url: gh });
    expect(planAction({ t: "open" }, ctx(item({ kind: "pr", pr: { url: "https://x/1", number: 1 } } as Partial<QueueItem>)))).toBeNull();
    expect(planAction({ t: "open" }, ctx(item({ kind: "preview", preview: { url: "https://p" } } as Partial<QueueItem>)))).toEqual({ t: "open", url: "https://p" });
    expect(planAction({ t: "open" }, ctx(item({ kind: "pr", pr: { local: { branch: "b" } } } as Partial<QueueItem>)))).toBeNull();
  });
  it("changes and reply focus the reply box", () => {
    expect(planAction({ t: "changes" }, ctx(item({ kind: "pr" })))).toEqual({ t: "focusReply" });
    expect(planAction({ t: "reply" }, ctx(item({})))).toEqual({ t: "focusReply" });
  });
  it("send: trimmed text, value by kind; empty draft sends nothing", () => {
    const pr = item({ kind: "pr" });
    expect(planAction({ t: "send" }, ctx(pr, { draft: "  fix it \n" }))).toEqual({ t: "answer", item: pr, value: "changes", text: "fix it", sent: true });
    const q = item({ kind: "question" });
    expect(planAction({ t: "send" }, ctx(q, { draft: "hi" }))).toMatchObject({ value: "reply", text: "hi" });
    expect(planAction({ t: "send" }, ctx(q, { draft: "  " }))).toBeNull();
  });
  it("send with images (lib/answerImages): no text is needed; it waits while an image goes up or failed", () => {
    const q = item({ kind: "question" });
    const D = ["d-0123456789abcdef.png"];
    expect(planAction({ t: "send" }, ctx(q, { images: D }))).toEqual({ t: "answer", item: q, value: "reply", images: D, sent: true });
    expect(planAction({ t: "send" }, ctx(q, { draft: "see", images: D }))).toEqual({ t: "answer", item: q, value: "reply", text: "see", images: D, sent: true });
    expect(planAction({ t: "send" }, ctx(q, { draft: "see", images: D, imagesWait: true }))).toBeNull();
    expect(planAction({ t: "send" }, ctx(q, { images: [] }))).toBeNull();
    // A choice: the images go with "other" (reply); a pr or a preview: with the change request.
    expect(planAction({ t: "send" }, ctx(item({}), { images: D }))).toMatchObject({ value: "reply", images: D });
    expect(planAction({ t: "send" }, ctx(item({ kind: "preview" }), { images: D }))).toMatchObject({ value: "changes", images: D });
    // A pick by button never takes the images.
    expect(planAction({ t: "pick", key: "A" }, ctx(item({}), { images: D }))).toEqual({ t: "answer", item: item({}), value: "A" });
  });
  it("other actions route nowhere", () => {
    expect(planAction({ t: "help" }, ctx(item({})))).toBeNull();
  });
  it("approve on a preview", () => {
    const pv = item({ kind: "preview" });
    expect(planAction({ t: "approve" }, ctx(pv))).toEqual({ t: "answer", item: pv, value: "approve" });
  });
  it("read-only blocks every action, not only approve", () => {
    const c = item({ recommend: rec });
    for (const a of [{ t: "pick", key: "A" }, { t: "accept" }, { t: "snooze" }, { t: "changes" }, { t: "reply" }, { t: "send" }] as const) {
      expect(planAction(a, ctx(c, { readOnly: true, draft: "x" })), a.t).toBeNull();
    }
  });
  it("send on a choice is a reply with the text", () => {
    const c = item({});
    expect(planAction({ t: "send" }, ctx(c, { draft: "neither" }))).toEqual({ t: "answer", item: c, value: "reply", text: "neither", sent: true });
  });
  it("move, undo, cancel and goQueue route nowhere", () => {
    for (const a of [{ t: "move", by: 1 }, { t: "undo" }, { t: "cancel" }, { t: "goQueue" }] as const) {
      expect(planAction(a, ctx(item({ recommend: rec }))), a.t).toBeNull();
    }
  });
  it("decision 39 on a question: no accept for a persistent agent's item", () => {
    expect(planAction({ t: "accept" }, ctx(item({ kind: "question", recommend: rec, agentId: "lead-app-shop" })))).toBeNull();
  });
  it("a snoozed item whose snooze ended (snoozedUntil <= now) is an Open row: it can be answered", () => {
    const sn = item({ kind: "preview", status: "snoozed", snoozedUntil: NOW - 1 });
    expect(planAction({ t: "approve" }, ctx(sn))).toEqual({ t: "answer", item: sn, value: "approve" });
    const due = item({ kind: "preview", status: "snoozed", snoozedUntil: NOW });
    expect(planAction({ t: "approve" }, ctx(due))).toEqual({ t: "answer", item: due, value: "approve" });
    const pr = item({ kind: "pr", status: "snoozed", snoozedUntil: NOW });
    expect(planAction({ t: "approve" }, ctx(pr))).toEqual({ t: "checkPr", item: pr });
  });
  it("a snoozed item that is not due yet is not an Open row: no action", () => {
    const sn = item({ kind: "pr", status: "snoozed", snoozedUntil: NOW + 1 });
    for (const a of [{ t: "approve" }, { t: "snooze" }, { t: "changes" }, { t: "send" }] as const) {
      expect(planAction(a, ctx(sn, { draft: "x" })), a.t).toBeNull();
    }
  });
});

describe("runAnswer (I2)", () => {
  const plan = { t: "answer" as const, item: item({ kind: "pr" }), value: "changes", text: "fix it", sent: true as const };
  it("clears the sent draft only once the server took the answer", async () => {
    const cleared: string[] = [];
    expect(await runAnswer(plan, { respond: async () => true, clearDraft: (id) => cleared.push(id) })).toBe(true);
    expect(cleared).toEqual(["q1"]);
  });
  it("keeps the draft on a 409, a 400 or a network error", async () => {
    const cleared: string[] = [];
    expect(await runAnswer(plan, { respond: async () => false, clearDraft: (id) => cleared.push(id) })).toBe(false);
    expect(cleared).toEqual([]);
  });
  it("an answer that was not typed (a key or button) never touches a draft", async () => {
    const cleared: string[] = [];
    const calls: unknown[][] = [];
    await runAnswer({ t: "answer", item: item({}), value: "A" }, { respond: async (...a) => { calls.push(a); return true; }, clearDraft: (id) => cleared.push(id) });
    expect(cleared).toEqual([]);
    expect(calls).toEqual([[item({}), "A", undefined, undefined]]);
  });
});

describe("optimisticDelivery", () => {
  const stuck = item({ status: "answered", delivery: { msgId: "m", state: "failed", attempts: 3 } });
  it("Resend: the stuck slot goes pending; Mark delivered: delivered", () => {
    expect(optimisticDelivery(stuck, "resend").delivery?.state).toBe("pending");
    expect(optimisticDelivery(stuck, "mark-delivered").delivery?.state).toBe("delivered");
  });
  it("the withdrawal slot when the answer slot is fine", () => {
    const w = item({ status: "withdrawn", delivery: { msgId: "m", state: "delivered", attempts: 1 }, withdrawal: { msgId: "w", state: "unknown", attempts: 2 } });
    expect(optimisticDelivery(w, "mark-delivered").withdrawal?.state).toBe("delivered");
    expect(optimisticDelivery(w, "resend").withdrawal?.state).toBe("pending");
    expect(optimisticDelivery(w, "resend").delivery?.state).toBe("delivered");
  });
});

describe("deliverySlot", () => {
  it("answer when the answer slot is stuck, else withdrawal", () => {
    expect(deliverySlot(item({ delivery: { msgId: "m", state: "failed", attempts: 1 } }))).toBe("answer");
    expect(deliverySlot(item({ delivery: { msgId: "m", state: "unknown", attempts: 1 } }))).toBe("answer");
    expect(deliverySlot(item({ delivery: { msgId: "m", state: "delivered", attempts: 1 }, withdrawal: { msgId: "w", state: "failed", attempts: 1 } }))).toBe("withdrawal");
  });
});

// Final fix wave, minor 3: the Undelivered row says what the slot's state means (spec §5.4 steps 4–5),
// so the user knows when Resend can send a line twice.
describe("undeliveredText", () => {
  const slot = (state: "failed" | "unknown", lastError?: string) => ({ msgId: "m", state, attempts: 1, ...(lastError ? { lastError } : {}) });
  it("unknown: may have been delivered — confirm (whatever lastError says)", () => {
    expect(undeliveredText(item({ delivery: slot("unknown") }))).toBe("may have been delivered — confirm");
    expect(undeliveredText(item({ delivery: slot("unknown", "socket hang up") }))).toBe("may have been delivered — confirm");
  });
  it("failed not-live: undelivered · Resume agent", () => {
    expect(undeliveredText(item({ delivery: slot("failed", "not-live") }))).toBe("undelivered · Resume agent");
  });
  it("failed otherwise: the lastError, or plain undelivered", () => {
    expect(undeliveredText(item({ delivery: slot("failed", "no-master") }))).toBe("undelivered · no-master");
    expect(undeliveredText(item({ delivery: slot("failed") }))).toBe("undelivered");
    expect(undeliveredText(item({ delivery: slot("failed", "x".repeat(300)) })).length).toBeLessThanOrEqual(140);
  });
  it("the stuck withdrawal slot is named as such (the slot Resend acts on)", () => {
    expect(undeliveredText(item({ delivery: { msgId: "m", state: "pending", attempts: 0 }, withdrawal: slot("unknown") })))
      .toBe("withdrawal: may have been delivered — confirm");
    expect(undeliveredText(item({ withdrawal: slot("failed", "not-live") }))).toBe("withdrawal: undelivered · Resume agent");
  });
});

describe("planAction: merge (the m key)", () => {
  const pr = item({ kind: "pr", pr: { url: "https://github.com/o/r/pull/3", number: 3 } });
  it("plans the confirm step only, never a merge", () => {
    expect(planAction({ t: "merge" }, ctx(pr))).toEqual({ t: "mergeAsk", item: pr });
  });
  it("nothing for a read-only device, a closed ticket, a local pr or another kind", () => {
    expect(planAction({ t: "merge" }, ctx(pr, { readOnly: true }))).toBeNull();
    expect(planAction({ t: "merge" }, ctx({ ...pr, status: "answered" }))).toBeNull();
    expect(planAction({ t: "merge" }, ctx(item({ kind: "pr", pr: { local: { repo: "r", branch: "b" } } })))).toBeNull();
    expect(planAction({ t: "merge" }, ctx(item({ kind: "preview" })))).toBeNull();
    expect(planAction({ t: "merge" }, ctx(item({ kind: "deploy" })))).toBeNull();
  });
});
