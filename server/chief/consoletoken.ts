// server/chief/consoletoken.ts — the token of the console's own account (strong protection).
//
// Why: with strong protection the agents run as another Linux account, and every process on the
// server can open 127.0.0.1. So a request from loopback says nothing about who sent it
// (server/chief/access.ts). The console's own tools (doctor, the set-up, the install agent) run
// as the console's account and have no device token. They prove that account with this token:
// 32 random bytes in chief/console-token, mode 0600, in the console's 0700 data folder, which the
// agents' account cannot read.
//
// The level it gives ("console") is short on purpose (access.ts): it is not the user. Every
// process of the console's account can read the file, so it must not merge, deploy, change a
// setting or read a login.
//
// A new token at each start of the console (the old one stops at once); the file is written new
// (a temp file, then a rename), never through a link.
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONSOLE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export type ConsoleToken = { verify(token: string): boolean };

// Make a new token for this start and keep only its hash in memory.
export function makeConsoleToken(file: string): ConsoleToken {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  const want = sha256(token);
  return {
    verify: (given: string) => typeof given === "string" && CONSOLE_TOKEN_RE.test(given) && timingSafeEqual(sha256(given), want),
  };
}

// For the CLI: the token, when this account can read a plain file of the right form. Else
// undefined (another account, no strong protection, no console started yet).
export function readConsoleToken(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return undefined;
    const t = readFileSync(file, "utf8").trim();
    return CONSOLE_TOKEN_RE.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}
