// server/defaults.ts — the defaults the console derives at run time, so a clean clone works
// under any Unix user and in any directory. `choibot setup` writes the real values to .env; these
// are the fallbacks when a key is unset. A leaf module (node built-ins and names.mjs only):
// bin/lib/doctor.ts, master/paths.ts and every server module may import it.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { names } from "./names.mjs";

export type Env = Record<string, string | undefined>;

const pinned = (v: string | undefined): string | undefined => v?.trim() || undefined;

// The dir the agents and the editor work in: WORKSPACE_DIR, else ~/workspace (setup's default).
export function resolveWorkspaceDir(env: Env = process.env): string {
  return pinned(env.WORKSPACE_DIR) ?? join(homedir(), "workspace");
}

// The root of the console's data dirs: $XDG_DATA_HOME/<data dir>, default ~/.local/share/<data dir>
// (choibot; choibot on an install with the old names). Each subsystem keeps its own subdir
// (chief, cron, issues, master).
export function resolveAppDataDir(env: Env = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), names().dataDir);
}

// A tool binary: the path in its env key (setup writes it), else ~/.local/bin/<name> (where the
// Claude installer and a self-built dtach put it), else the first <name> on PATH, else the bare
// name, which exec looks up on PATH when it runs.
export function toolBin(name: string, value: string | undefined, env: Env = process.env): string {
  const set = pinned(value);
  if (set) return set;
  for (const dir of [join(homedir(), ".local", "bin"), ...(env.PATH ?? "").split(delimiter)]) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return name;
}

export const resolveClaudeBin = (env: Env = process.env): string => toolBin("claude", env.CLAUDE_CODE_EXECUTABLE, env);
export const resolveDtachBin = (env: Env = process.env): string => toolBin("dtach", env.AGENT_DTACH_BIN, env);

