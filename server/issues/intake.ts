// server/issues/intake.ts — turn a coalesced Telegram message (or UI text)
// into a saved issue with a repo guess, then post its card.
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { IssueActions } from "./actions.js";
import type { MergedMessage } from "./coalesce.js";
import type { RepoGuess } from "./guess.js";
import { summaryOf, telegramIssueId, uiIssueId, type Issue, type IssueStore } from "./store.js";
import { TelegramError, type TelegramClient, type TgPhotoSize } from "./telegram.js";

export const PHOTO_MAX_BYTES = 20 * 1024 * 1024; // Bot API getFile limit
const TOO_BIG = "(photo skipped: over 20 MB)";
const FAILED = "(photo skipped: download failed)";

export type IntakeDeps = {
  store: IssueStore;
  actions: IssueActions;
  listRepoNames: () => Promise<string[]>;
  guess: (text: string, repos: string[]) => Promise<RepoGuess>;
  tg?: TelegramClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// A failed card send is retried once: every later thread post needs
// cardMessageId, so an issue without a card would go silent until a restart.
export const CARD_RETRY_MS = 2_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class IssueIntake {
  constructor(private d: IntakeDeps) {}

  async fromTelegram(m: MergedMessage): Promise<Issue> {
    const id = telegramIssueId(m.firstMessageId);
    const existing = await this.d.store.get(id);
    if (existing) {
      // Re-delivery after a crash. Finish the one step that may be missing.
      if (!existing.cardMessageId) await this.ensureCard(id);
      return (await this.d.store.get(id)) ?? existing;
    }
    const { paths, notes } = await this.downloadPhotos(id, m.photos);
    const text = [m.text, ...notes].filter(Boolean).join("\n\n");
    const issue = await this.build(id, "telegram", text, m.forwardedFrom, paths, m.messageIds);
    const { issue: saved } = await this.d.store.create(issue);
    if (!saved.cardMessageId) await this.ensureCard(id);
    return (await this.d.store.get(id)) ?? saved;
  }

  // Send the card; if it did not land (Telegram error), wait and try once more.
  private async ensureCard(id: string): Promise<void> {
    await this.d.actions.sendCard(id);
    if (!this.d.tg || (await this.d.store.get(id))?.cardMessageId) return;
    await (this.d.sleep ?? defaultSleep)(CARD_RETRY_MS);
    await this.d.actions.sendCard(id);
  }

  async fromUi(text: string): Promise<Issue> {
    const issue = await this.build(uiIssueId(), "ui", text.trim(), undefined, [], []);
    return (await this.d.store.create(issue)).issue;
  }

  // Largest size of each photo → <dir>/<id>/<prefix>-<n><ext>. Never throws.
  async downloadPhotos(id: string, photos: TgPhotoSize[], prefix = "photo"): Promise<{ paths: string[]; notes: string[] }> {
    const paths: string[] = [];
    const notes: string[] = [];
    if (!this.d.tg || photos.length === 0) return { paths, notes };
    const dir = this.d.store.issueDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const [i, p] of photos.entries()) {
      if ((p.file_size ?? 0) > PHOTO_MAX_BYTES) { notes.push(TOO_BIG); continue; }
      try {
        const f = await this.d.tg.getFile(p.file_id);
        if (!f.file_path || (f.file_size ?? 0) > PHOTO_MAX_BYTES) { notes.push(TOO_BIG); continue; }
        const ext = /^\.[a-z0-9]{1,5}$/i.test(extname(f.file_path)) ? extname(f.file_path) : ".jpg";
        const dest = join(dir, `${prefix}-${i + 1}${ext}`);
        await writeFile(dest, await this.d.tg.downloadFile(f.file_path));
        paths.push(dest);
      } catch (e) {
        notes.push(e instanceof TelegramError && /too big/i.test(e.description) ? TOO_BIG : FAILED);
      }
    }
    return { paths, notes };
  }

  private async build(
    id: string, source: Issue["source"], text: string, forwardedFrom: string | undefined,
    photos: string[], messageIds: number[],
  ): Promise<Issue> {
    const repos = await this.d.listRepoNames().catch(() => [] as string[]);
    const g = await this.d.guess(text, repos).catch((): RepoGuess => ({ repo: null, confidence: 0 }));
    return {
      id, createdAt: (this.d.now ?? Date.now)(), source, text,
      ...(forwardedFrom ? { forwardedFrom } : {}),
      photos, repo: g.repo, repoConfidence: g.confidence, repoChoices: repos,
      summary: summaryOf(text), status: "pending", chatMessageIds: messageIds,
    };
  }
}
