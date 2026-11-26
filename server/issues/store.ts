// server/issues/store.ts — one JSON file per issue at <dir>/<id>/issue.json,
// photos next to it. Every change to one issue goes through a per-issue serial
// queue, so the poller, relay and API never lose each other's writes.
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ellipsize } from "./text.js";

export type IssueStatus =
  | "pending" | "starting" | "running" | "needs-input"
  | "pr-open" | "done" | "error" | "dropped";

export type Issue = {
  id: string;                  // "t" + first Telegram message_id, or "u" + 8 base36
  createdAt: number;
  source: "telegram" | "ui";
  text: string;                // merged body text / captions
  forwardedFrom?: string;
  photos: string[];            // absolute paths under <dir>/<id>/
  repo: string | null;         // repo NAME (listRepos().name); null = guess not confident
  repoConfidence: number;
  repoChoices: string[];       // repo names snapshot for the Repo ▾ keyboard
  summary: string;
  status: IssueStatus;
  agentId?: string; prUrl?: string; prNumber?: number;
  error?: string;
  chatMessageIds: number[];    // user source messages + every bot message of this issue
  cardMessageId?: number;
};

// Doubles as the path guard for every route and file that takes an issue id.
export const ISSUE_ID_RE = /^(t\d{1,11}|u[0-9a-z]{8})$/;

// Statuses with a live agent behind them.
export const LIVE_STATUSES: readonly IssueStatus[] = ["running", "needs-input", "pr-open"];

export function telegramIssueId(firstMessageId: number): string {
  return `t${firstMessageId}`;
}

export function uiIssueId(): string {
  let s = "";
  for (const b of randomBytes(8)) s += (b % 36).toString(36);
  return `u${s}`;
}

export function summaryOf(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return "(photo)";
  return ellipsize(line, 80);
}

// A closed issue whose agent is working again. Clears a stale "agent errored".
export function reopened(i: Issue): Issue {
  return { ...i, status: i.prUrl ? "pr-open" : "running", error: undefined };
}

function isIssue(v: unknown): v is Issue {
  const r = v as Partial<Issue> | null;
  return !!r && typeof r === "object"
    && typeof r.id === "string" && ISSUE_ID_RE.test(r.id)
    && typeof r.status === "string" && typeof r.text === "string"
    && typeof r.createdAt === "number"
    && Array.isArray(r.chatMessageIds) && Array.isArray(r.photos) && Array.isArray(r.repoChoices);
}

export class IssueStore {
  private chains = new Map<string, Promise<unknown>>();

  constructor(readonly dir: string, private onChange?: (issue: Issue) => void) {}

  issueDir(id: string): string {
    if (!ISSUE_ID_RE.test(id)) throw new Error(`bad issue id: ${id.slice(0, 40)}`);
    return join(this.dir, id);
  }

  async get(id: string): Promise<Issue | null> {
    if (!ISSUE_ID_RE.test(id)) return null;
    try {
      const v: unknown = JSON.parse(await readFile(join(this.issueDir(id), "issue.json"), "utf8"));
      return isIssue(v) ? v : null;
    } catch {
      return null; // missing or torn
    }
  }

  async list(): Promise<Issue[]> {
    let names: string[];
    try { names = (await readdir(this.dir)).filter((n) => ISSUE_ID_RE.test(n)); }
    catch { return []; }
    const all = await Promise.all(names.map((n) => this.get(n)));
    return all.filter((i): i is Issue => i !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async findByMessageId(messageId: number): Promise<Issue | null> {
    return (await this.list()).find((i) => i.chatMessageIds.includes(messageId)) ?? null;
  }

  create(issue: Issue): Promise<{ issue: Issue; created: boolean }> {
    return this.queue(issue.id, async () => {
      const cur = await this.get(issue.id);
      if (cur) return { issue: cur, created: false };
      await this.write(issue);
      return { issue, created: true };
    });
  }

  // Run fn after every earlier queued fn for this id has settled.
  queue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => { /* a failed step must not block the queue */ });
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return next;
  }

  // Read-modify-write WITHOUT taking the queue. Call it only from inside
  // queue(id, …); everywhere else use update().
  async mutate(id: string, fn: (cur: Issue) => Issue | null): Promise<Issue | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    const next = fn(cur);
    if (!next) return null;
    await this.write(next);
    return next;
  }

  update(id: string, fn: (cur: Issue) => Issue | null): Promise<Issue | null> {
    return this.queue(id, () => this.mutate(id, fn));
  }

  private async write(issue: Issue): Promise<void> {
    const dir = this.issueDir(issue.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.issue.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(issue, null, 2));
    await rename(tmp, join(dir, "issue.json"));
    this.onChange?.(issue);
  }
}
