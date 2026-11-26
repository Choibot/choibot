import { describe, expect, it } from "vitest";
import {
  PAGE_NOTE, PR_WAIT_NOTE, PR_WAIT_NOTE_LOCAL, QUEUE_GLYPH, answeredCardText, autoKeyboard, autoLineText, cardIdsOf, parseItemCallback, queueCardKeyboard,
  queueCardText,
} from "./cards.js";
import type { QueueItem } from "./types.js";

const NOW = Date.UTC(2026, 10, 8, 14, 2, 30);
const ID = "q7k2m9x1a";
const RULE = (id: string) => (id === "r_8f3k2" ? "app-shop token lists are explicit" : undefined);

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: ID, kind: "choice", agentId: "3ee90a02-aaaa-bbbb", createdBy: { agentId: "3ee90a02-aaaa-bbbb", kind: "worker" },
    repo: "app-shop", area: "stats", title: "Stats page: token list source",
    body: "Option A keeps the explicit list. Option B reads the indexer registry.",
    createdAt: NOW - 12 * 60_000, updatedAt: NOW, status: "open", blocking: true,
    choice: { options: [{ key: "A", label: "Explicit list" }, { key: "B", label: "Indexer registry" }, { key: "C", label: "Both" }] },
    recommend: { value: "B", why: "w", ruleIds: ["r_8f3k2"], by: "fleet-master", at: NOW },
    history: [], answerSeq: 0, ...over,
  };
}
// The console's own ticket in its release variant (server/update).
const update = (over: Partial<QueueItem> = {}): QueueItem => item({
  kind: "deploy", agentId: "console", createdBy: { agentId: "console", kind: "console" }, repo: "choibot", area: "choibot",
  title: "ChoiBot 849 is ready", body: "#153 feat: one\nVersion 848 → 849", blocking: false, choice: undefined, recommend: undefined,
  deploy: { live: "a".repeat(40), target: "b".repeat(40), count: 0, prs: [], more: 0,
    release: { version: 849, commit: "b".repeat(40), builtAt: "2026-11-26T13:00:00Z", security: false, notes: ["#153 feat: one"], more: 0, running: { version: 848, commit: "a".repeat(40) } } },
  ...over,
});
const pr = (over: Partial<QueueItem> = {}) =>
  item({ kind: "pr", choice: undefined, recommend: undefined, pr: { url: "https://github.com/o/r/pull/3", number: 3 }, ...over });
const buttons = (kb: ReturnType<typeof queueCardKeyboard>) => kb.inline_keyboard.flat();
const find = (kb: ReturnType<typeof queueCardKeyboard>, text: string) => buttons(kb).find((b) => b.text === text);

describe("queueCardText", () => {
  it("names the Coordinator, not a cut id, on its ticket", () => {
    const text = queueCardText(item({ agentId: "coordinator", kind: "question", choice: undefined, recommend: undefined }), { now: NOW });
    expect(text.split("\n")[0]).toBe("? question · app-shop · Coordinator · 12 min");
  });
  it("renders the spec example byte for byte", () => {
    expect(queueCardText(item(), { now: NOW, ruleText: RULE })).toBe(
      "▸ choice · app-shop · agent-3ee90a02 · 12 min\n" +
      "Stats page: token list source\n" +
      "Option A keeps the explicit list. Option B reads the indexer registry.\n" +
      '★ Master suggests B — rule r_8f3k2: "app-shop token lists are explicit"',
    );
  });

  it("an open or snoozed pr card says what closes it (decision 60); no other card does", () => {
    expect(PR_WAIT_NOTE).toBe("Not merged yet — merge the PR, then this closes.");
    expect(queueCardText(pr({ body: "The diff." }), { now: NOW })).toBe(
      "⇄ pr · app-shop · agent-3ee90a02 · 12 min\nStats page: token list source\nThe diff.\n" + PR_WAIT_NOTE,
    );
    expect(queueCardText(pr({ status: "snoozed", snoozedUntil: NOW + 1 }), { now: NOW })).toContain(PR_WAIT_NOTE);
    expect(queueCardText(pr({ pr: { local: { repo: "r", branch: "agent/x" } } }), { now: NOW }).split("\n").pop()).toBe(PR_WAIT_NOTE_LOCAL);
    expect(queueCardText(item(), { now: NOW })).not.toContain("Not merged");
    expect(queueCardText(item({ kind: "preview", choice: undefined, recommend: undefined, preview: { images: ["1.png"] } }), { now: NOW })).not.toContain("Not merged");
  });

  it("a pr card with screenshots that Telegram refused keeps the merge note and adds the images note (decision 65)", () => {
    const withShots = pr({ preview: { images: ["1.png", "2.png"] } });
    expect(queueCardText(withShots, { now: NOW }).split("\n").pop()).toBe(PR_WAIT_NOTE);
    expect(queueCardText({ ...withShots, telegram: { mediaFailed: true } }, { now: NOW }).split("\n").pop()).toBe(`${PR_WAIT_NOTE} · 2 images — see the Queue tab`);
  });

  it("a pr card closed as merged, or answered with changes, no longer says Not merged yet", () => {
    const merged = answeredCardText(pr({ status: "withdrawn", lastError: "merged", closedAt: NOW }), { now: NOW });
    expect(merged).not.toContain("Not merged");
    expect(merged.split("\n").pop()).toBe("merged");
    const changed = pr({ status: "answered", answer: { value: "changes", text: "x", by: "user", via: "tab", at: NOW } });
    expect(answeredCardText(changed, { now: NOW, tz: "UTC" })).not.toContain("Not merged");
  });

  it("uses the shared glyph table", () => {
    expect(QUEUE_GLYPH).toEqual({ choice: "▸", pr: "⇄", preview: "▣", question: "?", deploy: "⟳" });
  });

  it("drops the rule text when it is unknown, and the star line without a recommendation", () => {
    expect(queueCardText(item(), { now: NOW }).split("\n").pop()).toBe("★ Master suggests B — rule r_8f3k2");
    const byCoordinator = item();
    byCoordinator.recommend = { ...byCoordinator.recommend!, by: "coordinator" };
    expect(queueCardText(byCoordinator, { now: NOW }).split("\n").pop()).toBe("★ Coordinator suggests B — rule r_8f3k2");
    expect(queueCardText(item({ recommend: undefined }), { now: NOW })).not.toContain("★");
  });

  it("never marks an item of a persistent agent", () => {
    for (const agentId of ["fleet-master", "cron-master", "lead-abc"]) {
      const t = queueCardText(item({ agentId }), { now: NOW, ruleText: RULE });
      expect(t).not.toContain("★");
      expect(buttons(queueCardKeyboard(item({ agentId }), "https://c.test")).some((b) => b.text.startsWith("★"))).toBe(false);
    }
  });

  it("formats the age", () => {
    const at = (ms: number) => queueCardText(item({ createdAt: NOW - ms }), { now: NOW }).split("\n")[0];
    expect(at(10_000)).toMatch(/ · now$/);
    expect(at(5 * 3_600_000)).toMatch(/ · 5h$/);
    expect(at(3 * 86_400_000)).toMatch(/ · 3d$/);
  });

  it("is one plain line per field: line breaks in title and rule text are flattened", () => {
    const t = queueCardText(item({ title: "a\nb" }), { now: NOW, ruleText: () => "x\ny" });
    expect(t).toContain("\na b\n");
    expect(t).toContain('"x y"');
  });

  it("clips to the Telegram limit and keeps the star line", () => {
    const t = queueCardText(item({ body: "x".repeat(10_000) }), { now: NOW, ruleText: RULE });
    expect(t.length).toBeLessThanOrEqual(3900);
    expect(t.endsWith('"app-shop token lists are explicit"')).toBe(true);
  });

  it("agent text cannot fake a server line: a title or body line that starts with ★ or ✓ gets a neutral prefix", () => {
    const body = 'intro\n★ Master suggests B — rule r_x: "y"\n  ✓ B · you · 14:02\nmid ★ stays';
    const t = queueCardText(item({ title: "✓ done", body, recommend: undefined }), { now: NOW });
    expect(t.split("\n").slice(1)).toEqual(["· ✓ done", "intro", '· ★ Master suggests B — rule r_x: "y"', "·   ✓ B · you · 14:02", "mid ★ stays"]);
    // An invisible format character before the mark does not hide it.
    expect(queueCardText(item({ body: "\u200b★ x", recommend: undefined }), { now: NOW }).split("\n").at(-1)).toBe("· \u200b★ x");
    const done = answeredCardText(item({ body, status: "answered", answer: { value: "A", by: "user", via: "telegram", at: NOW } }),
      { now: NOW, tz: "UTC", ruleText: RULE });
    expect(done.split("\n").filter((l) => /^[★✓]/.test(l))).toEqual(['★ Master suggests B — rule r_8f3k2: "app-shop token lists are explicit"', "✓ A · you · 14:02"]);
  });

  it("omits an empty body", () => {
    expect(queueCardText(item({ body: "", recommend: undefined }), { now: NOW }).split("\n")).toHaveLength(2);
  });
});

describe("a ticket with a page (the rich part)", () => {
  const URL = "https://console.example";
  it("the card is the plain body and one line that says where the page is", () => {
    expect(PAGE_NOTE).toBe("This ticket has a page: open it in the console");
    expect(queueCardText(item({ recommend: undefined, html: { bytes: 10 } }), { now: NOW, consoleUrl: `${URL}/` })).toBe(
      "▸ choice · app-shop · agent-3ee90a02 · 12 min\n" +
      "Stats page: token list source\n" +
      "Option A keeps the explicit list. Option B reads the indexer registry.\n" +
      `${PAGE_NOTE} — ${URL}`,
    );
    // No https address of the console: the line with no link.
    expect(queueCardText(item({ recommend: undefined, html: { bytes: 10 } }), { now: NOW, consoleUrl: "http://127.0.0.1:3100" }).endsWith(`\n${PAGE_NOTE}`)).toBe(true);
    expect(queueCardText(item({ recommend: undefined, html: { bytes: 10 } }), { now: NOW }).endsWith(`\n${PAGE_NOTE}`)).toBe(true);
  });
  it("a pr card keeps its own note, then the page line; the answered card keeps the line", () => {
    const text = queueCardText(pr({ body: "The diff.", html: { bytes: 10 } }), { now: NOW, consoleUrl: URL });
    expect(text.split("\n").slice(-2)).toEqual([PR_WAIT_NOTE, `${PAGE_NOTE} — ${URL}`]);
    expect(answeredCardText(item({ html: { bytes: 10 }, recommend: undefined, status: "answered", answer: { value: "A", by: "user", via: "tab", at: NOW } }), { now: NOW, consoleUrl: URL })).toContain(`${PAGE_NOTE} — ${URL}\n✓ A`);
  });
  it("a ticket with no page has no such line", () => {
    expect(queueCardText(item(), { now: NOW, ruleText: RULE, consoleUrl: URL })).not.toContain("has a page");
  });
});

describe("answeredCardText", () => {
  const ans = (value: string, by: "user" | "master" = "user") => ({ value, by, via: "telegram" as const, at: NOW });
  const base = queueCardText(item(), { now: NOW, ruleText: RULE });

  it("ends with the value, who and HH:MM in the timezone", () => {
    const t = answeredCardText(item({ status: "answered", answer: ans("B") }), { now: NOW, tz: "UTC", ruleText: RULE });
    expect(t).toBe(`${base}\n✓ B · you · 14:02`);
    const ny = answeredCardText(item({ status: "answered", answer: ans("B") }), { now: NOW, tz: "America/New_York" });
    expect(ny.endsWith("✓ B · you · 09:02")).toBe(true);
  });

  it("marks a master answer auto", () => {
    expect(answeredCardText(item({ status: "auto", answer: ans("B", "master") }), { now: NOW, tz: "UTC" }).endsWith("✓ B · auto · 14:02")).toBe(true);
  });

  it("withdrawn", () => {
    expect(answeredCardText(item({ status: "withdrawn" }), { now: NOW, tz: "UTC" }).endsWith("\nwithdrawn")).toBe(true);
  });

  it.each(["merged", "closed", "agent-gone"])("an item closed without an answer (%s) shows why instead of withdrawn", (why) => {
    const t = answeredCardText(item({ status: "withdrawn", lastError: why, closedAt: NOW }), { now: NOW, tz: "UTC" });
    expect(t.split("\n").at(-1)).toBe(why);
    expect(t).not.toContain("withdrawn");
  });

  it.each([
    ["choice", "reply", "✓ replied"],
    ["question", "reply", "✓ replied"],
    ["pr", "approve", "✓ approved"],
    ["pr", "changes", "✓ changes"],
    ["preview", "approve", "✓ looks good"],
    ["preview", "changes", "✓ changes"],
  ] as const)("%s %s reads %s", (kind, value, word) => {
    const i = item({ kind, status: "answered", answer: ans(value), preview: { images: [] }, pr: { url: "https://x/p/1", number: 1 } });
    expect(answeredCardText(i, { now: NOW, tz: "UTC" }).split("\n").pop()).toBe(`${word} · you · 14:02`);
  });

  it("keeps the suffix when the card is long", () => {
    const t = answeredCardText(item({ body: "x".repeat(10_000), status: "answered", answer: ans("B") }), { now: NOW, tz: "UTC" });
    expect(t.length).toBeLessThanOrEqual(3900);
    expect(t.endsWith("✓ B · you · 14:02")).toBe(true);
  });
});

describe("queueCardKeyboard", () => {
  const URL = "https://console.test";

  it("pr: no Approve (decision 60); Changes…, Open PR as a url button, and a Snooze row", () => {
    const kb = queueCardKeyboard(pr(), URL);
    expect(find(kb, "Approve")).toBeUndefined();
    expect(kb.inline_keyboard.flat().some((b) => "callback_data" in b && b.callback_data.startsWith("q:a:"))).toBe(false);
    expect(find(kb, "Changes…")).toEqual({ text: "Changes…", callback_data: `q:c:${ID}` });
    expect(find(kb, "Open PR")).toEqual({ text: "Open PR", url: "https://github.com/o/r/pull/3" });
    expect(kb.inline_keyboard.at(-1)).toEqual([{ text: "Snooze 1h", callback_data: `q:s:${ID}` }]);
  });

  it("pr: no Open PR for a non-https url", () => {
    expect(find(queueCardKeyboard(pr({ pr: { url: "http://x/p/1", number: 1 } }), URL), "Open PR")).toBeUndefined();
  });

  it("local pr: Reconcile link only for an https console url", () => {
    const local = pr({ agentId: "abc12345", pr: { local: { repo: "r", branch: "agent/x" } } });
    expect(find(queueCardKeyboard(local, URL), "Reconcile")).toEqual({ text: "Reconcile", url: "https://console.test/#agent=abc12345&reconcile" });
    expect(find(queueCardKeyboard(local, "https://console.test/"), "Reconcile")).toMatchObject({ url: "https://console.test/#agent=abc12345&reconcile" });
    expect(find(queueCardKeyboard(local, "http://console.test"), "Reconcile")).toBeUndefined();
    expect(find(queueCardKeyboard(local, ""), "Reconcile")).toBeUndefined();
    expect(find(queueCardKeyboard(local, URL), "Approve")).toBeUndefined();
    expect(find(queueCardKeyboard(local, URL), "Open PR")).toBeUndefined();
  });

  it("preview: Open only for https", () => {
    const prev = (url: string) => item({ kind: "preview", choice: undefined, recommend: undefined, preview: { images: [], url } });
    expect(find(queueCardKeyboard(prev("http://x"), URL), "Open")).toBeUndefined();
    expect(find(queueCardKeyboard(prev("https://x"), URL), "Open")).toEqual({ text: "Open", url: "https://x" });
    expect(find(queueCardKeyboard(prev("https://x"), URL), "Looks good")).toEqual({ text: "Looks good", callback_data: `q:a:${ID}` });
    expect(find(queueCardKeyboard(prev("https://x"), URL), "Changes…")).toBeDefined();
  });

  it("question: Reply…", () => {
    const q = item({ kind: "question", choice: undefined, recommend: undefined });
    expect(find(queueCardKeyboard(q, URL), "Reply…")).toEqual({ text: "Reply…", callback_data: `q:r:${ID}` });
  });

  it("a rule suggestion: Yes, No, Edit… (its reply is the new rule text); the head names no agent", () => {
    const rule = item({ agentId: "console", createdBy: { agentId: "console", kind: "console" }, repo: "rules", area: "rules",
      title: "Make this a rule?", body: "Always run the tests\n\nFrom: the fleet master, after your chat.", recommend: undefined,
      choice: { options: [{ key: "A", label: "Yes" }, { key: "B", label: "No" }] }, rule: { id: "r_8f3k2" } });
    expect(buttons(queueCardKeyboard(rule, "https://console")).map((b) => b.text)).toEqual(["Yes", "No", "Edit…", "Snooze 1h"]);
    expect(find(queueCardKeyboard(rule, "https://console"), "Edit…")).toEqual({ text: "Edit…", callback_data: `q:r:${ID}` });
    expect(queueCardText(rule, { now: NOW }).split("\n")[0]).toBe("▸ choice · rules · 12 min");
  });

  it("choice: one button per option, star on the recommended, Other…", () => {
    const kb = queueCardKeyboard(item(), URL);
    expect(kb.inline_keyboard.slice(0, 3).map((r) => r.map((b) => ("callback_data" in b ? b.callback_data : "")))).toEqual([
      [`q:o:${ID}:0`], [`q:o:${ID}:1`], [`q:o:${ID}:2`],
    ]);
    expect(buttons(kb).map((b) => b.text)).toEqual(["Explicit list", "★ Indexer registry", "Both", "Other…", "Snooze 1h"]);
    expect(find(kb, "Other…")).toEqual({ text: "Other…", callback_data: `q:r:${ID}` });
  });

  it("every callback is under 24 bytes for a 9-char id and idx 5", () => {
    const options = Array.from({ length: 6 }, (_, i) => ({ key: String(i), label: `o${i}` }));
    const items = [item({ choice: { options } }), pr(), item({ kind: "question" }), item({ kind: "preview", preview: { images: [] } })];
    for (const it of items) for (const b of buttons(queueCardKeyboard(it, "https://c"))) {
      if ("callback_data" in b) expect(Buffer.byteLength(b.callback_data)).toBeLessThan(24);
    }
    expect(buttons(queueCardKeyboard(items[0], "https://c")).some((b) => "callback_data" in b && b.callback_data === `q:o:${ID}:5`)).toBe(true);
  });
});

describe("auto line", () => {
  const a = item({ status: "auto", answerSeq: 3, answer: { value: "B", by: "master", via: "cli", at: NOW, ruleIds: ["r_8f3k2", "r_aaaaa"] } });
  it("text and Undo carry the answer seq", () => {
    expect(autoLineText(a)).toBe(`auto · ${ID} · B · r_8f3k2, r_aaaaa`);
    expect(autoKeyboard(a)).toEqual({ inline_keyboard: [[{ text: "Undo", callback_data: `q:u:${ID}:3` }]] });
    expect(Buffer.byteLength(`q:u:${ID}:3`)).toBe(15);
  });
});

describe("parseItemCallback", () => {
  it("parses each action", () => {
    expect(parseItemCallback(`q:o:${ID}:2`)).toEqual({ action: "o", itemId: ID, idx: 2 });
    expect(parseItemCallback(`q:u:${ID}:3`)).toEqual({ action: "u", itemId: ID, seq: 3 });
    for (const action of ["a", "c", "r", "s", "x"] as const) expect(parseItemCallback(`q:${action}:${ID}`)).toEqual({ action, itemId: ID });
  });
  it.each([
    undefined, "", `q:a:${ID}:2`, `q:o:${ID}`, `q:u:${ID}`, `q:o:${ID}:x`, `q:o:${ID}:-1`, `q:u:${ID}:1:2`, `q:z:${ID}`,
    `q:k:r_abcde`, "q:a:", `q:a:${ID} `, `x:a:${ID}`, `q:o:${ID}:01`, `q:o:${ID}:99999999999`,
  ])("rejects %j", (d) => { expect(parseItemCallback(d)).toBeNull(); });
});

describe("cardIdsOf", () => {
  it("lists card, media, extra in order without duplicates, safe integers only", () => {
    const t = { cardMessageId: 5, mediaMessageIds: [3, 4, 5], extraMessageIds: [4, 9, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN] };
    expect(cardIdsOf(item({ telegram: t }))).toEqual([5, 3, 4, 9]);
  });
  it("is empty without telegram data", () => {
    expect(cardIdsOf(item())).toEqual([]);
    expect(cardIdsOf(item({ telegram: {} }))).toEqual([]);
  });
});

describe("the Update ticket on a card (the release variant of the console's own ticket)", () => {
  const run = { via: "tab" as const, askedAt: NOW, from: 848, to: 849 };
  it("has an Update button, and none while a press is under way", () => {
    expect(find(queueCardKeyboard(update(), "https://c.example"), "Update")).toEqual({ text: "Update", callback_data: `q:y:${ID}` });
    expect(find(queueCardKeyboard(update(), "https://c.example"), "Deploy")).toBeUndefined();
    const going = update({ deploy: { ...update().deploy!, update: { ...run, state: "running" } } });
    expect(buttons(queueCardKeyboard(going, "https://c.example"))).toEqual([]);
  });
  it("names the versions in its note while it waits for the press", () => {
    expect(queueCardText(update(), { now: NOW })).toContain("Version 848 → 849");
  });
  it("says the state in its note, and how it ended", () => {
    const failed = update({ status: "withdrawn", lastError: "update-failed", closedAt: NOW, deploy: { ...update().deploy!, update: { ...run, state: "failed-back", step: "health" } } });
    const text = answeredCardText(failed, { now: NOW });
    expect(text).toContain("Failed at the health check. Back on version 848. Nothing lost.");
    expect(text).toContain("× update failed");
    const done = update({ status: "withdrawn", lastError: "updated", closedAt: NOW, deploy: { ...update().deploy!, update: { ...run, state: "updated" } } });
    expect(answeredCardText(done, { now: NOW })).toContain("✓ updated");
  });
});
