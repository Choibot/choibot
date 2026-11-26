import { describe, it, expect } from "vitest";
import { notificationFor, telegramHtmlFor, splitSummary, Notifier, telegramSender } from "./notifier.js";
import { vi } from "vitest";
import { EventHub, type ConsoleEvent } from "../events.js";

const flush = () => new Promise((r) => setImmediate(r));

describe("notificationFor", () => {
  it("fleet-master idle → no notification (chat surface, would spam)", () => {
    expect(notificationFor({ type: "agent-status", agentId: "fleet-master", status: "idle" }, { kind: "fleet-master", label: "Master" }))
      .toBeNull();
  });
  it("lead idle → no notification (a lead is a chat surface)", () => {
    expect(notificationFor({ type: "agent-status", agentId: "lead-app-shop", status: "idle" }, { kind: "lead", label: "Lead" }))
      .toBeNull();
  });
  it("idle → attention (waiting on you)", () => {
    expect(notificationFor({ type: "agent-status", agentId: "a", status: "idle" }))
      .toEqual({ level: "attention", text: "a is waiting on you" });
  });
  it("done → info", () => {
    expect(notificationFor({ type: "agent-status", agentId: "a", status: "done" }))
      .toEqual({ level: "info", text: "a finished" });
  });
  it("error status → error", () => {
    expect(notificationFor({ type: "agent-status", agentId: "a", status: "error" }))
      .toEqual({ level: "error", text: "a errored" });
  });
  it("running → no notification", () => {
    expect(notificationFor({ type: "agent-status", agentId: "a", status: "running" })).toBeNull();
  });
  it("agent-error → error", () => {
    expect(notificationFor({ type: "agent-error", agentId: "a", message: "boom" }))
      .toEqual({ level: "error", text: "a errored: boom" });
  });
  it("fleet-master idle → no notification (chat surface, would spam)", () => {
    expect(notificationFor({ type: "agent-status", agentId: "u", status: "idle" }, { kind: "fleet-master", label: "Master" }))
      .toBeNull();
  });
  it("uses the record label when there is one", () => {
    expect(notificationFor({ type: "agent-status", agentId: "u", status: "idle" }, { label: "fix tests" }))
      .toEqual({ level: "attention", text: "fix tests is waiting on you" });
  });
  it("falls back to the agent id with no record", () => {
    expect(notificationFor({ type: "agent-status", agentId: "u", status: "idle" }))
      .toEqual({ level: "attention", text: "u is waiting on you" });
  });
  it("cron-run ok → info", () => {
    expect(notificationFor({ type: "cron-run", name: "brief", ok: true, summary: "all good" }))
      .toEqual({ level: "info", text: "✓ Recurring · brief — all good" });
  });
  it("cron-run failure → error", () => {
    expect(notificationFor({ type: "cron-run", name: "brief", ok: false, summary: "exit 1" }))
      .toEqual({ level: "error", text: "✗ Recurring · brief — exit 1" });
  });
  it("a run with a state: the user's words and its sentence", () => {
    expect(notificationFor({ type: "cron-run", name: "brief", ok: true, summary: "x", said: { state: "needs-you", sentence: "Costs are up." } }))
      .toEqual({ level: "attention", text: "Recurring · brief: Needs you. Costs are up." });
    expect(notificationFor({ type: "cron-run", name: "brief", ok: false, summary: "x", said: { state: "did-not-finish", sentence: "It did not start." } }))
      .toEqual({ level: "error", text: "Recurring · brief: Did not finish. It did not start." });
  });
});

describe("splitSummary", () => {
  it("splits tldr from details at the first blank line", () => {
    expect(splitSummary("- top issue\n- second\n\nAll the detail\nmore detail"))
      .toEqual({ tldr: "- top issue\n- second", details: "All the detail\nmore detail" });
  });
  it("falls back to first-line/rest when there is no blank line", () => {
    expect(splitSummary("exit 3: boom\nstack line 1\nstack line 2"))
      .toEqual({ tldr: "exit 3: boom", details: "stack line 1\nstack line 2" });
  });
  it("single line → all tldr, no details", () => {
    expect(splitSummary("all good")).toEqual({ tldr: "all good", details: "" });
  });
});

describe("telegramHtmlFor", () => {
  it("cron ok, single-line summary → visible tldr, no quote", () => {
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "all good" }))
      .toBe("✅ <b>brief</b>\nall good");
  });
  it("cron with tldr + details → tldr visible, details in an expandable quote", () => {
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "- top issue\n\nfull digest here" }))
      .toBe("✅ <b>brief</b>\n- top issue\n<blockquote expandable>full digest here</blockquote>");
  });
  it("cron fail → red emoji; markdown noise arrives literally but HTML is escaped", () => {
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: false, summary: "exit 1: **bold** <tag> & co" }))
      .toBe("❌ <b>brief</b>\nexit 1: **bold** &lt;tag&gt; &amp; co");
  });
  it("cron with empty summary → head only, no empty quote", () => {
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "  " }))
      .toBe("✅ <b>brief</b>");
  });
  it("a run with a state: words, its sentence as plain escaped text, the task link, no output tail", () => {
    const URL = "https://console.example.ts.net";
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "The digest:\n- <b>3</b> errors", said: { state: "needs-you", sentence: "3 new <b>errors</b> & a **slow** page." } }, null, URL))
      .toBe(`<b>Recurring · brief</b>: Needs you. 3 new &lt;b&gt;errors&lt;/b&gt; &amp; a slow page.\n<a href="${URL}/#recurring=brief">Open the task</a>\n<blockquote expandable>The digest:\n- &lt;b&gt;3&lt;/b&gt; errors</blockquote>`);
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: false, summary: "exit 1: tail", said: { state: "did-not-finish", sentence: "It ran longer than its time limit." } }, null, `${URL}/`))
      .toBe(`<b>Recurring · brief</b>: Did not finish. It ran longer than its time limit.\n<a href="${URL}/#recurring=brief">Open the task</a>`);
    // No console address (or a bad one): no link. No sentence, and an answer that is the sentence: the state alone.
    for (const url of [undefined, "", "javascript:alert(1)", "https://x\" onclick=\"y"]) {
      expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "", said: { state: "all-clear", sentence: null } }, null, url))
        .toBe("<b>Recurring · brief</b>: All clear.");
    }
    expect(telegramHtmlFor({ type: "cron-run", name: "brief", ok: true, summary: "Fine.", said: { state: "all-clear", sentence: "Fine." } }))
      .toBe("<b>Recurring · brief</b>: All clear. Fine.");
  });
  it("agent idle → attention emoji + escaped text", () => {
    expect(telegramHtmlFor({ type: "agent-status", agentId: "u", status: "idle" }, { label: "fix <html>" }))
      .toBe("💬 fix &lt;html&gt; is waiting on you");
  });
  it("suppressed events stay null", () => {
    expect(telegramHtmlFor({ type: "agent-status", agentId: "u", status: "idle" }, { kind: "fleet-master" })).toBeNull();
  });
});

describe("Notifier", () => {
  it("cron-run pings telegram once and re-emits nothing", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }).start();
    const seen: ConsoleEvent[] = [];
    hub.subscribe((e) => seen.push(e));

    hub.emitEvent({ type: "cron-run", name: "brief", ok: true, summary: "all good" });
    await flush();

    expect(sent).toEqual(["✅ <b>brief</b>\nall good"]);
    expect(seen.filter((e) => e.type === "agent-notify")).toEqual([]);
  });

  it("a quiet done (a sign-out of its login ended the agent): no Telegram message and no notice", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }, async () => ({ label: "w" })).start();
    const seen: ConsoleEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    hub.emitEvent({ type: "agent-status", agentId: "a1", status: "done", quiet: true });
    await flush();
    expect(sent).toEqual([]);
    expect(seen.filter((e) => e.type === "agent-notify")).toEqual([]);
    hub.emitEvent({ type: "agent-status", agentId: "a1", status: "done" });
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("cron-run with telegram:false (the job's notify policy) sends nothing", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }).start();
    hub.emitEvent({ type: "cron-run", name: "brief", ok: true, summary: "all good", telegram: false });
    await flush();
    expect(sent).toEqual([]);
  });

  it("cron-run goes to the cron sender when one is set; agent pings keep the default", async () => {
    const hub = new EventHub();
    const main: string[] = []; const cron: string[] = [];
    new Notifier(hub, async (t) => { main.push(t); }, async () => ({ label: "w" }), { cronTelegram: async (t) => { cron.push(t); } }).start();
    hub.emitEvent({ type: "cron-run", name: "brief", ok: true, summary: "all good" });
    hub.emitEvent({ type: "agent-status", agentId: "a1", status: "error" });
    await flush();
    expect(cron).toEqual(["✅ <b>brief</b>\nall good"]);
    expect(main).toHaveLength(1);
    expect(main[0]).toContain("errored");
  });

  it("a run with a state goes to the cron sender with the link of the Notifier's console address", async () => {
    const hub = new EventHub();
    const cron: string[] = [];
    new Notifier(hub, undefined, undefined, { cronTelegram: async (t) => { cron.push(t); }, consoleUrl: "https://c.example" }).start();
    hub.emitEvent({ type: "cron-run", name: "brief", ok: true, summary: "Backup: 2 files missing.", said: { state: "needs-you", sentence: "Look at the backup." } });
    await flush();
    expect(cron).toEqual(['<b>Recurring · brief</b>: Needs you. Look at the backup.\n<a href="https://c.example/#recurring=brief">Open the task</a>\n<blockquote expandable>Backup: 2 files missing.</blockquote>']);
  });

  it("stays quiet for an agent the lookup says is the fleet master", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }, async () => ({ kind: "fleet-master", label: "Master" })).start();

    hub.emitEvent({ type: "agent-status", agentId: "fleet-master", status: "idle" });
    await flush();

    expect(sent).toEqual([]);
  });

  it("keeps issue-agent pings off Telegram but still emits agent-notify for the badge", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    const notes: ConsoleEvent[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }, async () => ({ kind: "issue", label: "issue: login" })).start();
    hub.subscribe((e) => { if (e.type === "agent-notify") notes.push(e); });

    hub.emitEvent({ type: "agent-status", agentId: "i1", status: "idle" });
    hub.emitEvent({ type: "agent-status", agentId: "i1", status: "error" });
    await flush();

    expect(sent).toEqual([]);
    expect(notes.map((n) => (n as { level: string }).level)).toEqual(["attention", "error"]);
  });

  it("still notifies for a worker agent, using its label", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    const notes: ConsoleEvent[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }, async () => ({ label: "fix tests" })).start();
    hub.subscribe((e) => { if (e.type === "agent-notify") notes.push(e); });

    hub.emitEvent({ type: "agent-status", agentId: "u", status: "idle" });
    await flush();

    expect(sent).toEqual(["💬 fix tests is waiting on you"]);
    expect(notes).toEqual([{ type: "agent-notify", agentId: "u", level: "attention", text: "fix tests is waiting on you" }]);
  });

  it("agentTelegram:false keeps agent pings off Telegram but on the hub; cron-run still sends", async () => {
    const hub = new EventHub();
    const sent: string[] = [];
    const notes: ConsoleEvent[] = [];
    new Notifier(hub, async (t) => { sent.push(t); }, async () => null, { agentTelegram: false }).start();
    hub.subscribe((e) => { if (e.type === "agent-notify") notes.push(e); });

    hub.emitEvent({ type: "agent-status", agentId: "u", status: "idle" });
    hub.emitEvent({ type: "cron-run", name: "brief", ok: false, summary: "exit 1" });
    await flush();

    expect(sent).toEqual(["❌ <b>brief</b>\nexit 1"]);
    expect(notes).toEqual([{ type: "agent-notify", agentId: "u", level: "attention", text: "u is waiting on you" }]);
  });
});

describe("telegramSender", () => {
  it("adds message_thread_id only when a topic is given", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("{}", { status: 200 });
    });
    try {
      await telegramSender("tok", "-100", 4)("hi");
      await telegramSender("tok", "-100")("hi");
    } finally { f.mockRestore(); }
    expect(bodies[0]).toMatchObject({ chat_id: "-100", message_thread_id: 4, text: "hi" });
    expect(bodies[1]).not.toHaveProperty("message_thread_id");
  });
});

describe("telegramSender", () => {
  it("posts to the given Bot API (a fake of a test instance), else to the real one", async () => {
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL) => { urls.push(String(u)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    try {
      await telegramSender("T", "-100", 4, "http://127.0.0.1:9999")("x");
      await telegramSender("T", "-100")("x");
    } finally { globalThis.fetch = real; }
    expect(urls).toEqual(["http://127.0.0.1:9999/botT/sendMessage", "https://api.telegram.org/botT/sendMessage"]);
  });
});
