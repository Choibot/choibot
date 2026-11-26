// server/chief/leads/lead.ts — an area lead's lifecycle and its runtime (spec
// §13). ensureLead mirrors ensureFleetMaster (server/master/master.ts) with a
// per-area single-flight; boot only repairs leads whose record exists. Each
// lead has its own MasterInbox fed by an EventQueue of its workers' events.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preferredAccountIfExists } from "../../agents/accounts.js";
import { runGit } from "../../agents/git.js";
import { resumeAgent, type RecoveryCtx } from "../../agents/recovery.js";
import { isPersistentKind, type AgentRecord, type SessionStore } from "../../agents/store.js";
import type { TerminalManager } from "../../agents/terminal.js";
import type { EventHub } from "../../events.js";
import { typeIntoAgent, withTypingLock, type ReplyTerminals } from "../../issues/reply.js";
import type { IssueStore } from "../../issues/store.js";
import { InputTracker } from "../../master/draft.js";
import { EventQueue } from "../../master/events.js";
import { MasterInbox } from "../../master/inbox.js";
import { homeRecordPatch, persistentHome, persistentHomeRoot, prepareHome, warnLegacyHome } from "../homes.js";
import type { Env } from "../paths.js";
import { AREA_RE, leadId, type AreaStore } from "./areas.js";
import { leadLegacyHome } from "./prompt.js";

export { leadId };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type LeadDeps = {
  store: SessionStore;
  recoveryCtx: RecoveryCtx;
  // The chief data dir: charter.md and report.md stay in <chiefDir>/leads/<area>/.
  chiefDir: string;
  areas: AreaStore;
  terminals: Pick<TerminalManager, "has" | "hasSession">;
  // Holds the lead's inbox busy before a cold spawn (LeadRuntimes.markStarting).
  markStarting: (leadId: string) => void;
  // The deployment env (default process.env), which decides the home.
  env?: Env;
};

type Outcome = Awaited<ReturnType<typeof resumeAgent>>;

// Per area: concurrent callers ride one in-flight run, cleared on settle so a failure retries.
const inflight = new Map<string, Promise<Outcome>>();

function runEnsure(d: LeadDeps, area: string): Promise<Outcome> {
  const cur = inflight.get(area);
  if (cur) return cur;
  const p: Promise<Outcome> = doEnsure(d, area).finally(() => { if (inflight.get(area) === p) inflight.delete(area); });
  inflight.set(area, p);
  return p;
}

export async function ensureLead(d: LeadDeps, area: string): Promise<string> {
  await runEnsure(d, area);
  return leadId(area);
}

// The areas.json entries with a lead id whose lead record exists.
async function recordedLeads(d: Pick<LeadDeps, "areas" | "store">): Promise<Array<{ area: string; id: string; rec: AgentRecord }>> {
  const out: Array<{ area: string; id: string; rec: AgentRecord }> = [];
  for (const [area, e] of Object.entries(await d.areas.read())) {
    if (e.leadId === undefined) continue;
    const rec = await d.store.load(e.leadId);
    if (rec?.kind === "lead") out.push({ area, id: e.leadId, rec });
  }
  return out;
}

// Boot never creates a lead, or deleting its record could not retire it. It
// resumes every lead with a record whatever its status (reconcileAgents skips
// "done"), one failure never stopping the others. Returns the ids it spawned
// (resumed or cold), for the Deliverer's boot scan.
export async function ensureLeadsAtBoot(d: LeadDeps): Promise<string[]> {
  const out: string[] = [];
  for (const { area, id } of await recordedLeads(d)) {
    try {
      const outcome = await runEnsure(d, area);
      if (outcome === "resumed" || outcome === "cold") out.push(id);
    } catch (e) {
      console.warn(`[chief] ${id} boot repair failed: ${errText(e)}`);
    }
  }
  return out;
}

// One runtime per lead with a record, before anything can emit: a dead lead
// (no Term, no dtach session) or a running one starts busy, as the master's
// inbox does. Returns those lead ids.
export async function ensureLeadRuntimes(d: Pick<LeadDeps, "areas" | "store" | "terminals"> & {
  runtimes: Pick<LeadRuntimes, "ensure">;
}): Promise<string[]> {
  const ids: string[] = [];
  for (const { id, rec } of await recordedLeads(d)) {
    const starting = (!d.terminals.has(id) && !(await d.terminals.hasSession(id))) || rec.status === "running";
    d.runtimes.ensure(id, { starting, recordExists: true });
    ids.push(id);
  }
  return ids;
}

// The lead boot step (runChiefPreReconcile's leadBoot): the runtimes, then the repair.
export async function bootLeads(d: LeadDeps & { runtimes: Pick<LeadRuntimes, "ensure"> }): Promise<string[]> {
  await ensureLeadRuntimes(d);
  return ensureLeadsAtBoot(d);
}

async function doEnsure(d: LeadDeps, area: string): Promise<Outcome> {
  if (!AREA_RE.test(area)) throw new Error(`bad area name: ${JSON.stringify(area)}`);
  // d.env decides the home, the record patch and the warning; resumeAgent and
  // runGit read process.env (production passes no env, so they agree).
  const env = d.env ?? process.env;
  const id = leadId(area);
  const consoleDir = join(d.chiefDir, "leads", area);
  const legacy = leadLegacyHome(d.chiefDir, area);
  // Hardened (Task 2c-7): the home in AGENT_HOME_ROOT, the legacy memory
  // copied in once. Otherwise the legacy paths in the chief data dir.
  const root = persistentHomeRoot("lead", env);
  const home = persistentHome("lead", { env, area, legacy });
  const { agentDir, memoryDir } = home;
  warnLegacyHome(id, env);
  const initRepo = async (): Promise<void> => {
    if (!existsSync(join(agentDir, ".git"))) await runGit(agentDir, ["init", agentDir], { timeout: 15000 }, agentDir);
  };
  if (root !== null) {
    if ((await prepareHome(root, home, legacy.memoryDir, initRepo)) === "copied") {
      console.log(`[${id}] memory copied from ${legacy.memoryDir} to ${memoryDir}`);
    }
  } else {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(memoryDir, { recursive: true, mode: 0o700 });
    await initRepo();
  }
  // Console-side (decision 41): in the legacy layout the home's parent; hardened, made here.
  await mkdir(consoleDir, { recursive: true, mode: 0o700 });
  const entry = (await d.areas.read())[area];
  const repos = entry?.repos ?? [];
  await writeCharter(join(consoleDir, "charter.md"), area, repos);
  let rec: AgentRecord | null = await d.store.load(id);
  if (!rec) {
    // Never spawnedBy: the master would then drop the lead's own lead-errored line.
    rec = {
      id, label: `Lead · ${area}`, kind: "lead", area,
      repo: "", worktree: agentDir, cwd: agentDir, branch: "", baseBranch: "",
      sessionId: null, hookToken: randomUUID(), status: "idle", createdAt: Date.now(),
      ...(await preferredAccountIfExists()),
    };
    await d.store.save(rec);
  } else {
    // resumeAgent spawns in rec.cwd: point an existing record at the home first.
    const patch = homeRecordPatch(rec, home, env);
    if (patch) {
      await d.store.patch(id, patch);
      rec = { ...rec, ...patch };
    }
  }
  if (entry?.leadId !== id) await d.areas.set(area, { repos, leadId: id });
  // A cold spawn: the TUI takes no paste before its SessionStart (as ensureFleet).
  if (!d.terminals.has(id) && !(await d.terminals.hasSession(id))) d.markStarting(id);
  return resumeAgent(rec, d.recoveryCtx); // "alive" (a no-op) when already live
}

// One line naming the area and its repos; an existing charter is the user's.
async function writeCharter(path: string, area: string, repos: string[]): Promise<void> {
  const line = `Area ${area} covers the repos: ${repos.length ? repos.join(", ") : "none yet"}.\n`;
  try {
    await writeFile(path, line, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

// ---- runtimes ----------------------------------------------------------------

export type LeadRuntimeDeps = {
  hub: Pick<EventHub, "subscribe">;
  agents: Pick<SessionStore, "load">;
  issues: Pick<IssueStore, "list">;
  acted: { recent(id: string): boolean };
  terminals: ReplyTerminals;
  areas: Pick<AreaStore, "isLiveLead">;
};

export type LeadRuntime = {
  inbox: MasterInbox;
  events: EventQueue;
  // The synchronous cached flag the inbox's tick reads (never an await).
  ready(): boolean;
  // The caller has just loaded or created the lead's record.
  markExists(): void;
  stop(): void;
};

const isLeadId = (id: string): boolean => id.startsWith("lead-") && AREA_RE.test(id.slice("lead-".length));

// The master queue's accept (spec §13): it drops the events of a live lead's
// workers, which that lead's queue takes. An areas.json that cannot be read
// sends them to the master, with one log line.
export function masterAccept(
  areas: Pick<AreaStore, "isLiveLead">, log: (s: string) => void = (s) => console.warn(s),
): (rec: AgentRecord) => Promise<boolean> {
  return async (rec) => {
    if (!rec.spawnedBy) return true;
    try {
      return !(await areas.isLiveLead(rec.spawnedBy));
    } catch (e) {
      log(`[chief] areas.json not read (${errText(e)}); ${rec.id}'s events go to the master`);
      return true;
    }
  };
}

// A lead's queue takes its own workers' events while it is a live lead, so each
// event lands in exactly one of the two digests (the master takes the rest).
export function startLeadRuntime(d: LeadRuntimeDeps & { leadId: string; starting?: boolean; recordExists?: boolean }): LeadRuntime {
  const id = d.leadId;
  let exists = d.recordExists === true;
  const events = new EventQueue({
    hub: d.hub, agents: d.agents, issues: d.issues, acted: d.acted,
    accept: async (rec) => {
      if (rec.spawnedBy !== id || isPersistentKind(rec.kind)) return false;
      try { return await d.areas.isLiveLead(id); } catch { return false; }
    },
  });
  const inbox: MasterInbox = new MasterInbox({
    hub: d.hub, events, tracker: new InputTracker(), agentId: id,
    // Under the PTY's typing lock, the block re-checked inside it (as the master's).
    send: (text): Promise<boolean> => withTypingLock(id, async (): Promise<boolean> =>
      (inbox.blockedBy() ? false : typeIntoAgent(d.terminals, id, text))),
    ready: () => exists,
  });
  const unsubReady = d.hub.subscribe((e) => {
    if ((e.type === "agent-status" || e.type === "agent-hook") && e.agentId === id) {
      exists = !(e.type === "agent-status" && e.status === "done");
    }
  });
  inbox.start(d.starting ? "busy" : "idle");
  let stopped = false;
  let stopEvents: (() => void) | undefined;
  void events.start().then(
    (unsub) => { if (stopped) unsub(); else stopEvents = unsub; },
    (e) => console.warn(`[${id}] event queue start failed: ${errText(e)}`),
  );
  return {
    inbox, events,
    ready: () => exists,
    markExists: () => { exists = true; },
    stop: () => {
      stopped = true;
      inbox.stop();
      unsubReady();
      stopEvents?.();
    },
  };
}

// The leads' runtimes by lead id; also the master queue's LeadDigests registry
// (index.ts passes {get: (id) => runtimes.get(id)?.events}).
export class LeadRuntimes {
  private readonly runtimes = new Map<string, LeadRuntime>();

  constructor(private readonly d: LeadRuntimeDeps) {}

  // Idempotent: one runtime per lead id. A new one starts busy when `starting`;
  // an existing one is never marked starting here (ensureLead does it before a
  // cold spawn), so a live lead's inbox stays open.
  ensure(leadId: string, o: { starting: boolean; recordExists: boolean }): LeadRuntime {
    if (!isLeadId(leadId)) throw new Error(`not a lead id: ${JSON.stringify(leadId)}`);
    const cur = this.runtimes.get(leadId);
    if (cur) {
      if (o.recordExists) cur.markExists();
      return cur;
    }
    const rt = startLeadRuntime({ ...this.d, leadId, starting: o.starting, recordExists: o.recordExists });
    this.runtimes.set(leadId, rt);
    return rt;
  }

  get(leadId: string): LeadRuntime | undefined {
    return this.runtimes.get(leadId);
  }

  markStarting(leadId: string): void {
    this.runtimes.get(leadId)?.inbox.markStarting();
  }

  onWebInput(agentId: string, data: string): void {
    this.runtimes.get(agentId)?.inbox.onWebInput(agentId, data);
  }

  stopAll(): void {
    for (const rt of this.runtimes.values()) rt.stop();
    this.runtimes.clear();
  }
}

// The chief relaunch ctx's onRelaunch (spec §5.2): a relaunched persistent
// agent's inbox holds busy until its SessionStart. The cron master has none.
export function holdOnRelaunch(d: {
  fleet: { markStarting(): void }; leads?: Pick<LeadRuntimes, "markStarting">;
  // The Coordinator's inbox (server/coordinator/feed.ts): an active core only.
  coordinator?: { markStarting(): void };
}): (rec: AgentRecord) => void {
  return (rec) => {
    if (rec.kind === "fleet-master") d.fleet.markStarting();
    else if (rec.kind === "coordinator") d.coordinator?.markStarting();
    else if (rec.kind === "lead") d.leads?.markStarting(rec.id);
  };
}
