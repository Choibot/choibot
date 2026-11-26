import { isPersistentKind } from "./store.js";
import type { EventHub, ConsoleEvent, AgentEvent, CronRunEvent } from "../events.js";
import { STATE_WORDS, runMessageHtml, taskPageUrl } from "../../bin/lib/cron-result.mjs";

export type TelegramSender = (text: string) => Promise<void>;
export type RecLookup = (agentId: string) => Promise<{ kind?: string; label?: string } | null>;

// A cron summary is TLDR-first: the text before the first blank line is the
// headline; everything after is detail. Jobs are prompted to end with
// "tldr bullets\n\nfull digest" — a summary with no blank line falls back to
// first-line/rest so failure tails ("exit 3: …") still get a visible headline.
export function splitSummary(summary: string): { tldr: string; details: string } {
  const t = summary.trim();
  const blank = t.search(/\n[ \t]*\n/);
  const cut = blank !== -1 ? blank : t.indexOf("\n");
  if (cut === -1) return { tldr: t, details: "" };
  return { tldr: t.slice(0, cut).trim(), details: t.slice(cut).trim() };
}

export function notificationFor(
  ev: AgentEvent | CronRunEvent,
  rec?: { kind?: string; label?: string } | null,
): { level: "info" | "attention" | "error"; text: string } | null {
  if (ev.type === "cron-run") {
    // Rail line stays scannable: headline only, never the multi-KB digest.
    const level = ev.ok ? (ev.said?.state === "needs-you" ? "attention" : "info") : "error";
    if (ev.said) return { level, text: `Recurring · ${ev.name}: ${STATE_WORDS[ev.said.state]}.${ev.said.sentence ? ` ${ev.said.sentence}` : ""}` };
    return { level, text: `${ev.ok ? "✓" : "✗"} Recurring · ${ev.name} — ${splitSummary(ev.summary).tldr}` };
  }
  // The masters are chat surfaces — every reply flips them idle; a Telegram
  // ping per turn would be spam. Cron runs notify via cron-run instead.
  if (isPersistentKind(rec?.kind)) return null;
  const who = rec?.label || ev.agentId;
  switch (ev.type) {
    case "agent-status":
      if (ev.status === "idle") return { level: "attention", text: `${who} is waiting on you` };
      if (ev.status === "done") return { level: "info", text: `${who} finished` };
      if (ev.status === "error") return { level: "error", text: `${who} errored` };
      return null;
    case "agent-error": return { level: "error", text: `${who} errored: ${ev.message}` };
    case "agent-notify": return null;
    default: return null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const LEVEL_EMOJI = { info: "✅", attention: "💬", error: "❌" } as const;

// Telegram rendering of an event (parse_mode HTML). A run of a recurring task with a state:
// "Recurring · <task>: Needs you. <its sentence>", the link to the task's page (`consoleUrl`:
// the console's address; none: no link), and for a run that finished the task's answer (the
// summary: the answer with no result line) folded under it (runMessageHtml, the same as the
// runner's own fallback). A run with no result line (a task from before): as before, colored
// status emoji, bold task name, summary folded into an expandable quote so long digests collapse. The hub's agent-notify text stays plain — this is phone-only
// presentation.
export function telegramHtmlFor(
  ev: AgentEvent | CronRunEvent,
  rec?: { kind?: string; label?: string } | null,
  consoleUrl?: string,
): string | null {
  if (ev.type === "cron-run" && ev.said) {
    return runMessageHtml({ name: ev.name, state: ev.said.state, sentence: ev.said.sentence, url: taskPageUrl(consoleUrl, ev.name), text: ev.summary });
  }
  if (ev.type === "cron-run") {
    const head = `${ev.ok ? "✅" : "❌"} <b>${escapeHtml(ev.name)}</b>`;
    const { tldr, details } = splitSummary(ev.summary);
    let out = head;
    if (tldr) out += `\n${escapeHtml(tldr)}`;
    if (details) out += `\n<blockquote expandable>${escapeHtml(details)}</blockquote>`;
    return out;
  }
  const n = notificationFor(ev, rec);
  if (!n) return null;
  return `${LEVEL_EMOJI[n.level]} ${escapeHtml(n.text)}`;
}

export class Notifier {
  // agentTelegram:false scopes Telegram to cron-run results only — agent status
  // pings still reach the hub (UI badges) but stay off the phone.
  constructor(
    private hub: EventHub,
    private sendTelegram?: TelegramSender,
    private lookup?: RecLookup,
    // cronTelegram: where cron results go (a forum topic); default sendTelegram.
    // consoleUrl: the console's address, for the link to a recurring task's page.
    private opts: { agentTelegram?: boolean; cronTelegram?: TelegramSender; consoleUrl?: string } = {},
  ) {}
  start(): void {
    this.hub.subscribe((e: ConsoleEvent) => {
      if (e.type === "agent-notify") return; // don't recurse on our own emissions
      if (e.type === "cron-run") {
        if (e.telegram === false) return; // the job's notify policy: no message for this run
        const html = telegramHtmlFor(e, null, this.opts.consoleUrl);
        const send = this.opts.cronTelegram ?? this.sendTelegram;
        if (html && send) void send(html).catch((err) => console.warn(`[telegram] cron ${e.name}: ${err}`));
        return; // no agent behind it — nothing to re-emit as agent-notify
      }
      if (e.type !== "agent-status" && e.type !== "agent-error") return;
      // An agent that the console ended on purpose (a sign-out): the result line says it.
      if (e.type === "agent-status" && e.quiet) return;
      void (async () => {
        const rec = this.lookup ? await this.lookup(e.agentId).catch(() => null) : null;
        const n = notificationFor(e, rec);
        if (!n) return;
        this.hub.emitEvent({ type: "agent-notify", agentId: e.agentId, level: n.level, text: n.text });
        // Issue agents talk to the phone through the issue relay (their own
        // Telegram thread); a second status ping per turn would be noise.
        if (this.sendTelegram && this.opts.agentTelegram !== false && rec?.kind !== "issue") {
          const html = telegramHtmlFor(e, rec);
          if (html) void this.sendTelegram(html).catch((err) => console.warn(`[telegram] ${err}`));
        }
      })();
    });
  }
}

// threadId targets a forum topic (message_thread_id) in a forum group. apiBase: a fake Bot API
// of a CHIEF_TEST instance (settings/telegram.ts testTelegramApi); default the real one.
export function telegramSender(token: string, chatId: string, threadId?: number, apiBase = "https://api.telegram.org"): TelegramSender {
  const post = (body: object) =>
    fetch(`${apiBase}/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const where = threadId ? { chat_id: chatId, message_thread_id: threadId } : { chat_id: chatId };
  return async (text: string) => {
    let res = await post({ ...where, text, parse_mode: "HTML" });
    // Malformed HTML in a summary must not lose the notification — retry plain.
    if (!res.ok) res = await post({ ...where, text });
    if (!res.ok) throw new Error(`telegram ${res.status}`);
  };
}
