// server/coordinator/paths.ts — the Coordinator: the console's hidden background agent (user
// pick A of 2026-11-20, "split the fleet master in 2"). It takes what the console feeds: the
// event digests, every cron run and the lead reports that carry a decision or a problem. The
// Master (server/master) is the user's chat and gets none of it. A leaf module (defaults.ts
// only), as master/paths.ts: recovery.ts and the CLI import it.
import { join } from "node:path";
import { resolveAppDataDir } from "../defaults.js";

export const COORDINATOR_ID = "coordinator";
export const COORDINATOR_KIND = "coordinator";

// The model of the Coordinator: the ONE line to change. An alias or a full model id that the
// `claude --model` flag takes; "" = the default model of the login. Sonnet, because its turns are
// short triage (read a run, list the queue, one ticket or nothing): it costs a fraction of the
// default model, and it reads untrusted job output with more care than the smallest model.
export const COORDINATOR_MODEL = "sonnet";

export function resolveCoordinatorDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.COORDINATOR_DATA_DIR) return env.COORDINATOR_DATA_DIR;
  return join(resolveAppDataDir(env), "coordinator");
}

// The legacy (not hardened) home: the agent cwd and its memory. A hardened deployment moves
// both into AGENT_HOME_ROOT (server/chief/homes.ts persistentHome). `feed`: the console's own
// note of what the feed already carried (feed.ts); never the agent's to read or write.
export function coordinatorPaths(dataDir: string): { agentDir: string; memoryDir: string; feed: string } {
  return { agentDir: join(dataDir, "agent"), memoryDir: join(dataDir, "memory"), feed: join(dataDir, "feed.json") };
}
