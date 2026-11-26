// server/agents/loginhold.ts — the persistent agents (the fleet master, a lead, the Coordinator)
// that a "Sign out" stopped (agents/api.ts), and the login they wait for. Their Claude ended with
// the login, and no start of theirs may run a Claude on that login while it is not signed in
// again: it would only show Claude's login screen, and a message to it would be lost.
// - resumeAgent (agents/recovery.ts), the one path that starts them (boot, an ensure, a relaunch
//   and its retry, a move), asks mayStart first. A held agent whose login is still not signed in
//   WAITS: no session, no error, one log line. One that the user moved to another login since is
//   no longer held.
// - When a login is signed in from the page, the console starts what it held (the starts of
//   chief/chiefwait.ts: startWaited): on the login that is back, or (basic protection) on a login
//   that works, where resumeAgent moves a persistent agent of a signed-out login (accounts.ts
//   loginInPlaceOf). A sign-in from a terminal: at the next start of each, as mayStart sees it.
// The second sign-in of strong protection has its own wait (chief/chiefwait.ts), not this one.
// Kept in a small file of the console's data dir, so a restart keeps the hold.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isAgentId } from "../widgets/paths.js";
import { DEFAULT_ACCOUNT, isAccountId, isDefaultAccount } from "./accounts.js";

export type LoginHoldDeps = {
  file: string;
  // Can an agent of `login` start now: the login is signed in again (its credentials file, or
  // Claude Code's status through the helper), or another login works that it moves to.
  canStart: (login: string) => Promise<boolean>;
  log?: (s: string) => void;
};

const keyOf = (account: string | undefined | null): string => (account && !isDefaultAccount(account) ? account : DEFAULT_ACCOUNT);

export class LoginHold {
  private held = new Map<string, string>();
  private logged = new Set<string>();
  constructor(private d: LoginHoldDeps) {}

  // Read the file when the console starts. No file, or a file that is not valid: nothing held.
  async load(): Promise<void> {
    this.held = new Map();
    try {
      const raw = JSON.parse(await readFile(this.d.file, "utf8")) as Record<string, unknown>;
      for (const [id, login] of Object.entries(raw)) if (isAgentId(id) && isAccountId(login)) this.held.set(id, login);
    } catch { /* nothing held */ }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.d.file), { recursive: true });
    await writeFile(`${this.d.file}.tmp`, JSON.stringify(Object.fromEntries(this.held)), { mode: 0o600 });
    await rename(`${this.d.file}.tmp`, this.d.file);
  }

  // The sign-out of `login` stopped these agents.
  async hold(ids: string[], login: string): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) { this.held.set(id, keyOf(login)); this.logged.delete(id); }
    await this.save().catch((e: unknown) => this.log(`[accounts] the hold of ${ids.join(", ")} was not saved: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Whether `rec` may start now. False: it waits for its login, and nothing starts.
  async mayStart(rec: { id: string; account?: string }): Promise<boolean> {
    const login = this.held.get(rec.id);
    if (login === undefined) return true;
    // Moved to another login since the sign-out: that login decides.
    if (keyOf(rec.account) !== login || (await this.d.canStart(login).catch(() => false))) {
      await this.release([rec.id]);
      return true;
    }
    if (!this.logged.has(rec.id)) {
      this.logged.add(rec.id);
      this.log(`[accounts] ${rec.id} waits: its Claude login ${login} was signed out on the page; it starts when a login is signed in`);
    }
    return false;
  }

  waitsFor(id: string): boolean {
    return this.held.has(id);
  }

  // A login was signed in: each held id (sorted), and its hold ends. The caller starts them.
  async releaseAll(): Promise<string[]> {
    const ids = [...this.held.keys()].sort();
    await this.release(ids);
    return ids;
  }

  // The hold of these ids ends (a sign-out that did not end them, or did not happen).
  async release(ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) changed = this.held.delete(id) || changed;
    if (changed) await this.save().catch(() => {});
  }

  private log(s: string): void {
    (this.d.log ?? ((x: string) => console.warn(x)))(s);
  }
}
