// server/issues/poller.ts — long-poll the bot (getUpdates) inside the console
// server. No webhook, no public endpoint. After each update is routed, the
// next offset is stored, so a crash re-delivers at most the update in progress.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TelegramClient, TgCallbackQuery, TgMessage, TgUpdate } from "./telegram.js";
import type { MasterRoute } from "../master/telegram.js";
import type { ChiefRoute } from "../chief/telegram.js";
import { isAllowedUpdate, isCommand } from "./updates.js";

export const POLL_TIMEOUT_SEC = 30;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export type PollerDeps = {
  tg: Pick<TelegramClient, "getUpdates">;
  // null: no account is connected yet. Then only `link` takes a message (linkOnlyPoller).
  userId: number | null;
  offsetFile: string;
  onCallback: (cq: TgCallbackQuery) => Promise<void>;
  onReply: (issueId: string, msg: TgMessage) => Promise<void>;
  onNew: (msg: TgMessage) => void;
  findIssueByMessageId: (messageId: number) => Promise<{ id: string } | null>;
  // The fleet master's Telegram topic (server/master/telegram.ts). Routed BEFORE
  // the issues filter, which only accepts private chats.
  master?: { route: (u: TgUpdate) => MasterRoute; onMessage: (m: TgMessage) => Promise<void> };
  // The chief of staff's Telegram route (server/chief/telegram.ts), asked
  // first. Synchronous: "handled" means it queued its own work. Absent = flag off.
  chief?: { route(u: TgUpdate): ChiefRoute };
  // The one-time codes of the Settings page (server/settings/link.ts), asked before every other
  // route. It passes at once while no code waits, so nothing changes until the user asks for one.
  link?: { route(u: TgUpdate): Promise<"handled" | "pass"> };
  // Deprecated private-chat intake (TELEGRAM_ISSUE_INTAKE=0): new messages go to
  // onIntakeOff (a "forward to the Master topic" hint) instead of becoming
  // issues. Replies to existing cards and card buttons still work.
  intakeOff?: boolean;
  onIntakeOff?: (m: TgMessage) => void;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class IssuePoller {
  private offset = 0;
  private backoffMs = 0;
  private stopped = false;
  private abort = new AbortController();

  constructor(private d: PollerDeps) {}

  async loadOffset(): Promise<void> {
    try {
      const v = JSON.parse(await readFile(this.d.offsetFile, "utf8")) as { offset?: unknown };
      if (typeof v.offset === "number" && Number.isSafeInteger(v.offset) && v.offset >= 0) this.offset = v.offset;
    } catch { /* first run, or torn file: start from 0 */ }
  }

  private async saveOffset(): Promise<void> {
    await mkdir(dirname(this.d.offsetFile), { recursive: true, mode: 0o700 });
    const tmp = `${this.d.offsetFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ offset: this.offset }));
    await rename(tmp, this.d.offsetFile);
  }

  async route(u: TgUpdate): Promise<void> {
    if (this.d.link && (await this.d.link.route(u)) === "handled") return;
    if (this.d.chief?.route(u) === "handled") return;
    const r = this.d.master?.route(u) ?? "pass";
    if (r === "drop") return;
    if (r === "master") {
      // Not awaited: reviving the master can take 20 s and must not stall
      // issue intake. The bridge keeps master messages in order itself.
      void this.d.master!.onMessage(u.message!)
        .catch((e) => console.warn(`[master] telegram message failed: ${errText(e)}`));
      return;
    }
    if (this.d.userId === null) return;
    if (!isAllowedUpdate(u, this.d.userId)) {
      // Best effort: a group migration means TELEGRAM_CHAT_ID is now stale.
      const to = u.message?.migrate_to_chat_id;
      if (to) console.warn(`[issues] a Telegram group migrated to chat ${to} — update TELEGRAM_CHAT_ID for notifications`);
      return;
    }
    if (u.callback_query) { await this.d.onCallback(u.callback_query); return; }
    const m = u.message!;
    const quoted = m.reply_to_message?.message_id;
    if (quoted !== undefined) {
      const issue = await this.d.findIssueByMessageId(quoted);
      if (issue) { await this.d.onReply(issue.id, m); return; }
    }
    if (isCommand(m)) return;                                  // /start and friends
    if (await this.d.findIssueByMessageId(m.message_id)) return; // already part of an issue
    if (this.d.intakeOff) { this.d.onIntakeOff?.(m); return; }
    this.d.onNew(m);
  }

  async pollOnce(): Promise<void> {
    const updates = await this.d.tg.getUpdates(this.offset, POLL_TIMEOUT_SEC, this.abort.signal);
    for (const u of updates) {
      try { await this.route(u); }
      catch (e) { console.warn(`[issues] update ${u.update_id} failed: ${errText(e)}`); }
      this.offset = u.update_id + 1;
      await this.saveOffset();
    }
  }

  nextBackoff(): number {
    this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
    return this.backoffMs;
  }

  start(): void {
    const sleep = this.d.sleep ?? defaultSleep;
    void (async () => {
      await this.loadOffset();
      while (!this.stopped) {
        try {
          await this.pollOnce();
          this.backoffMs = 0;
        } catch (e) {
          if (this.stopped) break;
          const wait = this.nextBackoff();
          // 409 = another consumer polls this bot; 5xx / network = Telegram trouble.
          console.warn(`[issues] getUpdates failed (${errText(e)}) — retry in ${wait} ms`);
          await sleep(wait);
        }
      }
    })();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }
}

// The poller of a console with a bot and no connected account: it runs only while a one-time
// code waits (server/index.ts starts and stops it), and only `link` takes a message. It shares
// the offset file with the full poller, so no message is read two times after the restart.
export function linkOnlyPoller(d: Pick<PollerDeps, "tg" | "offsetFile" | "sleep"> & { link: NonNullable<PollerDeps["link"]> }): IssuePoller {
  return new IssuePoller({
    ...d, userId: null,
    onCallback: async () => {}, onReply: async () => {}, onNew: () => {}, findIssueByMessageId: async () => null,
  });
}
