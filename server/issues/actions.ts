// server/issues/actions.ts — what the card buttons and the /api/issues routes
// do. One set of functions serves both, so a tap and a UI click can never
// diverge. Also owns the issue's Telegram thread (card + replies under it).
import type { Issue, IssueStore, IssueStatus } from "./store.js";
import type { InlineKeyboard, TelegramClient, TgCallbackQuery } from "./telegram.js";
import type { Dispatch } from "./dispatch.js";
import type { SessionStore } from "../agents/store.js";
import { cardKeyboard, cardText, isActionable, parseCallback, repoKeyboard } from "./card.js";

export type ActionResult =
  | { ok: true; issue: Issue }
  | { ok: false; code: 400 | 404 | 409 | 500; error: string };

export type ActionsDeps = {
  store: IssueStore;
  dispatch: Dispatch;
  tg?: TelegramClient;
  chatId?: number; // TELEGRAM_ISSUES_USER_ID — the private chat id equals the user id
  // Re-reads the workspace repos for an issue whose repoChoices is empty
  // (the list failed at intake), so a repo can still be picked.
  listRepoNames?: () => Promise<string[]>;
};

const DROPPABLE: readonly IssueStatus[] = ["pending", "starting", "error"];

function warn(what: string, e: unknown): void {
  console.warn(`[issues] ${what}:`, e instanceof Error ? e.message : e);
}

export class IssueActions {
  // Issue id -> number of fix() calls running for it. A call counts from just
  // before its CAS until it returns, so any won CAS is covered until the
  // agentId link (or the failed start). Boot recovery must not touch these
  // issues: their agent record may not exist yet. A count, not a set: a
  // concurrent call that loses its CAS must never clear the winner's mark.
  private inFlight = new Map<string, number>();

  constructor(private d: ActionsDeps) {}

  private thread(): { tg: TelegramClient; chatId: number } | null {
    return this.d.tg && this.d.chatId ? { tg: this.d.tg, chatId: this.d.chatId } : null;
  }

  // Post a bot message under the issue's card and record its id. Call ONLY
  // from inside store.queue(id); elsewhere use post().
  async postInQueue(id: string, text: string): Promise<void> {
    const t = this.thread();
    if (!t) return;
    const cur = await this.d.store.get(id);
    if (!cur?.cardMessageId) return; // UI issue: no thread
    try {
      const m = await t.tg.sendMessage(t.chatId, text, { replyTo: cur.cardMessageId });
      await this.d.store.mutate(id, (i) => ({ ...i, chatMessageIds: [...i.chatMessageIds, m.message_id] }));
    } catch (e) { warn(`post to ${id}`, e); }
  }

  post(id: string, text: string): Promise<void> {
    return this.d.store.queue(id, () => this.postInQueue(id, text));
  }

  // Send a card (new issue, or boot recovery) as a reply to the user's first
  // source message. No-op when the issue already has a card. Call ONLY from
  // inside store.queue(id).
  async sendCardInQueue(id: string): Promise<void> {
    const t = this.thread();
    if (!t) return;
    const cur = await this.d.store.get(id);
    if (!cur || cur.cardMessageId) return; // already has a card: never send a second one
    try {
      const m = await t.tg.sendMessage(t.chatId, cardText(cur), {
        replyTo: cur.chatMessageIds[0], keyboard: cardKeyboard(cur),
      });
      await this.d.store.mutate(id, (i) => ({
        ...i, cardMessageId: m.message_id, chatMessageIds: [...i.chatMessageIds, m.message_id],
      }));
    } catch (e) { warn(`card for ${id}`, e); }
  }

  sendCard(id: string): Promise<void> {
    return this.d.store.queue(id, () => this.sendCardInQueue(id));
  }

  // Re-render the card in place. Writes nothing to the store.
  async refreshCard(issue: Issue, keyboard: InlineKeyboard | undefined = cardKeyboard(issue)): Promise<void> {
    const t = this.thread();
    if (!t || !issue.cardMessageId) return;
    try { await t.tg.editMessageText(t.chatId, issue.cardMessageId, cardText(issue), keyboard); }
    catch (e) { warn(`card edit for ${issue.id}`, e); }
  }

  private async refused(id: string, why: (cur: Issue) => ActionResult): Promise<ActionResult> {
    const cur = await this.d.store.get(id);
    return cur ? why(cur) : { ok: false, code: 404, error: "not found" };
  }

  // Compare-and-set `pending | error-without-agentId → starting`, then spawn.
  // A second tap (or tap + UI click) loses the CAS and does nothing.
  async fix(id: string): Promise<ActionResult> {
    // Mark in flight BEFORE the CAS, so recovery can never see `starting`
    // without the mark.
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    try {
      const won = await this.d.store.update(id, (cur) =>
        cur.repo && isActionable(cur) ? { ...cur, status: "starting", error: undefined } : null);
      if (!won) {
        return this.refused(id, (cur) => ({
          ok: false, code: 409, error: cur.repo ? `issue is ${cur.status}` : "pick a repo first",
        }));
      }
      await this.refreshCard(won);
      let agentId: string;
      try {
        agentId = await this.d.dispatch(won);
      } catch (e) {
        const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        const failed = await this.d.store.update(id, (cur) =>
          cur.status === "starting" ? { ...cur, status: "error", error: reason } : null);
        if (failed) {
          await this.refreshCard(failed);
          await this.post(id, `Start failed: ${reason}`);
        }
        return { ok: false, code: 500, error: reason };
      }
      // A Drop that landed during the spawn keeps the issue dropped; the agent
      // is still linked so it shows in the tab and can be stopped from there.
      const linked = await this.d.store.update(id, (cur) => ({
        ...cur, agentId, status: cur.status === "starting" ? "running" : cur.status,
      }));
      return { ok: true, issue: linked ?? won };
    } finally {
      const n = (this.inFlight.get(id) ?? 1) - 1;
      if (n > 0) this.inFlight.set(id, n); else this.inFlight.delete(id);
    }
  }

  // An issue saved while the repo list failed has repoChoices = []; nothing
  // could ever be picked. Refresh and store the list once it is available.
  private async ensureRepoChoices(id: string): Promise<Issue | null> {
    const cur = await this.d.store.get(id);
    if (!cur || cur.repoChoices.length > 0 || !this.d.listRepoNames) return cur;
    const fresh = await this.d.listRepoNames().catch((e) => { warn(`repo list for ${id}`, e); return [] as string[]; });
    if (fresh.length === 0) return cur;
    return (await this.d.store.update(id, (c) => c.repoChoices.length === 0 ? { ...c, repoChoices: fresh } : null))
      ?? (await this.d.store.get(id));
  }

  async setRepo(id: string, repo: string): Promise<ActionResult> {
    let refusal = await this.trySetRepo(id, repo);
    // Empty choices: the repo list failed at intake. Refresh once and retry.
    if (refusal === "unknown-empty" && (await this.ensureRepoChoices(id))?.repoChoices.length) {
      refusal = await this.trySetRepo(id, repo);
    }
    if (typeof refusal !== "string") {
      await this.refreshCard(refusal);
      return { ok: true, issue: refusal };
    }
    return this.refused(id, (cur) => refusal !== "busy"
      ? { ok: false, code: 400, error: "unknown repo" }
      : { ok: false, code: 409, error: `issue is ${cur.status}` });
  }

  private async trySetRepo(id: string, repo: string): Promise<Issue | "unknown" | "unknown-empty" | "busy"> {
    let refusal: "unknown" | "unknown-empty" | "busy" = "busy";
    const next = await this.d.store.update(id, (cur) => {
      if (!isActionable(cur)) return null;
      if (!cur.repoChoices.includes(repo)) {
        refusal = cur.repoChoices.length === 0 ? "unknown-empty" : "unknown";
        return null;
      }
      return { ...cur, repo, repoConfidence: 1 };
    });
    return next ?? refusal;
  }

  // An issue with a live agent is closed by stopping or deleting the agent.
  async drop(id: string): Promise<ActionResult> {
    const next = await this.d.store.update(id, (cur) =>
      DROPPABLE.includes(cur.status) ? { ...cur, status: "dropped" } : null);
    if (!next) return this.refused(id, (cur) => ({ ok: false, code: 409, error: `issue is ${cur.status}` }));
    await this.refreshCard(next);
    return { ok: true, issue: next };
  }

  async handleCallback(cq: TgCallbackQuery): Promise<void> {
    // Answer first: Telegram spins the button until we do.
    const t = this.thread();
    if (t) await t.tg.answerCallbackQuery(cq.id).catch((e) => warn("answerCallbackQuery", e));
    const parsed = parseCallback(cq.data);
    if (!parsed) return;
    const issue = parsed.action === "p"
      ? await this.ensureRepoChoices(parsed.issueId)
      : await this.d.store.get(parsed.issueId);
    if (!issue) return;
    switch (parsed.action) {
      case "f": await this.fix(issue.id); return;
      case "d": await this.drop(issue.id); return;
      case "p": if (isActionable(issue)) await this.refreshCard(issue, repoKeyboard(issue)); return;
      case "b": if (isActionable(issue)) await this.refreshCard(issue); return;
      case "r": {
        const name = issue.repoChoices[parsed.index ?? -1];
        if (name) await this.setRepo(issue.id, name);
        return;
      }
    }
  }

  // Boot: a crash between `starting` and `agentId` leaves a dangling issue.
  // Link it to the agent that was created for it, or reset it to pending and
  // send a fresh card. Also sends the card of a Telegram issue saved just
  // before a crash, before its card went out. The poller and API may already
  // be live, so issues with a fix() in flight are skipped, and every decision
  // is re-made on the fresh record inside the queue.
  async recoverStarting(agents: Pick<SessionStore, "list">): Promise<void> {
    const recs = await agents.list();
    for (const issue of await this.d.store.list()) {
      const startingOrphan = issue.status === "starting" && !issue.agentId;
      const cardless = issue.status === "pending" && issue.source === "telegram" && !issue.cardMessageId;
      if (!startingOrphan && !cardless) continue;
      const rec = recs.find((r) => r.issueId === issue.id);
      await this.d.store.queue(issue.id, async () => {
        if (this.inFlight.has(issue.id)) return; // a live tap owns it
        if (startingOrphan) {
          const next = await this.d.store.mutate(issue.id, (cur) => {
            if (cur.status !== "starting" || cur.agentId) return null;
            // Reset: clear cardMessageId so a fresh card goes out. The old
            // card stays in chatMessageIds, so replies to it still route.
            return rec
              ? { ...cur, agentId: rec.id, status: "running" }
              : { ...cur, status: "pending", cardMessageId: undefined };
          });
          if (next?.status === "pending") await this.sendCardInQueue(issue.id);
          if (next?.status === "running") await this.refreshCard(next);
        } else {
          const cur = await this.d.store.get(issue.id);
          if (cur?.status === "pending" && !cur.cardMessageId) await this.sendCardInQueue(issue.id);
        }
      });
    }
  }
}
