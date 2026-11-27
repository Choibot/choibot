// server/update/service.ts — the person's Update button on a hosted console (design H5): the
// console's own `deploy` ticket in its release variant, in place of the git Deploy, on a release
// or an archive install where root's updater is there (server/update/status.ts).
//
// The check (every CHECK_MS, and at boot): root's status file says which release it offers
// (`available`). While that release is newer than the version that runs (the console's OWN
// release record, server/release.ts; never the status file), the console keeps ONE open ticket
// "ChoiBot <version> is ready" with the release's notes. No ticket comes again for a version that
// the user withdrew, or that failed on this server (root marks it bad and offers it no more).
//
// The press (start): USER only (the route's gateUser, or the user's own Telegram account). It
// takes no input: it only makes the empty ask file. Root's unit takes it, removes it, and runs the
// update; it stops and starts this console. The ticket shows the states from root's status file:
// asked, running, then the end. At the boot after the update, `updated` with root's `installed`
// equal to this console's own version closes the ticket as updated. failed-back and
// failed-stuck close it as update-failed (shown, as a deployed ticket, for an hour). A refusal
// before any change leaves it open with its line, and the same release can be asked again.
import type { QueueStore } from "../chief/queue/store.js";
import type { QueueItem } from "../chief/queue/types.js";
import {
  CONSOLE_AGENT_ID, DEPLOY_CLOSED, DEPLOY_REPO, NOTES_SHOWN, plainNote, updateBody, updateTitle,
  type DeployInfo, type ReleaseOffer, type UpdateRun,
} from "../chief/deploy/ticket.js";
import type { DeployStatus, StartResult } from "../chief/deploy/service.js";
import type { VersionInfo } from "../release.js";
import { askPending, makeAsk, readUpdateStatus, type UpdatePaths, type UpdateStatus } from "./status.js";

export const CHECK_MS = 60_000;
// After this long with the ask file still there, root did not take the press.
export const ASK_WAIT_MS = 3 * 60_000;
// While a press is under way the check runs this often.
export const BUSY_MS = 2_000;
// The longest run of root's updater, from the press to its last status: under 55 minutes
// (release-format.md §10: the tar's 1800 s, the index and the signature, the stop, the start, the
// health check, the way back). A press still under way after this, with the ask file gone, did not
// finish.
export const RUN_MAX_MS = 60 * 60_000;
// Root's runs that answer a press: its --ask run, and the repair of an --ask run that a power cut
// ended. A daily check (mode "check") and ops' push ("local") never end a press.
const PRESS_MODES = new Set(["ask", "repair"]);

export type UpdateDeps = {
  store: QueueStore;
  paths: UpdatePaths;
  // The version that runs: the console's own release record, read once at boot.
  running: Pick<VersionInfo, "version" | "commit">;
  now?: () => number;
  log?: (s: string) => void;
  read?: (p: UpdatePaths) => ReturnType<typeof readUpdateStatus>;
  ask?: (path: string) => ReturnType<typeof makeAsk>;
  pending?: (path: string) => boolean;
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isLive = (i: QueueItem): boolean => i.status === "open" || i.status === "snoozed";
const isUpdateTicket = (i: QueueItem): boolean => i.kind === "deploy" && i.deploy?.release !== undefined;
const ENDED = new Set<UpdateRun["state"]>(["updated", "failed-back", "failed-stuck"]);
// A press under way: no button, the fast check runs.
export const PRESSED = new Set<UpdateRun["state"]>(["asked", "running"]);
const timeOf = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

// ---- the table: root's result and the press's state give the next state ----

export type Next =
  | { t: "keep" }
  | { t: "set"; run: UpdateRun }
  | { t: "close"; why: typeof DEPLOY_CLOSED.updated | typeof DEPLOY_CLOSED.updateFailed; run: UpdateRun };
export type NextCtx = {
  now: number;
  // The version that runs: the console's own release record.
  running: number;
  // The ask file is still there (root did not take it).
  pending: boolean;
};

const assertNever = (x: never): never => { throw new Error(`no rule for ${String(x)}`); };

// One step of a press that is not at its end (every state but updated, failed-back, failed-stuck).
// First the fact that needs no table: the update ended well (this console runs a newer version than
// at the press, at least the ticket's, and root's installed is that version). Then: is this status
// the answer of root's run to THIS press? Not by a later second (`at` is whole seconds, and root can
// answer inside the press's own second), but by what root did:
//   - "running": the console saw this run start, so any other result from the press's second on
//     is its end;
//   - "asked" or "not-started": root took the ask (the file is gone) and the result is of its press
//     run (mode "ask", or "repair" of a cut one) from the press's second on. A daily check's result
//     ("check": it writes nothing while a run works) is never an answer;
//   - the other ends (refused, unreachable, not-finished): no later run answers this press.
// Then each result of root's fixed list: a switch with no default, so a new result word does not
// compile until it has its rule. Last the two guards of a press under way: the ask that root never
// took, and the run that never ended.
export function nextRun(u: UpdateRun, s: UpdateStatus, c: NextCtx): Next {
  const at = timeOf(s.at);
  const ofPress = at >= Math.floor(u.askedAt / 1000) * 1000;
  const pressRun = s.mode !== null && s.mode !== undefined && PRESS_MODES.has(s.mode);
  const fresh = !ofPress ? false
    : u.state === "running" ? s.result !== "running" || pressRun
    : u.state === "asked" || u.state === "not-started" ? !c.pending && pressRun
    : false;
  const tried = s.tried?.version;
  const ofThis = tried === undefined || tried === null || tried >= u.to;
  const failed = s.result === "failed-back" || s.result === "failed-stuck";
  const endedWell = c.running >= u.to && c.running > u.from && s.installed?.version === c.running && s.result !== "running" && !failed;
  if (endedWell) return { t: "close", why: DEPLOY_CLOSED.updated, run: { ...u, state: "updated", to: c.running, endedAt: c.now } };
  const set = (state: UpdateRun["state"], step?: string | null): Next => (state === u.state && (step ?? undefined) === u.step
    ? { t: "keep" }
    : { t: "set", run: { ...u, state, ...(step ? { step } : {}), ...(PRESSED.has(state) ? {} : { endedAt: c.now }) } });
  let next: Next = { t: "keep" };
  if (fresh) {
    switch (s.result) {
      // Root runs it ("running" with tried null: it has not read the index yet).
      case "running": next = ofThis ? set("running", s.step) : { t: "keep" }; break;
      // A failure of this release or a newer one ends the ticket.
      case "failed-back":
      case "failed-stuck":
        next = ofThis ? { t: "close", why: DEPLOY_CLOSED.updateFailed, run: { ...u, state: s.result, ...(s.step ? { step: s.step } : {}), endedAt: c.now } } : { t: "keep" };
        break;
      // Root updated, and this console does not run that version yet: the restart comes.
      case "updated": next = { t: "keep" }; break;
      case "refused": next = set("refused", s.step); break;
      case "unreachable": next = set("unreachable"); break;
      // Root ended with no update: nothing to install, no run, or a cut run that it repaired.
      case "none":
      case "current":
      case "available":
      case "repaired": next = set("not-finished"); break;
      default: return assertNever(s.result);
    }
  }
  if (next.t !== "keep" || !PRESSED.has(u.state)) return next;
  if (u.state === "asked" && c.pending && c.now - u.askedAt > ASK_WAIT_MS) return set("not-started");
  if (!c.pending && c.now - u.askedAt > RUN_MAX_MS) return set("not-finished");
  return next;
}

export class UpdateService {
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly runningVersion: number;
  private checking: Promise<void> | null = null;
  private busyTimer?: NodeJS.Timeout;
  private lastProblem = "";
  private status: UpdateStatus | null = null;
  // What the last read found: none yet, no file (no updater, or root's first check is still to
  // come), a file that is refused, or a status.
  private found: "none" | "missing" | "problem" | "status" = "none";

  constructor(private readonly d: UpdateDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? ((s) => console.warn(s));
    this.runningVersion = d.running.version ?? 0;
  }

  // ---- reads ----

  private read(): UpdateStatus | null {
    const r = (this.d.read ?? ((p) => readUpdateStatus(p.status, !p.test)))(this.d.paths);
    if ("status" in r) {
      if (this.found !== "status") this.log("[update] on: root's status file is read");
      this.found = "status";
      this.lastProblem = "";
      return r.status;
    }
    this.found = "problem" in r ? "problem" : "missing";
    if ("problem" in r && r.problem !== this.lastProblem) {
      this.lastProblem = r.problem;
      this.log(`[update] ${r.problem}`);
    }
    return null;
  }

  private pending(): boolean {
    return (this.d.pending ?? askPending)(this.d.paths.ask);
  }

  private async tickets(): Promise<QueueItem[]> {
    return (await this.d.store.list()).filter(isUpdateTicket);
  }

  // What Settings shows: the version that runs, root's last check, the last result.
  view(): { on: boolean; running: number; checkedAt: string | null; result: string | null; tried: number | null; installed: number | null; step: string | null } {
    const s = this.status;
    return {
      on: s !== null, running: this.runningVersion, checkedAt: s?.checkedAt ?? null, result: s?.result ?? null,
      tried: s?.tried?.version ?? null, installed: s?.installed?.version ?? null, step: s?.step ?? null,
    };
  }

  async statusNow(): Promise<DeployStatus & { update: ReturnType<UpdateService["view"]>; press: UpdateRun | null }> {
    await this.check();
    const all = await this.tickets();
    const ticket = all.find(isLive);
    const run = ticket?.deploy?.update;
    // The last press, also when its ticket closed (the page follows it through the restart; the
    // Queue shows the same run on the ticket).
    const press = all.reduce<UpdateRun | null>((a, i) => { const u = i.deploy?.update; return u && (!a || u.askedAt > a.askedAt) ? u : a; }, null);
    return {
      armed: true, unit: "", branch: "release", remote: "", live: this.d.running.commit ?? null,
      target: ticket?.deploy?.release?.commit ?? null, count: 0, ticketId: ticket?.id ?? null,
      run: run ? { id: `u${run.askedAt}`, phase: ENDED.has(run.state) ? "done" : "running", step: "restart" } : null,
      update: this.view(), press,
    };
  }

  // ---- the check ----

  check(): Promise<void> {
    return this.checking ??= this.runCheck().finally(() => { this.checking = null; });
  }

  private async runCheck(): Promise<void> {
    const s = this.read();
    this.status = s;
    if (!s) return;
    const all = await this.d.store.list();
    const open = all.filter((i) => isUpdateTicket(i) && isLive(i));
    for (const extra of open.slice(1)) await this.close(extra.id, "duplicate");
    const cur = open[0];
    if (cur?.deploy?.update && !ENDED.has(cur.deploy.update.state)) {
      const done = await this.follow(cur, s);
      if (done) return;
    }
    // The ticket as follow() left it.
    const ticket = cur ? await this.d.store.get(cur.id) : null;
    const u = ticket && isLive(ticket) ? ticket.deploy?.update : undefined;
    const pressed = u !== undefined && PRESSED.has(u.state);
    if (!pressed) this.stopBusy();
    const offer = this.offerOf(s);
    if (!offer) {
      // Nothing newer on offer and no press under way: the ticket has nothing left to do.
      if (ticket && isLive(ticket) && !pressed) await this.close(ticket.id, DEPLOY_CLOSED.live);
      return;
    }
    if (!ticket || !isLive(ticket)) {
      // No new ticket for a version that the user withdrew or that failed here.
      const last = all.filter(isUpdateTicket).filter((i) => i.deploy?.release?.version === offer.version).at(-1);
      if (last && (last.lastError === undefined || last.lastError === DEPLOY_CLOSED.updateFailed)) return;
      await this.d.store.add({
        kind: "deploy", agentId: CONSOLE_AGENT_ID, createdBy: { agentId: CONSOLE_AGENT_ID, kind: "console" },
        repo: DEPLOY_REPO, area: DEPLOY_REPO, title: updateTitle(offer.version), body: updateBody(offer), blocking: false, deploy: this.info(offer),
      });
      this.log(`[update] version ${offer.version} is offered (running ${this.runningVersion})`);
      return;
    }
    // With no press under way: the ticket shows the release on offer and today's words (a newer
    // release, or a console of a new version with other words). The line of the last press stays
    // for the same release; a newer release starts with none.
    const title = updateTitle(offer.version), body = updateBody(offer);
    const same = ticket.deploy?.release?.version === offer.version;
    if (!pressed && (!same || ticket.title !== title || ticket.body !== body)) {
      await this.write(ticket.id, (item) => ({ ...item, title, body, deploy: { ...this.info(offer), ...(same && u ? { update: u } : {}) } }));
    }
  }

  // The release on offer: root's `available`, newer than the version that runs.
  private offerOf(s: UpdateStatus): ReleaseOffer | null {
    const a = s.available;
    if (!a || a.version <= this.runningVersion) return null;
    const notes = a.notes.map(plainNote).filter((n) => n !== "");
    return {
      version: a.version, commit: a.commit, builtAt: a.builtAt, security: a.security,
      notes: notes.slice(0, NOTES_SHOWN), more: Math.max(0, notes.length - NOTES_SHOWN),
      running: { version: this.runningVersion, commit: this.d.running.commit ?? null },
    };
  }

  private info(r: ReleaseOffer): DeployInfo {
    return { live: r.running.commit ?? "", target: r.commit, count: 0, prs: [], more: 0, release: r };
  }

  // A press that is not at its end, one step of the table (nextRun). Returns true when it ended.
  private async follow(item: QueueItem, s: UpdateStatus): Promise<boolean> {
    const u = item.deploy!.update!;
    const next = nextRun(u, s, { now: this.now(), running: this.runningVersion, pending: this.pending() });
    if (next.t === "keep") return false;
    if (next.t === "close") {
      await this.close(item.id, next.why, next.run);
      this.log(next.why === DEPLOY_CLOSED.updated
        ? `[update] updated to version ${next.run.to} (from ${u.from})`
        : `[update] the update to version ${u.to} failed at ${next.run.step ?? "?"} (${next.run.state})`);
      return true;
    }
    await this.write(item.id, (i) => ({ ...i, deploy: { ...i.deploy!, update: next.run } }));
    if (!PRESSED.has(next.run.state)) {
      this.stopBusy();
      this.log(`[update] the press of version ${u.to} ended with no update: ${next.run.state}${next.run.step ? ` at ${next.run.step}` : ""}`);
    }
    return false;
  }

  // ---- the press ----

  async start(via: "tab" | "telegram"): Promise<StartResult> {
    await this.check();
    if (this.found === "missing") return { code: 503, error: "this install has no updater: it cannot update itself" };
    if (this.found === "problem") return { code: 503, error: `the updater's status cannot be read: ${this.lastProblem}` };
    const ticket = (await this.tickets()).find(isLive);
    if (!ticket?.deploy?.release) return { code: 409, error: "no release is offered: this console runs the newest" };
    const u = ticket.deploy.update;
    if (u && (u.state === "asked" || u.state === "running")) return { code: 409, error: "an update already runs", item: ticket };
    const r = (this.d.ask ?? makeAsk)(this.d.paths.ask);
    if (!r.ok) return { code: 503, error: `the update could not be asked: ${r.why}`, item: ticket };
    const run: UpdateRun = { state: "asked", via, askedAt: this.now(), from: this.runningVersion, to: ticket.deploy.release.version };
    const item = await this.write(ticket.id, (i) => {
      const { snoozedUntil: _woken, ...rest } = i;
      return { ...rest, status: "open", deploy: { ...i.deploy!, update: run } };
    });
    this.log(`[update] asked: version ${run.to} (from ${via}${r.already ? ", the ask was there already" : ""})`);
    this.startBusy();
    return item ? { code: 200, item } : { code: 409, error: "the ticket is gone" };
  }

  async startFromCard(itemId: string): Promise<StartResult> {
    const ticket = (await this.tickets()).find(isLive);
    if (!ticket || ticket.id !== itemId) return { code: 409, error: "this is not the open update ticket" };
    return this.start("telegram");
  }

  // ---- the store ----

  private async write(id: string, f: (i: QueueItem) => QueueItem): Promise<QueueItem | null> {
    const { store } = this.d;
    return store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isLive(item) || !isUpdateTicket(item)) return null;
      const next = f(item);
      await store.write(next);
      return next;
    });
  }

  private async close(id: string, why: string, update?: UpdateRun): Promise<void> {
    const { store } = this.d;
    await store.withItem(id, async () => {
      const item = await store.get(id);
      if (!item || !isLive(item)) return;
      const { snoozedUntil: _ended, ...rest } = item;
      const deploy = item.deploy && update ? { ...item.deploy, update } : item.deploy;
      await store.write({ ...rest, status: "withdrawn", lastError: why, closedAt: this.now(), ...(deploy ? { deploy } : {}) });
    });
    this.stopBusy();
  }

  // ---- timers ----

  private startBusy(): void {
    if (this.busyTimer) return;
    this.busyTimer = setInterval(() => { void this.check().catch((e) => this.log(`[update] check failed: ${errText(e)}`)); }, BUSY_MS);
    this.busyTimer.unref?.();
  }

  // The fast check of a press under way runs (for the tests: it stops in every other state).
  get busy(): boolean { return this.busyTimer !== undefined; }

  private stopBusy(): void {
    if (this.busyTimer) clearInterval(this.busyTimer);
    this.busyTimer = undefined;
  }

  // At boot (after reconcile): the end of an update that restarted this console, then the check.
  async afterBoot(): Promise<void> {
    try {
      await this.check();
      const live = (await this.tickets()).find(isLive)?.deploy?.update;
      if (live && (live.state === "asked" || live.state === "running")) this.startBusy();
    } catch (e) {
      this.log(`[update] boot step failed: ${errText(e)}`);
    }
  }

  startWatch(): () => void {
    const timer = setInterval(() => { void this.check().catch((e) => this.log(`[update] check failed: ${errText(e)}`)); }, CHECK_MS);
    timer.unref?.();
    return () => { clearInterval(timer); this.stopBusy(); };
  }
}
