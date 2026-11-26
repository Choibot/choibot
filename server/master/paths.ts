// server/master/paths.ts — where the fleet master lives. It imports only the leaf
// server/defaults.ts, so every master module (and recovery.ts) can import it.
import { join } from "node:path";
import { resolveAppDataDir } from "../defaults.js";

export const FLEET_MASTER_ID = "fleet-master";

// Same resolution order as resolveCronDataDir (bin/lib/cronspec.ts).
export function resolveMasterDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.MASTER_DATA_DIR) return env.MASTER_DATA_DIR;
  return join(resolveAppDataDir(env), "master");
}

// The legacy (not hardened) home: the agent cwd, its memory and the photo
// inbox. A hardened deployment moves all three into AGENT_HOME_ROOT
// (server/chief/homes.ts persistentHome).
export function masterPaths(dataDir: string): { agentDir: string; memoryDir: string; inboxDir: string } {
  return { agentDir: join(dataDir, "agent"), memoryDir: join(dataDir, "memory"), inboxDir: join(dataDir, "inbox") };
}
