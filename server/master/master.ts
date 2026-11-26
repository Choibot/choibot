// server/master/master.ts — the fleet master's lifecycle: created lazily on
// first open of the Master tab, repaired at boot only when its record exists.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../agents/git.js";
import { resumeAgent, type RecoveryCtx } from "../agents/recovery.js";
import type { AgentRecord, SessionStore } from "../agents/store.js";
import { preferredAccountIfExists } from "../agents/accounts.js";
import { homeRecordPatch, persistentHome, persistentHomeRoot, prepareHome, warnLegacyHome } from "../chief/homes.js";
import type { Env } from "../chief/paths.js";
import { FLEET_MASTER_ID, masterPaths } from "./paths.js";

export { FLEET_MASTER_ID };

// env: the deployment env (default process.env), which decides the home.
export type FleetMasterDeps = { store: SessionStore; recoveryCtx: RecoveryCtx; masterDataDir: string; env?: Env };

// Single-flight: concurrent callers (StrictMode double POST, a Telegram revive
// racing the tab) ride one in-flight run. Cleared on settle so a failure retries.
let inflight: Promise<string> | null = null;

export function ensureFleetMaster(deps: FleetMasterDeps): Promise<string> {
  if (inflight) return inflight;
  inflight = doEnsure(deps).finally(() => { inflight = null; });
  return inflight;
}

// Boot must never create the master, or deleting its record could not retire it.
export async function ensureFleetMasterAtBoot(deps: FleetMasterDeps): Promise<string | null> {
  if (!(await deps.store.load(FLEET_MASTER_ID))) return null;
  return ensureFleetMaster(deps);
}

async function doEnsure(deps: FleetMasterDeps): Promise<string> {
  // deps.env decides the home, the record patch and the warning. resumeAgent
  // (the prompt's memory dir) and runGit still read process.env; production
  // passes no env, so they agree.
  const env = deps.env ?? process.env;
  const legacy = masterPaths(deps.masterDataDir);
  // Hardened (Task 2c-7): the home in AGENT_HOME_ROOT, the legacy memory
  // copied in once. Otherwise the legacy paths, exactly as before.
  const root = persistentHomeRoot("fleet-master", env);
  const home = persistentHome("fleet-master", { env, legacy });
  const { agentDir, memoryDir } = home;
  warnLegacyHome(FLEET_MASTER_ID, env);
  // git init so the terminal's screenshot-upload path (ensureExcluded) works.
  const initRepo = async (): Promise<void> => {
    if (!existsSync(join(agentDir, ".git"))) await runGit(agentDir, ["init", agentDir], { timeout: 15000 }, agentDir);
  };
  if (root !== null) {
    if ((await prepareHome(root, home, legacy.memoryDir, initRepo)) === "copied") {
      console.log(`[master] memory copied from ${legacy.memoryDir} to ${memoryDir}`);
    }
  } else {
    await mkdir(agentDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });
    await initRepo();
  }
  let rec: AgentRecord | null = await deps.store.load(FLEET_MASTER_ID);
  if (!rec) {
    rec = {
      id: FLEET_MASTER_ID, label: "Master", kind: "fleet-master",
      repo: "", worktree: agentDir, cwd: agentDir, branch: "", baseBranch: "",
      sessionId: null, hookToken: randomUUID(), status: "idle", createdAt: Date.now(),
      ...(await preferredAccountIfExists()),
    };
    await deps.store.save(rec);
  } else {
    // resumeAgent spawns in rec.cwd: point an existing record at the home
    // (or back to the legacy one after a rollback) first.
    const patch = homeRecordPatch(rec, home, env);
    if (patch) {
      await deps.store.patch(FLEET_MASTER_ID, patch);
      rec = { ...rec, ...patch };
    }
  }
  await resumeAgent(rec, deps.recoveryCtx); // no-op when already live
  return FLEET_MASTER_ID;
}
