// scripts/proxy-walk.mts — the route walk of the front proxy's private listener (server/frontproxy.ts).
//
// Developer notes (not for users). It runs against an isolated instance started with
// scripts/proxy-instance.sh up /tmp/chief-<name> (scripts/chief-instance.sh with the front proxy and
// the two test settings of server/testseams.ts):
//   CONSOLE_PROXY_FROM, _NETWORK, _PORT, _TOKEN_SHA256, _TLS_DIR (inside the root),
//   CONSOLE_PROXY_TEST_ADDRESS=<listen>,<from> (both in 127.0.0.0/8) and
//   CONSOLE_ROUTE_DUMP=<root>/routes.json (every route that the server registered).
// The proxy's test token is in <root>/proxy-token (0600); the instance has its SHA-256 only.
//
//   node_modules/.bin/tsx scripts/proxy-walk.mts <root>
//
// What it checks, in this order:
//   A. The console is locked (no device): over the private listener with the right token and no
//      device, every route of the dump outside ALLOWED is refused (by the lock or by the gate).
//   B. A first device is paired on loopback with a box code, as `choibot pair` does.
//   C. The same walk on the paired console: every route outside ALLOWED gets the gate's refusal,
//      every route in ALLOWED passes the gate.
//   D. The app shell over the private listener with no device holds no data: the HTML of /,
//      /first-run and /pair is the same before and after the console gets more data, and holds
//      none of it.
//   E. A second device pairs THROUGH the private listener (Add a device), and works on a new
//      connection (a new door session): the API, a WebSocket and the event stream.
//   F. The loopback snapshot: every route on 127.0.0.1 with no cookie, no token and no device;
//      the routes that answer (open) go to <root>/loopback-snapshot.md for the PR text.
// It exits 1 on the first check that fails.
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { join } from "node:path";
import { mintBoxCode } from "../server/chief/firstrun.ts";
import { chiefPaths, resolveChiefDataDir } from "../server/chief/paths.ts";

// ---------------------------------------------------------------- the allow-list
// Over the private listener, with the right proxy token and NO device, only these pass the gate:
// the pairing APIs, and GET/HEAD of the app shell (the page catch-all outside /api, /_next and
// /editor; /_next/static; the three icons).
// (HEAD /api/chief/pair/first, Fastify's twin of the GET route, is not in the list: refused.)
const ALLOWED = new Set([
  "GET /api/chief/pair/first",
  "POST /api/chief/pair/first",
  "POST /api/chief/devices/claim",
  "POST /api/chief/pair/claim",
]);
const SHELL_OK = ["/", "/settings", "/agents/x", "/first-run", "/pair", "/favicon.ico", "/icon.svg", "/apple-icon.png"];
const SHELL_REFUSED = [
  "/api", "/api/", "/api/nope", "/_next/image?url=%2Fapi%2Fqueue&w=64&q=75", "/_next/webpack-hmr", "/_next/data/x/index.json",
  "/__nextjs_launch-editor?file=x", "/__nextjs_source-map?filename=x",
  "/editor", "/editor/", "/editor/x", "/a/../api/queue", "/%2e%2e/api/queue", "/_next/static/%2e%2e/x", "/x%2Fy",
];
const UPGRADE_OUTSIDE_API = ["/", "/editor/x", "/_next/webpack-hmr", "/pair"];

// ---------------------------------------------------------------- the instance
const root = process.argv[2];
if (!root || !/^\/tmp\/chief-[a-z0-9-]+$/.test(root)) {
  console.error("usage: tsx scripts/proxy-walk.mts /tmp/chief-<name>");
  process.exit(2);
}
const env = Object.fromEntries(readFileSync(join(root, "instance.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PORT = Number(env.PORT);
const PROXY_PORT = Number(env.CONSOLE_PROXY_PORT);
const [ADDRESS, FROM] = (env.CONSOLE_PROXY_TEST_ADDRESS ?? "").split(",");
const TOKEN = readFileSync(join(root, "proxy-token"), "utf8");
const PIN = new X509Certificate(readFileSync(join(env.CONSOLE_PROXY_TLS_DIR!, "cert.pem"))).fingerprint256;
if (createHash("sha256").update(TOKEN).digest("hex") !== env.CONSOLE_PROXY_TOKEN_SHA256) throw new Error("the token file is not the instance's token");
if (PORT === 3100 || !ADDRESS || !FROM) throw new Error("not a walk instance");
const ROUTES = JSON.parse(readFileSync(join(root, "routes.json"), "utf8")) as string[];
const HOST = "s0walk.example";

// ---------------------------------------------------------------- requests
type Answer = { status: number; type: string; body: string };
const tlsOpts = (): ConnectionOptions & { localAddress: string } => ({ host: ADDRESS, port: PROXY_PORT, localAddress: FROM, rejectUnauthorized: false, servername: undefined });

function call(over: "proxy" | "loopback", method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const h: Record<string, string> = { host: over === "proxy" ? HOST : `127.0.0.1:${PORT}`, ...headers };
    if (over === "proxy") h["x-console-proxy-token"] = TOKEN;
    if (body !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(body)); }
    const o = over === "proxy"
      ? { ...tlsOpts(), method, path, headers: h, agent: false as const }
      : { host: "127.0.0.1", port: PORT, method, path, headers: h, agent: false as const };
    const req = (over === "proxy" ? httpsRequest : httpRequest)(o, (res) => {
      if (over === "proxy") {
        const fp = (res.socket as unknown as { getPeerCertificate(): { fingerprint256: string } }).getPeerCertificate().fingerprint256;
        if (fp !== PIN) { reject(new Error(`certificate ${fp} is not the pinned one`)); res.destroy(); return; }
      }
      const type = String(res.headers["content-type"] ?? "");
      let got = "";
      if (type.startsWith("text/event-stream")) { resolve({ status: res.statusCode ?? 0, type, body: "" }); res.destroy(); return; }
      res.setEncoding("utf8");
      res.on("data", (c: string) => { if (got.length < 4096) got += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type, body: got }));
      res.on("error", reject);
    });
    req.setTimeout(15_000, () => { req.destroy(new Error(`timeout ${method} ${path}`)); });
    req.on("error", reject);
    req.end(body);
  });
}

function upgrade(over: "proxy" | "loopback", path: string, protocol: string | null): Promise<string> {
  return new Promise((resolve) => {
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${over === "proxy" ? HOST : `127.0.0.1:${PORT}`}`, "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13",
      ...(over === "proxy" ? [`x-console-proxy-token: ${TOKEN}`] : []), ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), "", ""].join("\r\n");
    const sock = over === "proxy" ? tlsConnect(tlsOpts(), () => sock.write(lines)) : netConnect({ host: "127.0.0.1", port: PORT }, () => sock.write(lines));
    let got = "";
    const done = (s: string) => { resolve(s); sock.destroy(); };
    sock.setTimeout(15_000, () => done("timeout"));
    sock.on("data", (c: Buffer) => { got += c.toString("latin1"); if (got.includes("\r\n")) done(got.split("\r\n")[0]); });
    sock.on("error", (e) => done(`error ${e.message}`));
    sock.on("close", () => done(got.split("\r\n")[0] || "closed"));
  });
}

// ---------------------------------------------------------------- checks
let failed = 0;
function check(ok: boolean, what: string): void {
  if (!ok) { failed++; console.error(`✖ ${what}`); }
}
const concrete = (p: string): string => p.replace(/:[A-Za-z_]+/g, "walk").replace(/\*$/, "walk");
const isApi = (p: string): boolean => p === "/api" || p.startsWith("/api/");
// The gate's refusal (server/frontproxy.ts registerDeviceGate).
function gateRefused(method: string, path: string, a: Answer): boolean {
  if (isApi(path.split("?")[0])) return a.status === 401 && a.type.startsWith("application/json") && (method === "HEAD" || a.body === '{"error":"pair-required"}');
  return a.status === 404 && a.type.startsWith("text/plain") && (method === "HEAD" || a.body === "Not found");
}
// The first-run lock's refusal (server/chief/firstrun.ts).
function lockRefused(method: string, a: Answer): boolean {
  if (a.status !== 403 || !a.type.startsWith("application/json")) return false;
  if (method === "HEAD") return true;
  try { const b = JSON.parse(a.body) as { error?: string; locked?: boolean }; return b.error === "pair-required" && b.locked === true; } catch { return false; }
}
// Under the lock every page address outside /api/ is the pairing screen (firstrun.ts rewrites it
// to /first-run before the gate): that page, not a refusal, and it holds no data (check D).
const lockPage = (method: string, path: string, a: Answer): boolean =>
  (method === "GET" || method === "HEAD") && !path.startsWith("/api/") && !path.startsWith("/_next/") && a.status === 200 && a.type.startsWith("text/html");
const bodyFor = (method: string): string | undefined => (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "TRACE" ? undefined : "{}");

async function walkProxy(phase: "locked" | "paired"): Promise<number> {
  let n = 0;
  for (const r of ROUTES) {
    const [method, pattern] = r.split(" ");
    if (pattern === "/*") continue; // below, with concrete paths
    const path = concrete(pattern);
    if (method === "WS") {
      const line = await upgrade("proxy", path, null);
      n++;
      check(/^HTTP\/1\.1 40[13] /.test(line), `${phase}: ${r} over the proxy with no device: ${line}`);
      const plain = await call("proxy", "GET", path);
      n++;
      check(gateRefused("GET", path, plain) || (phase === "locked" && lockRefused("GET", plain)), `${phase}: GET ${path} (a WebSocket route) with no device: ${plain.status} ${plain.body.slice(0, 80)}`);
      continue;
    }
    const a = await call("proxy", method, path, {}, bodyFor(method));
    n++;
    const refused = gateRefused(method, path, a) || (phase === "locked" && lockRefused(method, a));
    if (ALLOWED.has(r)) check(!gateRefused(method, path, a), `${phase}: ${r} is allowed, but the gate refused it`);
    else check(refused, `${phase}: ${r} (${path}) over the proxy with no device was not refused: ${a.status} ${a.body.slice(0, 100)}`);
  }
  // The page catch-all, every method it has.
  const pageMethods = ROUTES.filter((r) => r.endsWith(" /*")).map((r) => r.split(" ")[0]);
  for (const method of pageMethods) {
    for (const path of [...SHELL_OK, ...SHELL_REFUSED]) {
      const a = await call("proxy", method, path, {}, bodyFor(method));
      n++;
      const shell = (method === "GET" || method === "HEAD") && SHELL_OK.includes(path);
      if (shell) check(!gateRefused(method, path, a) && a.status < 500, `${phase}: ${method} ${path} (the shell) got ${a.status}`);
      else check(gateRefused(method, path, a) || (phase === "locked" && (lockRefused(method, a) || lockPage(method, path, a))), `${phase}: ${method} ${path} with no device was not refused: ${a.status} ${a.body.slice(0, 80)}`);
    }
  }
  // A real built file of the shell.
  const html = (await call("proxy", "GET", "/")).body;
  const asset = /(\/_next\/static\/[^"'\s]+\.js)/.exec(html)?.[1];
  check(!!asset, `${phase}: the HTML of / names a /_next/static file`);
  if (asset) { const a = await call("proxy", "GET", asset); n++; check(a.status === 200, `${phase}: GET ${asset}: ${a.status}`); }
  // An upgrade outside /api never passes, with the token or a device.
  for (const path of UPGRADE_OUTSIDE_API) {
    const line = await upgrade("proxy", path, null);
    n++;
    check(line === "HTTP/1.1 403 Forbidden", `${phase}: an upgrade of ${path}: ${line}`);
  }
  return n;
}

async function pairOnLoopback(label: string): Promise<string> {
  const { code } = await mintBoxCode(chiefPaths(resolveChiefDataDir({ CHIEF_DATA_DIR: env.CHIEF_DATA_DIR })).pairCode);
  const a = await call("loopback", "POST", "/api/chief/pair/first", {}, JSON.stringify({ code, label }));
  if (a.status !== 200) throw new Error(`the box code claim failed: ${a.status} ${a.body}`);
  return (JSON.parse(a.body) as { token: string }).token;
}

// `next dev` stamps each answer with its time (?v=<ms> on the assets, ":N<ms>" in the page data),
// and so cuts the page data into chunks at other places: join the chunks, drop the stamps.
const normal = (html: string): string => html
  .replace(/"\]\)<\/script><script>self\.__next_f\.push\(\[1,"/g, "")
  .replace(/\?v=\d+/g, "").replace(/:N\d+(\.\d+)?/g, "");

async function shellHtml(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of ["/", "/first-run", "/pair"]) {
    const a = await call("proxy", "GET", p);
    check(a.status === 200 && a.type.startsWith("text/html"), `the shell ${p}: ${a.status} ${a.type}`);
    out[p] = normal((await callFull("proxy", p)).body);
  }
  return out;
}

// The whole body (the shell HTML is larger than the 4 KB that `call` keeps).
function callFull(over: "proxy", path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ ...tlsOpts(), method: "GET", path, headers: { host: HOST, "x-console-proxy-token": TOKEN }, agent: false }, (res) => {
      let got = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { got += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: got }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function main(): Promise<void> {
  // A. Locked.
  const locked = await call("loopback", "GET", "/api/chief/pair/first");
  if (locked.body !== '{"locked":true}' && !locked.body.startsWith('{"locked":true')) throw new Error(`the instance is not locked (start a new one): ${locked.body}`);
  const nA = await walkProxy("locked");
  console.log(`A. locked: ${nA} requests over the private listener with no device`);

  // B. A first device on loopback.
  const device1 = await pairOnLoopback("walk-first");
  console.log("B. a first device is paired on loopback");

  // D (part 1). The shell before more data.
  const before = await shellHtml();

  // C. Paired.
  const nC = await walkProxy("paired");
  console.log(`C. paired: ${nC} requests over the private listener with no device`);

  // E. A second device through the private listener, then on a new connection.
  const add = await call("proxy", "POST", "/api/chief/devices/add", { "x-choibot-user": device1 }, "{}");
  check(add.status === 200, `E: Add a device over the proxy: ${add.status} ${add.body.slice(0, 80)}`);
  const code = (JSON.parse(add.body) as { code?: string }).code ?? "";
  const claim = await call("proxy", "POST", "/api/chief/devices/claim", {}, JSON.stringify({ code, label: "walk-marker-7q2" }));
  check(claim.status === 200, `E: the claim over the proxy: ${claim.status} ${claim.body.slice(0, 80)}`);
  const device2 = (JSON.parse(claim.body) as { token?: string }).token ?? "";
  const list = await call("proxy", "GET", "/api/brain/devices", { "x-choibot-user": device2 });
  check(list.status === 200 && list.body.includes("walk-marker-7q2"), `E: the new device reads its device list on a new connection: ${list.status}`);
  const events = await call("proxy", "GET", "/api/events", { "x-choibot-user": device2 });
  check(events.status === 200 && events.type.startsWith("text/event-stream"), `E: the new device opens the event stream: ${events.status} ${events.type}`);
  const ws = await upgrade("proxy", "/api/agents/walk/terminal", device2);
  check(!/^HTTP\/1\.1 401 /.test(ws), `E: the new device passes the gate of a WebSocket: ${ws}`);
  const wsBad = await upgrade("proxy", "/api/agents/walk/terminal", "x".repeat(43));
  check(/^HTTP\/1\.1 401 /.test(wsBad), `E: a wrong subprotocol token is refused: ${wsBad}`);
  const rule = await call("proxy", "POST", "/api/brain/rules", { "x-choibot-user": device2 }, JSON.stringify({ text: "walk-marker-rule-5k1", scope: { area: "*" }, kind: "preference", via: "tab" }));
  check(rule.status < 300, `E: the new device writes a rule (a USER write): ${rule.status} ${rule.body.slice(0, 80)}`);
  console.log("E. a device paired through the private listener works on a new connection");

  // D (part 2). The shell after more data (a device, a rule): the same, and none of the data.
  const after = await shellHtml();
  for (const p of Object.keys(before)) {
    if (before[p] !== after[p]) {
      const name = p === "/" ? "root" : p.slice(1);
      writeFileSync(join(root, `shell-${name}-before.html`), before[p], { mode: 0o600 });
      writeFileSync(join(root, `shell-${name}-after.html`), after[p], { mode: 0o600 });
    }
    check(before[p] === after[p], `D: the HTML of ${p} changed with the console's data (both are in ${root})`);
    for (const marker of ["walk-first", "walk-marker", device1, device2, root, env.HOME ?? "/home"]) check(!after[p].includes(marker), `D: the HTML of ${p} holds ${marker === device1 || marker === device2 ? "a device token" : marker}`);
    check(after[p].includes("ChoiBot"), `D: the HTML of ${p} holds the display name`);
  }
  console.log("D. the shell holds no data");

  // F. The loopback snapshot (no cookie, no token, no device). Reads first, then writes.
  const rows: { route: string; status: number; error: string }[] = [];
  const order = [...ROUTES].sort((a, b) => Number(bodyFor(a.split(" ")[0]) !== undefined) - Number(bodyFor(b.split(" ")[0]) !== undefined));
  for (const r of order) {
    const [method, pattern] = r.split(" ");
    if (pattern === "/*" || pattern.startsWith("/editor")) continue;
    const path = concrete(pattern);
    if (method === "WS") {
      const line = await upgrade("loopback", path, null);
      rows.push({ route: r, status: Number(line.split(" ")[1]) || 0, error: line });
      continue;
    }
    const a = await call("loopback", method, path, {}, bodyFor(method));
    let error = "";
    try { error = String((JSON.parse(a.body) as { error?: unknown }).error ?? ""); } catch { /* not JSON */ }
    rows.push({ route: r, status: a.status, error });
  }
  const open = rows.filter((x) => x.status !== 401 && x.status !== 403);
  const refused = rows.filter((x) => x.status === 401 || x.status === 403);
  const md = [
    `Loopback, no cookie, no token, no device (paired console): ${rows.length} routes, ${open.length} answer, ${refused.length} refuse.`,
    "", "| Route (\"walk\" for each parameter) | Answer |", "|---|---|",
    ...open.map((x) => `| \`${x.route}\` | ${x.status}${x.error ? ` ${x.error}` : ""} |`),
  ].join("\n");
  writeFileSync(join(root, "loopback-snapshot.md"), `${md}\n`, { mode: 0o600 });
  console.log(`F. loopback snapshot: ${open.length} of ${rows.length} routes answer with no device (${join(root, "loopback-snapshot.md")})`);

  if (failed) { console.error(`${failed} checks failed`); process.exit(1); }
  console.log(`all checks passed (${ROUTES.length} routes in the dump)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
