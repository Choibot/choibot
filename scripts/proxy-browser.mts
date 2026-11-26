// scripts/proxy-browser.mts — browser checks of PR "the front proxy's private listener" (developer
// notes, not for users). Headless Chromium only (WebKit and Firefox do not start on the test
// machine). Give the folder of an installed playwright-core: CHOIBOT_TEST_PLAYWRIGHT=<folder>.
//
//   node_modules/.bin/tsx scripts/proxy-browser.mts loopback /tmp/chief-<name>
//     A normal instance (scripts/chief-instance.sh up, no proxy), new (locked). The browser pairs
//     with a box code on loopback; a live update arrives through the event stream (now a fetch
//     reader, src/lib/sse.ts); the server restarts; the stream opens again (one try every 3 s)
//     and the next live update arrives; an old tab's EventSource still gets the events; the
//     server sends a comment line every 20 s.
//
//   node_modules/.bin/tsx scripts/proxy-browser.mts door /tmp/chief-<name>
//     An instance from scripts/proxy-instance.sh up (the front proxy on its test address),
//     new (locked). A small test door here (plain HTTP for the browser on 127.0.0.1, TLS with the
//     pinned certificate and the proxy token to the private listener, from the door's address)
//     logs every request. The browser opens the claim link /first-run#k=<secret> through the door
//     and pairs; the console works through the door (the agent list, a live update, a preview
//     picture read with the device token); a new door (all connections cut) and the next live
//     update; a browser with no device goes to /pair. Then the door's log: no claim secret in any
//     address or header, every /api request but the pairing APIs carries the device token, the
//     event stream is a fetch.
// Screenshots go to <root>/shots/. It exits 1 on the first failed check.
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mintBoxCode } from "../server/chief/firstrun.ts";
import { chiefPaths, resolveChiefDataDir } from "../server/chief/paths.ts";

const [mode, root] = process.argv.slice(2);
if ((mode !== "loopback" && mode !== "door") || !root || !/^\/tmp\/chief-[a-z0-9-]+$/.test(root)) {
  console.error("usage: tsx scripts/proxy-browser.mts loopback|door /tmp/chief-<name>");
  process.exit(2);
}
const REPO = process.cwd();
const env = Object.fromEntries(readFileSync(join(root, "instance.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PORT = Number(env.PORT);
if (PORT === 3100) throw new Error("not a test instance");
const paths = chiefPaths(resolveChiefDataDir({ CHIEF_DATA_DIR: env.CHIEF_DATA_DIR }));
const SHOTS = join(root, "shots");
mkdirSync(SHOTS, { recursive: true, mode: 0o700 });

let failed = 0;
function check(ok: boolean, what: string): void {
  if (ok) console.log(`  ✓ ${what}`);
  else { failed++; console.error(`  ✖ ${what}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the browser
// playwright-core is not a dependency of this repo: its types are not here either.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chromium = { launch(o: object): Promise<any> };
async function findChromium(): Promise<Chromium> {
  const given = process.env.CHOIBOT_TEST_PLAYWRIGHT;
  const places = [given && join(given, "index.mjs"), join(REPO, "node_modules/playwright-core/index.mjs")].filter((p): p is string => !!p && existsSync(p));
  if (!places[0]) throw new Error("give CHOIBOT_TEST_PLAYWRIGHT=<folder of playwright-core>");
  const mod = await import(pathToFileURL(places[0]).href);
  return (mod.chromium ?? mod.default.chromium) as Chromium;
}
function libraryPath(): string | undefined {
  const top = join(homedir(), ".local/share/headless-libs");
  if (!existsSync(top)) return process.env.LD_LIBRARY_PATH;
  const walk = (d: string): string | undefined => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name === "libnspr4.so") return d;
      if (e.isDirectory()) { const f = walk(join(d, e.name)); if (f) return f; }
    }
    return undefined;
  };
  return walk(top);
}

// ---------------------------------------------------------------- loopback calls (the "outside")
function local(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port: PORT, method, path, agent: false, headers: { ...headers, ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}) } }, (res) => {
      let got = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { got += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: got }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
async function spawnAgent(): Promise<string> {
  const r = await local("POST", "/api/agents", {});
  if (r.status !== 202) throw new Error(`spawn: ${r.status} ${r.body}`);
  return (JSON.parse(r.body) as { id: string }).id;
}
async function waitFor(what: string, ok: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return true; await sleep(250); }
  console.error(`  … ${what}: not within ${ms} ms`);
  return false;
}

// ---------------------------------------------------------------- the test door
type Logged = { method: string; path: string; query: boolean; status: number; user: boolean; headers: string; kind: "http" | "upgrade" };
function startDoor(port: number, log: Logged[]): Promise<{ server: Server; port: number; cut: () => Promise<void> }> {
  const [ADDRESS, FROM] = env.CONSOLE_PROXY_TEST_ADDRESS.split(",");
  const PROXY_PORT = Number(env.CONSOLE_PROXY_PORT);
  const TOKEN = readFileSync(join(root, "proxy-token"), "utf8");
  const PIN = new X509Certificate(readFileSync(join(env.CONSOLE_PROXY_TLS_DIR, "cert.pem"))).fingerprint256;
  // The hop: TLS to the private listener, from the door's address, the console's certificate pinned.
  const hop = (): ConnectionOptions & { localAddress: string } => ({
    host: ADDRESS, port: PROXY_PORT, localAddress: FROM, rejectUnauthorized: false,
    checkServerIdentity: (_h, cert) => (cert.fingerprint256 === PIN ? undefined : new Error("not the pinned certificate")),
  });
  const sockets = new Set<Socket>();
  const note = (req: IncomingMessage, kind: Logged["kind"]): Logged => {
    const u = req.url ?? "";
    const entry: Logged = { method: req.method ?? "", path: u.split("?")[0], query: u.includes("?"), status: 0, user: typeof req.headers["x-choibot-user"] === "string", headers: JSON.stringify(req.headers) + u, kind };
    log.push(entry);
    return entry;
  };
  const server = createServer((req, res) => {
    const entry = note(req, "http");
    // A new connection to the console for each request: the door shares no connection.
    const up = httpsRequest({ ...hop(), method: req.method, path: req.url, agent: false, headers: { ...req.headers, "x-console-proxy-token": TOKEN } }, (r) => {
      entry.status = r.statusCode ?? 0;
      res.writeHead(r.statusCode ?? 502, r.headers);
      // At once, as the console does: an event stream's headers come before its first event.
      res.flushHeaders();
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  server.on("upgrade", (req: IncomingMessage, sock: Socket, head: Buffer) => {
    const entry = note(req, "upgrade");
    const up = tlsConnect(hop(), () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      lines.push(`x-console-proxy-token: ${TOKEN}`, "", "");
      up.write(lines.join("\r\n"));
      if (head.length) up.write(head);
      up.once("data", (c: Buffer) => { entry.status = Number(c.toString("latin1").split(" ")[1]) || 0; });
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  server.on("connection", (s: Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    const cut = () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
      setTimeout(done, 2_000).unref();
    });
    resolve({ server, port: a.port, cut });
  }));
}

// ---------------------------------------------------------------- loopback mode
async function loopbackMode(): Promise<void> {
  const chromium = await findChromium();
  const browser = await chromium.launch({ headless: true, env: { ...process.env, ...(libraryPath() ? { LD_LIBRARY_PATH: libraryPath()! } : {}) } });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    // The reader's own calls (the page's fetch), apart from what the browser's network layer does.
    await page.addInitScript(() => {
      const w = window as unknown as { __streamCalls: number[]; fetch: typeof fetch };
      w.__streamCalls = [];
      const real = w.fetch.bind(window);
      w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/api/events")) w.__streamCalls.push(Date.now());
        return real(input, init);
      }) as typeof fetch;
    });
    const streams: { at: number; type: string; user: boolean }[] = [];
    const opened: number[] = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/events") streams.push({ at: Date.now(), type: r.resourceType(), user: !!r.headers()["x-choibot-user"] }); });
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/events" && r.status() === 200) opened.push(Date.now()); });
    const base = `http://127.0.0.1:${PORT}`;
    console.log("pair with a box code");
    const { code } = await mintBoxCode(paths.pairCode);
    await page.goto(`${base}/first-run`);
    await page.getByPlaceholder("XXXX-XXXX").fill(code);
    await page.getByRole("button", { name: "Pair this device" }).click();
    await page.getByRole("button", { name: /^Open / }).click();
    await page.waitForURL(`${base}/`);
    await page.locator("[data-queue-row]").waitFor({ timeout: 30_000 });
    check(await waitFor("the stream opens", () => opened.length >= 1, 15_000), "the event stream opens");
    check(streams.length > 0 && streams.every((s) => s.type === "fetch" && s.user), "the event stream is a fetch with the device token (not an EventSource)");

    console.log("a live update");
    const a = await spawnAgent();
    check(await waitFor("row A", async () => (await page.locator(`[data-open-agent="${a}"]`).count()) > 0, 20_000), "a new agent shows by the event stream (the list has no poll)");

    console.log("restart the server");
    const before = opened.length;
    const restartAt = Date.now();
    execFileSync(join(REPO, "scripts/chief-instance.sh"), ["restart", root], { stdio: "ignore", timeout: 300_000 });
    check(await waitFor("the stream opens again", () => opened.length > before, 60_000), "the event stream opens again after the restart");
    // Each useEvents of the page has its own stream (as each EventSource had): in any 2.9 s, at
    // most one try for each stream that was open before the restart.
    const perPage = before;
    const calls = await page.evaluate(() => (window as unknown as { __streamCalls: number[] }).__streamCalls);
    const tries = calls.filter((t) => t >= restartAt).sort((x, y) => x - y);
    const most = Math.max(0, ...tries.map((t) => tries.filter((u) => u >= t && u < t + 2_900).length));
    check(tries.length > perPage && most <= perPage, `while the server was down each stream tried once in 3 s (${tries.length} tries of ${perPage} streams, at most ${most} in 2.9 s)`);
    const b = await spawnAgent();
    check(await waitFor("row B", async () => (await page.locator(`[data-open-agent="${b}"]`).count()) > 0, 20_000), "the next live update arrives after the restart");
    await page.screenshot({ path: join(SHOTS, "loopback-after-restart.png") });

    console.log("an old tab's EventSource");
    const old = page.evaluate(() => new Promise<string>((resolve) => {
      const es = new EventSource("/api/events");
      es.onmessage = (m) => { es.close(); resolve(m.data as string); };
      setTimeout(() => { es.close(); resolve("none"); }, 20_000);
    }));
    await sleep(1_000);
    const c = await spawnAgent();
    const got = await old;
    check(got !== "none" && got.includes('"type"'), "an EventSource (an old tab) still gets the events");
    check(await waitFor("row C", async () => (await page.locator(`[data-open-agent="${c}"]`).count()) > 0, 20_000), "the page still gets the events");

    console.log("the server's comment line");
    const ping = await new Promise<string>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port: PORT, path: "/api/events", agent: false }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (s: string) => { text += s; if (text.includes(": ping\n\n")) { req.destroy(); resolve("ping"); } });
      });
      req.on("error", () => resolve("error"));
      setTimeout(() => { req.destroy(); resolve("none"); }, 25_000);
      req.end();
    });
    check(ping === "ping", "the server sends a comment line within 20 s");
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- door mode
async function doorMode(): Promise<void> {
  const chromium = await findChromium();
  const browser = await chromium.launch({ headless: true, env: { ...process.env, ...(libraryPath() ? { LD_LIBRARY_PATH: libraryPath()! } : {}) } });
  const log: Logged[] = [];
  let door = await startDoor(0, log);
  const base = `http://127.0.0.1:${door.port}`;
  try {
    // The claim link, as the first start leaves it (claimlink.ts): only its hash on the server.
    const secret = randomBytes(32).toString("base64url");
    writeFileSync(paths.claimLink, JSON.stringify({ sha256: createHash("sha256").update(secret).digest("hex"), expiresAt: Date.now() + 3_600_000, tries: 0, hosted: true }), { mode: 0o600 });

    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const kinds: { path: string; type: string }[] = [];
    const opened: number[] = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) kinds.push({ path: u.pathname, type: r.resourceType() }); });
    page.on("response", (r) => { if (new URL(r.url()).pathname === "/api/events" && r.status() === 200) opened.push(Date.now()); });

    console.log("the claim link through the door");
    await page.goto(`${base}/first-run#k=${secret}`);
    await page.getByRole("button", { name: "This is my console" }).click();
    await page.getByRole("button", { name: /^Open / }).click();
    await page.waitForURL(`${base}/`);
    await page.locator("[data-queue-row]").waitFor({ timeout: 30_000 });
    check(await waitFor("the stream", () => opened.length >= 1, 15_000), "the console opens through the door, with its event stream");
    await page.screenshot({ path: join(SHOTS, "door-console.png") });

    console.log("a live update through the door");
    const a = await spawnAgent();
    check(await waitFor("row A", async () => (await page.locator(`[data-open-agent="${a}"]`).count()) > 0, 20_000), "a new agent shows by the event stream through the door");

    console.log("a preview picture through the door");
    const rec = JSON.parse(readFileSync(join(env.AGENT_DATA_DIR, `${a}.json`), "utf8")) as { hookToken: string; cwd: string };
    await page.screenshot({ path: join(rec.cwd, "walk-shot.png"), clip: { x: 0, y: 0, width: 480, height: 300 } });
    const add = await local("POST", "/api/queue", { kind: "preview", title: "Walk picture", body: "A picture through the door.", preview: { images: ["walk-shot.png"] } }, { "x-choibot-agent": a, "x-choibot-agent-token": rec.hookToken });
    check(add.status === 200 || add.status === 201, `an agent adds a ticket with a picture (${add.status} ${add.status >= 300 ? add.body : ""})`);
    await page.locator("[data-queue-row] button").first().click();
    const img = page.locator('img[alt="Walk picture — image 1"]').first();
    await img.waitFor({ timeout: 20_000 });
    check(await waitFor("the picture", async () => (await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)), 20_000), "the preview picture shows");
    check((await img.getAttribute("src"))?.startsWith("blob:") === true, "the picture is shown from an object URL (read with the device token)");
    await page.screenshot({ path: join(SHOTS, "door-queue-picture.png") });

    console.log("a new door: every connection is cut");
    const before = opened.length;
    await door.cut();
    door = await startDoor(door.port, log);
    check(await waitFor("the stream again", () => opened.length > before, 30_000), "the event stream opens again through the new door");
    const b = await spawnAgent();
    check(await waitFor("row B", async () => (await page.locator(`[data-open-agent="${b}"]`).count()) > 0, 20_000), "the paired device works after a new door session");

    console.log("a browser with no device");
    const stranger = await (await browser.newContext({ viewport: { width: 760, height: 860 } })).newPage();
    await stranger.goto(`${base}/`);
    check(await waitFor("the pair page", () => new URL(stranger.url()).pathname === "/pair", 20_000), "a browser with no device opens the pairing screen");
    await stranger.screenshot({ path: join(SHOTS, "door-stranger.png") });

    console.log("the door's log");
    const pairing = new Set(["/api/chief/pair/first", "/api/chief/devices/claim", "/api/chief/pair/claim"]);
    check(log.every((l) => !l.headers.includes(secret)), `no address and no header holds the claim secret (${log.length} requests)`);
    check(log.every((l) => !/[#?&]k=/.test(l.headers)), "no address holds k=");
    const paired = log.filter((l) => l.path.startsWith("/api/") && !pairing.has(l.path) && l.user);
    const mine = log.filter((l) => l.path.startsWith("/api/") && !pairing.has(l.path));
    const strangerCalls = mine.filter((l) => !l.user);
    check(strangerCalls.every((l) => l.status === 401), `every /api request with no device token was refused (${strangerCalls.length}, all from the browser with no device)`);
    check(paired.every((l) => l.status !== 401), `no request of the paired device was refused (${paired.length})`);
    check(kinds.filter((k) => k.path === "/api/events").every((k) => k.type === "fetch"), "the event stream is a fetch");
    check(log.some((l) => /^\/api\/queue\/[^/]+\/media\//.test(l.path) && l.user && l.status === 200), "the picture went through the door with the device token");
    writeFileSync(join(root, "door-log.json"), JSON.stringify(log.map(({ headers: _h, ...l }) => l), null, 1), { mode: 0o600 });
  } finally {
    await door.cut();
    await Promise.race([browser.close(), sleep(10_000)]);
  }
}

(mode === "loopback" ? loopbackMode() : doorMode())
  // An exit in both ends: a closed page can keep a socket of the test door open.
  .then(() => { if (failed) { console.error(`${failed} checks failed`); process.exit(1); } console.log("all checks passed"); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });

