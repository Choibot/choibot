// server/testseams.ts — two settings for the route walk of the front proxy (scripts/proxy-walk.mts)
// on an isolated test instance (scripts/chief-instance.sh). Developer notes only: not for users,
// not in the README. Both work only with CHIEF_TEST=1; without it the server refuses to start
// when one of them is set.
//   CONSOLE_ROUTE_DUMP=<absolute path>: after the start, the server writes there (one file, mode
//     0600) every route that it registered, as "<METHOD> <path>" lines of a JSON list; a WebSocket
//     route is "WS <path>". Methods and paths only.
//   CONSOLE_PROXY_TEST_ADDRESS=<listen>,<from>: the private listener binds <listen> in place of
//     the server's address in the proxy's network, and takes connections from <from> in place of
//     CONSOLE_PROXY_FROM. Both in 127.0.0.0/8: a test machine has no second private address that
//     a test can send from.
//   CONSOLE_UPDATE_TEST_DIR=<absolute dir>: the root updater's status file and ask file
//     (server/update/status.ts) are <dir>/status.json and <dir>/ask, so a test instance shows the
//     Update ticket from fake status files. Honoured on a git checkout only (updatePaths): a
//     release or an archive install, so every hosted console, reads the two constants always.
import { closeSync, constants, fchmodSync, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { inRange, ipv4ToInt } from "./frontproxy.js";

export type TestSeams = { routeDump: string | null; proxyTest: { address: string; from: string } | null; updateDir: string | null };

export function readTestSeams(env: Record<string, string | undefined>): TestSeams | { refused: string } {
  const dump = env.CONSOLE_ROUTE_DUMP;
  const addr = env.CONSOLE_PROXY_TEST_ADDRESS;
  const update = env.CONSOLE_UPDATE_TEST_DIR;
  if (dump === undefined && addr === undefined && update === undefined) return { routeDump: null, proxyTest: null, updateDir: null };
  if (env.CHIEF_TEST !== "1") {
    const names = [dump !== undefined ? "CONSOLE_ROUTE_DUMP" : null, addr !== undefined ? "CONSOLE_PROXY_TEST_ADDRESS" : null, update !== undefined ? "CONSOLE_UPDATE_TEST_DIR" : null].filter(Boolean).join(" and ");
    return { refused: `${names}: a test setting, only with CHIEF_TEST=1` };
  }
  if (dump !== undefined && (!isAbsolute(dump) || dump.includes("\0"))) return { refused: "CONSOLE_ROUTE_DUMP: an absolute path" };
  if (update !== undefined && (!isAbsolute(update) || update.includes("\0"))) return { refused: "CONSOLE_UPDATE_TEST_DIR: an absolute path" };
  let proxyTest: TestSeams["proxyTest"] = null;
  if (addr !== undefined) {
    const parts = addr.split(",");
    const loop = (ip: string | undefined) => ip !== undefined && ipv4ToInt(ip) !== null && inRange(ip, "127.0.0.0/8");
    if (parts.length !== 2 || !loop(parts[0]) || !loop(parts[1])) return { refused: "CONSOLE_PROXY_TEST_ADDRESS: <listen>,<from>, both in 127.0.0.0/8" };
    proxyTest = { address: parts[0], from: parts[1] };
  }
  return { routeDump: dump ?? null, proxyTest, updateDir: update ?? null };
}

// Collects every route from now on (call it before the first route, on the root instance: its
// onRoute hook reaches the plugins too).
export function collectRoutes(app: FastifyInstance): string[] {
  const out: string[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) out.push(`${(r as { websocket?: boolean }).websocket ? "WS" : String(m).toUpperCase()} ${r.url ?? r.path}`);
  });
  return out;
}

export function writeRouteDump(path: string, routes: readonly string[]): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify([...new Set(routes)].sort(), null, 1)}\n`);
  } finally {
    closeSync(fd);
  }
}
