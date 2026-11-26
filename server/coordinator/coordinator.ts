// server/coordinator/coordinator.ts — the Coordinator's lifecycle. It mirrors the fleet
// master's (master/master.ts) with one difference: the console makes it by itself (the first
// time the Master starts or an event waits), because it has no tab that could make it.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { preferredAccountIfExists } from "../agents/accounts.js";
import { runGit } from "../agents/git.js";
import { resumeAgent, type RecoveryCtx } from "../agents/recovery.js";
import type { AgentRecord, SessionStore } from "../agents/store.js";
import { homeRecordPatch, persistentHome, persistentHomeRoot, prepareHome, warnLegacyHome } from "../chief/homes.js";
import type { Env } from "../chief/paths.js";
import { COORDINATOR_ID, COORDINATOR_KIND, coordinatorPaths } from "./paths.js";

export { COORDINATOR_ID };

export type CoordinatorDeps = {
  store: SessionStore; recoveryCtx: RecoveryCtx; dataDir: string;
  // Holds the Coordinator's inbox busy before a cold spawn (its TUI takes no paste before its
  // SessionStart).
  markStarting: () => void;
  isLive: () => Promise<boolean>;
  env?: Env;
};

// Single-flight, as ensureFleetMaster: cleared on settle so a failure retries.
let inflight: Promise<string> | null = null;

export function ensureCoordinator(d: CoordinatorDeps): Promise<string> {
  if (inflight) return inflight;
  inflight = doEnsure(d).finally(() => { inflight = null; });
  return inflight;
}

async function doEnsure(d: CoordinatorDeps): Promise<string> {
  const env = d.env ?? process.env;
  const legacy = coordinatorPaths(d.dataDir);
  const root = persistentHomeRoot("coordinator", env);
  const home = persistentHome("coordinator", { env, legacy });
  const { agentDir, memoryDir } = home;
  warnLegacyHome(COORDINATOR_ID, env);
  const initRepo = async (): Promise<void> => {
    if (!existsSync(join(agentDir, ".git"))) await runGit(agentDir, ["init", agentDir], { timeout: 15000 }, agentDir);
  };
  if (root !== null) {
    await prepareHome(root, home, legacy.memoryDir, initRepo);
  } else {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    await mkdir(memoryDir, { recursive: true, mode: 0o700 });
    await initRepo();
  }
  let rec: AgentRecord | null = await d.store.load(COORDINATOR_ID);
  if (!rec) {
    // Never spawnedBy: it is the console's own agent, in no lead's area.
    rec = {
      id: COORDINATOR_ID, label: "Coordinator", kind: COORDINATOR_KIND,
      repo: "", worktree: agentDir, cwd: agentDir, branch: "", baseBranch: "",
      sessionId: null, hookToken: randomUUID(), status: "idle", createdAt: Date.now(),
      ...(await preferredAccountIfExists()),
    };
    await d.store.save(rec);
  } else {
    const patch = homeRecordPatch(rec, home, env);
    if (patch) {
      await d.store.patch(COORDINATOR_ID, patch);
      rec = { ...rec, ...patch };
    }
  }
  if (!(await d.isLive())) d.markStarting();
  await resumeAgent(rec, d.recoveryCtx); // no-op when already live
  return COORDINATOR_ID;
}
