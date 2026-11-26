// server/issues/paths.ts — where the Issues subsystem keeps its data, and the
// one Telegram user allowed to drive it.
import { join } from "node:path";
import { resolveAppDataDir } from "../defaults.js";

// Same resolution order as resolveCronDataDir (bin/lib/cronspec.ts).
export function resolveIssuesDataDir(env: Record<string, string | undefined> = process.env): string {
  if (env.ISSUES_DATA_DIR) return env.ISSUES_DATA_DIR;
  return join(resolveAppDataDir(env), "issues");
}

// TELEGRAM_ISSUES_USER_ID → a positive integer, or null (intake off).
export function parseIssuesUserId(raw: string | undefined): number | null {
  const t = (raw ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
