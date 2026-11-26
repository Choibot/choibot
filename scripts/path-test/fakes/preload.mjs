// scripts/path-test/fakes/preload.mjs — the path test's stand-ins INSIDE a Node process of the
// test (the console and the commands of the test root). The test loads it with
// NODE_OPTIONS=--import; nothing of the product loads it.
//
// 1. One fact of the kernel. The console asks "do I run in my own service?" by reading its
//    control group in /proc (server/chief/deploy/config.ts ownUnit). The test has no real
//    service manager: its fake systemctl starts the console as a plain process. So that one
//    read gets the answer a real service gives (PATH_TEST_UNIT). The other half of the question
//    (the main pid of the unit) is answered by the fake systemctl.
// 2. No network outside the test. A connection is allowed only to 127.0.0.1 on a port of the
//    test (PATH_TEST_PORTS). Every other one fails at once and is written to PATH_TEST_NET_LOG:
//    the live console of this machine, Anthropic, Telegram and GitHub are never reached, and the
//    test reads the log to say what the product tried.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const unit = process.env.PATH_TEST_UNIT;
if (unit && /^[a-z][a-z0-9-]*\.service$/.test(unit)) {
  const real = fs.promises.readFile;
  fs.promises.readFile = function readFile(path, ...rest) {
    if (typeof path === "string" && /^\/proc\/\d+\/cgroup$/.test(path)) {
      // The group of a service of user 4242 (the id that the fake `id -u` gives).
      return Promise.resolve(`0::/user.slice/user-4242.slice/${["user", "4242.service"].join("@")}/app.slice/${unit}\n`);
    }
    return real.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
}

const ports = new Set((process.env.PATH_TEST_PORTS ?? "").split(",").filter(Boolean).map(Number));
const netLog = process.env.PATH_TEST_NET_LOG;
if (ports.size > 0 && netLog) {
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guarded(...args) {
    // connect(options), connect(port, host), connect(path), or the array that net.connect makes.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const o = typeof first === "object" && first !== null ? first : typeof first === "number" ? { port: first, host: typeof args[1] === "string" ? args[1] : undefined } : { path: first };
    if (o.path !== undefined || (LOOPBACK.has(String(o.host ?? "localhost")) && ports.has(Number(o.port)))) return connect.apply(this, args);
    try { fs.appendFileSync(netLog, `${o.host ?? "localhost"}:${o.port} (pid ${process.pid}: ${process.argv.slice(1, 4).join(" ").slice(0, 160)})\n`); } catch { /* the log is gone: still refuse */ }
    const err = Object.assign(new Error(`connect ECONNREFUSED ${o.host ?? "localhost"}:${o.port} (the path test allows no connection outside the test)`), { code: "ECONNREFUSED" });
    process.nextTick(() => this.destroy(err));
    return this;
  };
}
