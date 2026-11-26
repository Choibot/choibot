// server/chief/queue/prwatch.ts — closes pr items whose PR was merged or closed (spec §5.1).
// A merge is the only way a pr item is approved (overview decision 60): the close leaves the
// merged notice `pending` on the item, and `onMerged` (the Deliverer's kick) sends it to the agent.
// Every gh and git call runs outside the item lock; the result is written inside
// store.withItem after re-reading the item, and only while it is still open or
// snoozed with the same pr. Each call has a deadline, so a hung gh or git never
// keeps a single-flight run pending.
import type { SessionStore } from "../../agents/store.js";
import { deadline } from "../deadline.js";
import { repoOfPrUrl, type AddDeps } from "./add.js";
import { closedMerged } from "./lines.js";
import type { QueueStore } from "./store.js";
import type { QueueItem } from "./types.js";

// One `gh pr view` per open or snoozed pr item with a PR URL, each minute, and nothing at all
// while there is none (overview decision 64). Before: 10 minutes, so a merge on github.com
// left its ticket open for up to that long.
const REMOTE_MS = 60_000;
const LOCAL_MS = 60_000;
const REFRESH_GAP_MS = 60_000;
// One gh or git call of a run; past it the call counts as failed (the item is left as it is).
export const PRWATCH_CALL_MS = 30_000;

type Deps = {
  store: QueueStore; agents: Pick<SessionStore, "load">; workspaceDir: string;
  listRepos: AddDeps["listRepos"]; prStatus: AddDeps["prStatus"];
  isAncestor: (repoPath: string, branch: string, base: string) => Promise<boolean>;
  // Called once an item was closed as merged, after its item lock is released.
  onMerged?: (id: string) => void;
  now?: () => number; log?: (s: string) => void; callTimeoutMs?: number;
};
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const WARN_AGAIN_MS = 60 * 60_000;

const live = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const urlOf = (i: QueueItem): string | null => (i.pr && "url" in i.pr ? i.pr.url : null);
const localOf = (i: QueueItem) => (i.pr && "local" in i.pr ? i.pr.local : null);

export class PrWatch {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private lastRefresh = -Infinity;
  private remoteRun: Promise<void> | null = null;
  private localRun: Promise<void> | null = null;
  private readonly warned = new Map<string, { msg: string; at: number }>();
  private readonly cut: <T>(p: Promise<T>, what: string) => Promise<T>;

  constructor(private readonly d: Deps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
    const ms = d.callTimeoutMs ?? PRWATCH_CALL_MS;
    this.cut = (p, what) => deadline(p, ms, what);
  }

  // One run per kind at a time: a slow or hung gh/git never piles up more runs.
  checkRemote(): Promise<void> {
    return this.remoteRun ??= this.runRemote().finally(() => { this.remoteRun = null; });
  }
  checkLocal(): Promise<void> {
    return this.localRun ??= this.runLocal().finally(() => { this.localRun = null; });
  }

  // A repeated failure of one item logs again only when the message changes or after an hour.
  private warn(what: string, id: string, err: unknown): void {
    const msg = errText(err), key = `${what}:${id}`, t = this.now(), prev = this.warned.get(key);
    if (prev && prev.msg === msg && t - prev.at < WARN_AGAIN_MS) return;
    this.warned.set(key, { msg, at: t });
    this.log(`[queue] ${what} failed for ${id}: ${msg}`);
  }

  private async runRemote(): Promise<void> {
    const items = (await this.d.store.list()).filter((i) => urlOf(i) && live(i));
    if (items.length === 0) return;
    const repos = await this.cut(this.d.listRepos(this.d.workspaceDir), "listRepos");
    const lookup = { workspaceDir: this.d.workspaceDir, listRepos: async () => repos };
    for (const item of items) {
      const url = urlOf(item)!;
      try {
        const repo = await repoOfPrUrl(lookup, url);
        if (!repo) continue;
        const status = await this.cut(this.d.prStatus(repo.path, (item.pr as { number: number }).number), "gh pr view");
        const merged = await this.d.store.withItem(item.id, async (): Promise<boolean> => {
          const cur = await this.d.store.get(item.id);
          if (!cur || !live(cur) || urlOf(cur) !== url) return false;
          const pr = cur.pr as Extract<NonNullable<QueueItem["pr"]>, { url: string }>;
          if (status.prState === "MERGED") {
            await this.d.store.write(closedMerged(cur, this.now()));
            return true;
          }
          if (status.prState === "CLOSED") {
            await this.d.store.write({ ...cur, status: "withdrawn", lastError: "closed", closedAt: this.now() });
          } else if (pr.checks !== status.checks.rollup || pr.mergeable !== status.mergeable) {
            await this.d.store.write({ ...cur, pr: { ...pr, checks: status.checks.rollup, mergeable: status.mergeable } });
          }
          return false;
        });
        if (merged) this.merged(item.id);
      } catch (err) { this.warn("pr check", item.id, err); }
    }
  }

  private async runLocal(): Promise<void> {
    for (const item of await this.d.store.list()) {
      const local = localOf(item);
      if (!local || !live(item) || local.aheadAtAdd !== true) continue;
      try {
        const rec = await this.d.agents.load(item.agentId);
        if (!rec) continue;
        if (!(await this.cut(this.d.isAncestor(rec.repo, local.branch, rec.baseBranch), "git merge-base"))) continue;
        const merged = await this.d.store.withItem(item.id, async (): Promise<boolean> => {
          const cur = await this.d.store.get(item.id);
          const now = cur ? localOf(cur) : null;
          if (!cur || !live(cur) || !now || now.repo !== local.repo || now.branch !== local.branch) return false;
          await this.d.store.write(closedMerged(cur, this.now()));
          return true;
        });
        if (merged) this.merged(item.id);
      } catch (err) { this.warn("local merge check", item.id, err); }
    }
  }

  // The item is closed and its lock is free: the merged line may go out. A
  // throw here must not look like a failed check of the item.
  private merged(id: string): void {
    try { this.d.onMerged?.(id); } catch (err) { this.log(`[queue] merged notice kick failed for ${id}: ${errText(err)}`); }
  }

  // Right after a merge or a close made through the console (the GitHub tab's
  // routes, an agent branch merge): the item closes now, not at the next
  // timer. Never awaited by its caller, never throws.
  // A run already in flight may have read the state before the change, so a
  // fresh run follows it.
  checkNow(): void {
    this.lastRefresh = this.now();
    const after = (running: Promise<void> | null, f: () => Promise<void>) => (running ? running.then(f, f) : f());
    after(this.remoteRun, () => this.checkRemote()).catch((err) => this.log(`[queue] pr check failed: ${errText(err)}`));
    after(this.localRun, () => this.checkLocal()).catch((err) => this.log(`[queue] local merge check failed: ${errText(err)}`));
  }

  // From GET /api/queue: at most one check per 60 s, never awaited.
  refreshSoon(): void {
    const t = this.now();
    if (t - this.lastRefresh < REFRESH_GAP_MS) return;
    this.lastRefresh = t;
    this.checkRemote().catch((err) => this.log(`[queue] pr refresh failed: ${errText(err)}`));
  }

  start(): () => void {
    const run = (f: () => Promise<void>) => () => {
      f().catch((err) => this.log(`[queue] pr watch failed: ${errText(err)}`));
    };
    const a = setInterval(run(() => this.checkRemote()), REMOTE_MS);
    const b = setInterval(run(() => this.checkLocal()), LOCAL_MS);
    a.unref?.(); b.unref?.();
    return () => { clearInterval(a); clearInterval(b); };
  }
}
