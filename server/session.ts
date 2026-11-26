import { randomUUID } from "node:crypto";

// The signed `session` cookie carries this JSON value. `jti` gives each session a
// unique id; `exp` makes a leaked cookie expire on its own. There is no per-session
// revocation — rotating CONSOLE_COOKIE_SECRET invalidates all sessions at once.
export function makeSessionValue(ttlMs: number, now: number = Date.now()): string {
  return JSON.stringify({ jti: randomUUID(), exp: now + ttlMs });
}

export function isSessionValueValid(value: string | undefined, now: number = Date.now()): boolean {
  if (!value) return false;
  try {
    const o = JSON.parse(value) as { exp?: unknown };
    return typeof o.exp === "number" && now < o.exp;
  } catch {
    return false;
  }
}
