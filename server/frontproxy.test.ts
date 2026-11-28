// The console behind a front proxy (server/frontproxy.ts): off by default, one private address,
// the proxy's address only, the proxy's token on every request and upgrade, the token header gone
// before any handler, and no USER right from the proxy alone.
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connect as tlsConnectRaw, type ConnectionOptions } from "node:tls";
// tls.connect takes the socket options of net.connect too (localAddress); its types do not say so.
const tlsConnect = (o: ConnectionOptions & { localAddress: string }, cb: () => void) => tlsConnectRaw(o, cb);
import { makeProxyTls } from "../bin/lib/firststart.js";
import { registerAuth } from "./auth.js";
import { DeviceStore } from "./chief/auth.js";
import { ClaimLinks } from "./chief/claimlink.js";
import { BoxCodes, DOOR_OP_HEADER, DOOR_PROOF_HEADER, RELINK_PROOF, RELINK_ROUTE, registerFirstRun } from "./chief/firstrun.js";
import { gateMerge, gateUser, makeGate } from "./chief/gate.js";
import { registerStrongAccess } from "./chief/access.js";
import { VERSION_HEADER, registerVersionHeader } from "./release.js";
import {
  PROXY_TOKEN_HEADER, allowedWithoutDevice, doorProof, hostInRange, inRange, installProxyGate, isTrustedProxyRequest, listenProxy, localAddressIn,
  parseProxySettings, privateRange, readProxySettings, registerDeviceGate, registerProxyHeaderStrip, devListenerRefusal, stripProxyHeader, type ProxyListener,
} from "./frontproxy.js";
import { wsUserOk } from "./chief/wsgate.js";
import { registerOriginGuard } from "./origin.js";

const TOKEN = "t".repeat(43);
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");
const ADDRESS = "127.0.0.3";
const FROM = "127.0.0.2";

let dir = "";
let tlsDir = "";
beforeAll(() => {
  process.env.CONSOLE_COOKIE_SECRET = "x".repeat(32);
  dir = mkdtempSync(join(tmpdir(), "frontproxy-"));
  tlsDir = join(dir, "tls");
  const made = makeProxyTls(tlsDir);
  if (!made.ok) throw new Error(`openssl: ${made.why}`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

type World = { app: FastifyInstance; proxy: ProxyListener; devices: DeviceStore; loopbackPort: number };

// A console with the walls of the real one: the proxy gate on the HTTP server, the origin guard,
// the first-run lock (optional), the outer gate, and routes guarded as Deploy/Settings (gateUser)
// and Merge (gateMerge) are.
async function world(o: { lock?: boolean; strong?: boolean; token?: string } = {}): Promise<World> {
  const d = mkdtempSync(join(dir, "w-"));
  const app = Fastify();
  installProxyGate(app.server, o.token === undefined ? HASH : createHash("sha256").update(o.token, "utf8").digest("hex"));
  registerProxyHeaderStrip(app);
  registerVersionHeader(app, { version: 849, commit: "b".repeat(40) });
  await app.register(websocket);
  registerOriginGuard(app);
  const devices = new DeviceStore(join(d, "devices.json"));
  const gate = makeGate({ misconfigured: null, userAuth: "log", deps: { devices, agents: { load: async () => null } } });
  if (o.lock) {
    registerFirstRun(app, {
      devices, codes: new BoxCodes(join(d, "pair-code.json")),
      links: new ClaimLinks({ firstStart: join(d, "first-start.json"), state: join(d, "claim-link.json") }),
      caller: (req) => gate.caller(req), pageRoute: "/*",
    });
  }
  registerDeviceGate(app, {
    kinds: new Set(["proxy"]),
    pageRoute: "/*",
    proof: { request: async (req) => (await gate.caller(req)).level === "user", upgrade: (req) => wsUserOk(req, async (t) => (await devices.verify(t)) !== null) },
  });
  registerAuth(app);
  // Strong protection's access layer, as index.ts registers it (after the outer gate): every hosted
  // console runs with it.
  if (o.strong) {
    const STRONG_ENV = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
    expect(registerStrongAccess(app, { gate, agents: { load: async () => null }, queue: { get: async () => null }, pageRoute: "/*", env: STRONG_ENV })).toBe(true);
    app.get("/api/version", async () => ({ kind: "release", version: 846 }));
  }
  // The lock registers the first-run routes itself.
  if (!o.lock) {
    app.get("/api/chief/pair/first", async () => ({ locked: false }));
    app.post("/api/chief/pair/first", async () => ({ ok: "first" }));
  }
  app.post("/api/chief/pair/claim", async () => ({ ok: "claim" }));
  app.get("/api/events", async () => "stream");
  app.get("/editor/*", async () => "editor");
  app.get("/api/echo", async (req) => ({ headers: req.headers, raw: req.raw.rawHeaders, distinct: req.raw.headersDistinct, trusted: isTrustedProxyRequest(req.raw) }));
  app.post("/api/user-only", async (req, reply) => ((await gateUser(gate, req, reply)) ? { ok: true } : reply));
  app.post("/api/merge-like", async (req, reply) => ((await gateMerge(gate, req, reply)) ? { ok: true } : reply));
  app.get("/api/ws", { websocket: true }, (socket) => { socket.send("hello"); });
  app.get("/*", async (req) => ({ page: req.raw.url }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => app.close());
  const proxy = await listenProxy({ http: app.server, address: ADDRESS, from: FROM, port: 0, tlsDir });
  closers.push(() => new Promise((r) => proxy.server.close(r)));
  return { app, proxy, devices, loopbackPort: (app.server.address() as { port: number }).port };
}

type Answer = { status: number; body: string; headers: Record<string, string | string[] | undefined> } | { error: string };
function call(w: World, o: { path: string; method?: string; token?: string | null; from?: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { host: "s1.example", ...(o.headers ?? {}) };
    if (o.token !== null) headers[PROXY_TOKEN_HEADER] = o.token ?? TOKEN;
    if (o.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
    const req = httpsRequest({ host: ADDRESS, port: w.proxy.port, localAddress: o.from ?? FROM, path: o.path, method: o.method ?? "GET", headers, rejectUnauthorized: false, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end(o.body);
  });
}
const ok = (a: Answer): { status: number; body: string; headers: Record<string, string | string[] | undefined> } => { if ("error" in a) throw new Error(`no answer: ${a.error}`); return a; };

describe("the settings of the front proxy", () => {
  const full = { CONSOLE_PROXY_FROM: "10.0.0.2", CONSOLE_PROXY_NETWORK: "10.0.0.0/16", CONSOLE_PROXY_PORT: "3443", CONSOLE_PROXY_TOKEN_SHA256: HASH, CONSOLE_PROXY_TLS_DIR: "/srv/x/proxy-tls" };
  it("are off by default (none set), and off (fail closed) when only some are set or one is wrong", () => {
    expect(readProxySettings({})).toBeNull();
    expect(readProxySettings(full)).toEqual({ from: "10.0.0.2", network: "10.0.0.0/16", port: 3443, tokenSha256: HASH, tlsDir: "/srv/x/proxy-tls" });
    expect(readProxySettings({ ...full, CONSOLE_PROXY_TLS_DIR: undefined })).toEqual({ off: "some proxy settings are missing" });
    for (const [k, v] of [["CONSOLE_PROXY_FROM", "10.1.0.2"], ["CONSOLE_PROXY_FROM", "10.0.0.02"], ["CONSOLE_PROXY_NETWORK", "203.0.113.0/24"], ["CONSOLE_PROXY_NETWORK", "10.0.5.7/16"], ["CONSOLE_PROXY_PORT", "80"], ["CONSOLE_PROXY_TOKEN_SHA256", "x"], ["CONSOLE_PROXY_TLS_DIR", "proxy-tls"]]) {
      expect(readProxySettings({ ...full, [k]: v }), `${k}=${v}`).toEqual({ off: expect.any(String) });
    }
  });
  it("read the first-start key in its canonical form only, and name a field, never a value", () => {
    expect(parseProxySettings({ from: "10.0.0.2", network: "10.0.0.0/16", port: 3443, tokenSha256: HASH })).toEqual({ from: "10.0.0.2", network: "10.0.0.0/16", port: 3443, tokenSha256: HASH });
    expect(parseProxySettings({ from: "10.0.0.0", network: "10.0.0.0/16", port: 3443, tokenSha256: HASH })).toEqual({ refused: "proxy.from" });
    expect(parseProxySettings({ from: "10.0.0.2", network: "10.0.0.0/16", port: 3443, tokenSha256: TOKEN })).toEqual({ refused: "proxy.tokenSha256" });
    expect(privateRange("192.168.0.0/16")).toBe(true);
    expect(inRange("10.0.200.7", "10.0.0.0/16")).toBe(true);
    expect(hostInRange("10.0.255.255", "10.0.0.0/16")).toBe(false);
  });
  it("find this server's ONE address in the network, never all addresses", () => {
    const nic = (address: string, internal = false) => ({ address, family: "IPv4" as const, internal, netmask: "255.255.0.0", mac: "00:00:00:00:00:00", cidr: null });
    expect(localAddressIn("10.0.0.0/16", { eth0: [nic("203.0.113.9")], enp7s0: [nic("10.0.1.5")] })).toBe("10.0.1.5");
    expect(localAddressIn("10.0.0.0/16", { eth0: [nic("203.0.113.9")] })).toBeNull();
    expect(localAddressIn("10.0.0.0/16", { a: [nic("10.0.1.5")], b: [nic("10.0.1.6")] })).toBeNull();
    expect(localAddressIn("10.0.0.0/16", { lo: [nic("10.0.1.5", true)] })).toBeNull();
  });
  it("never binds all addresses", async () => {
    const app = Fastify();
    await expect(listenProxy({ http: app.server, address: "0.0.0.0", from: FROM, port: 0, tlsDir })).rejects.toThrow(/never all/);
    await expect(listenProxy({ http: app.server, address: "::", from: FROM, port: 0, tlsDir })).rejects.toThrow(/never all/);
    await app.close();
  });
  it("refuses a TLS key that the group or others can read", async () => {
    const bad = mkdtempSync(join(dir, "bad-"));
    makeProxyTls(bad);
    chmodSync(join(bad, "key.pem"), 0o644);
    const app = Fastify();
    await expect(listenProxy({ http: app.server, address: ADDRESS, from: FROM, port: 0, tlsDir: bad })).rejects.toThrow(/mode 0600/);
    await app.close();
  });
});

describe("the private listener", () => {
  it("takes the proxy with its token: the outer gate passes with no cookie, and no handler sees the token", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    const a = ok(await call(w, { path: "/api/echo", headers: { "x-choibot-user": device } }));
    expect(a.status).toBe(200);
    const echo = JSON.parse(a.body);
    expect(echo.trusted).toBe(true);
    expect(JSON.stringify(echo)).not.toContain(TOKEN);
    expect(echo.headers).not.toHaveProperty(PROXY_TOKEN_HEADER);
    // headersDistinct (built from rawHeaders when first read) works and has no token either.
    expect(echo.distinct).not.toHaveProperty(PROXY_TOKEN_HEADER);
    expect(echo.distinct["x-choibot-user"]).toEqual([device]);
  });

  it("strong protection: the version that runs answers a loopback peer with no credential, never the proxy without a paired device", async () => {
    const w = await world({ strong: true });
    // The updater on the server: loopback, no credential (as release-format.md section 8).
    const local = await fetch(`http://127.0.0.1:${w.loopbackPort}/api/version`);
    expect([local.status, await local.json()]).toEqual([200, { kind: "release", version: 846 }]);
    // The same request through the door (its address, its token), with no paired device.
    const door = ok(await call(w, { path: "/api/version" }));
    expect([door.status, JSON.parse(door.body)]).toEqual([401, { error: "pair-required" }]);
    // A forwarding header that names the loopback does not help a request through the door.
    expect(ok(await call(w, { path: "/api/version", headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
    // A paired device through the door: as on loopback.
    const device = await w.devices.add("laptop");
    expect(ok(await call(w, { path: "/api/version", headers: { "x-choibot-user": device } })).status).toBe(200);
    // Every other route stays closed to the loopback caller with no credential.
    expect((await fetch(`http://127.0.0.1:${w.loopbackPort}/api/events`)).status).toBe(401);
  });

  it("gives the door the version on every answer of the private listener, also a refusal; never on loopback", async () => {
    const w = await world();
    const page = ok(await call(w, { path: "/", method: "HEAD" }));
    expect([page.status, page.headers[VERSION_HEADER]]).toEqual([200, `849 ${"b".repeat(40)}`]);
    const refused = ok(await call(w, { path: "/api/events" }));
    expect([refused.status, refused.headers[VERSION_HEADER]]).toEqual([401, `849 ${"b".repeat(40)}`]);
    const local = await fetch(`http://127.0.0.1:${w.loopbackPort}/`);
    expect(local.headers.get(VERSION_HEADER)).toBeNull();
    const injected = await w.app.inject({ method: "GET", url: "/" });
    expect(injected.headers[VERSION_HEADER]).toBeUndefined();
  });

  it("removes the token header of a request that did not come through the server's events (an inject, a second server)", async () => {
    const w = await world();
    const a = await w.app.inject({ method: "GET", url: "/api/echo", headers: { [PROXY_TOKEN_HEADER]: TOKEN } });
    expect(a.body).not.toContain(TOKEN);
    expect(JSON.parse(a.body).trusted).toBe(false);
  });

  it("strips the header from headers, headersDistinct and rawHeaders, and keeps the rest", () => {
    const req = { headers: { a: "1", [PROXY_TOKEN_HEADER]: "t" }, headersDistinct: { a: ["1"], [PROXY_TOKEN_HEADER]: ["t"] }, rawHeaders: ["A", "1", "X-Console-Proxy-Token", "t", "b", "2"] };
    expect(stripProxyHeader(req as never)).toBe("t");
    expect(req).toEqual({ headers: { a: "1" }, headersDistinct: { a: ["1"] }, rawHeaders: ["A", "1", "b", "2"] });
  });

  it("keeps the private listener off on a dev server, but for a test instance on its test address", () => {
    expect(devListenerRefusal(true, false)).toBe("a dev server (next dev) never takes the front proxy");
    expect(devListenerRefusal(true, true)).toBeNull();
    expect(devListenerRefusal(false, false)).toBeNull();
  });

  it("closes a connection from any other address before TLS", async () => {
    const w = await world();
    expect(await call(w, { path: "/api/echo", from: "127.0.0.4" })).toEqual({ error: expect.stringMatching(/ECONNRESET|EPIPE|socket hang up/) });
  });

  it("refuses a wrong, missing, long or repeated token with 403 Forbidden and nothing more", async () => {
    const w = await world();
    for (const t of [null, "", "x".repeat(43), "x".repeat(4000), `${TOKEN}, ${TOKEN}`]) {
      const a = ok(await call(w, { path: "/api/echo", token: t }));
      expect([a.status, a.body], String(t).slice(0, 20)).toEqual([403, "Forbidden"]);
    }
  });

  it("checks every request of a kept-alive connection, and every WebSocket upgrade", async () => {
    const w = await world();
    // A raw upgrade over TLS: the first line of the answer says it (101 or 403).
    const device = await w.devices.add("laptop");
    const open = (token: string | null) => new Promise<string>((resolve) => {
      const sock = tlsConnect({ host: ADDRESS, port: w.proxy.port, localAddress: FROM, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => {
        sock.write(["GET /api/ws HTTP/1.1", "Host: s1.example", "Origin: https://s1.example", "Upgrade: websocket", "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Protocol: ${device}`, ...(token ? [`${PROXY_TOKEN_HEADER}: ${token}`] : []), "", ""].join("\r\n"));
      });
      let got = "";
      sock.on("data", (c) => { got += c.toString("latin1"); if (got.includes("\r\n")) { resolve(got.split("\r\n")[0]); sock.destroy(); } });
      sock.on("error", (e) => resolve(`error ${e.message}`));
      sock.on("close", () => resolve(got.split("\r\n")[0] || "closed"));
    });
    expect(await open(TOKEN)).toBe("HTTP/1.1 101 Switching Protocols");
    expect(await open("x".repeat(43))).toBe("HTTP/1.1 403 Forbidden");
    expect(await open(null)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("checks the second request of one kept-alive connection on its own", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    const lines = await new Promise<string[]>((resolve) => {
      const sock = tlsConnect({ host: ADDRESS, port: w.proxy.port, localAddress: FROM, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => {
        sock.write(`GET /api/echo HTTP/1.1\r\nHost: s1.example\r\nx-choibot-user: ${device}\r\n${PROXY_TOKEN_HEADER}: ${TOKEN}\r\n\r\nGET /api/echo HTTP/1.1\r\nHost: s1.example\r\nx-choibot-user: ${device}\r\n\r\n`);
      });
      let got = "";
      sock.on("data", (c) => { got += c.toString("latin1"); });
      sock.on("close", () => resolve([...got.matchAll(/HTTP\/1\.1 \d{3} [A-Za-z ]+?(?=\r\n)/g)].map((m) => m[0])));
      setTimeout(() => sock.destroy(), 1500);
    });
    expect(lines).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 403 Forbidden"]);
  });

  it("is not the loopback listener: there the token header is removed too, and it gives no trust", async () => {
    const w = await world();
    const r = await w.app.inject({ method: "GET", url: "/api/echo", headers: { [PROXY_TOKEN_HEADER]: TOKEN }, remoteAddress: "203.0.113.7" });
    // A request from another address with the token, not over the private listener: refused by the outer gate.
    expect(r.statusCode).toBe(401);
  });
});

describe("deny by default without a paired device", () => {
  it("lets the app shell, /_next/static, the icons and the pairing APIs pass, and nothing else", async () => {
    const w = await world();
    for (const path of ["/", "/settings", "/first-run", "/pair", "/_next/static/chunks/a.js", "/favicon.ico", "/icon.svg", "/apple-icon.png"]) {
      expect(ok(await call(w, { path })).status, path).toBe(200);
    }
    expect(ok(await call(w, { path: "/api/chief/pair/first" })).status).toBe(200);
    for (const path of ["/api/chief/pair/first", "/api/chief/pair/claim"]) {
      expect(ok(await call(w, { path, method: "POST", body: "{}", headers: { origin: "https://s1.example" } })).status, path).toBe(200);
    }
    for (const path of ["/api/echo", "/api/events", "/api/agents", "/api/chief/pair/claim", "/api", "/api?x=1"]) {
      const a = ok(await call(w, { path }));
      expect([a.status, a.body], path).toEqual([401, JSON.stringify({ error: "pair-required" })]);
    }
    for (const path of ["/_next/image?url=%2Fapi%2Fecho&w=64&q=75", "/_next/webpack-hmr", "/__nextjs_launch-editor?file=x", "/__nextjs_source-map?filename=x", "/__nextjs_original-stack-frames", "/editor/", "/editor/x", "/_next/static/../../api/echo", "/_next/static/%2e%2e/x", "/x\\y"]) {
      expect(ok(await call(w, { path })).status, path).toBe(404);
    }
    // A HEAD of the shell passes too; a write to the shell does not.
    expect(ok(await call(w, { path: "/", method: "HEAD" })).status).toBe(200);
    expect(ok(await call(w, { path: "/", method: "POST", body: "{}", headers: { origin: "https://s1.example" } })).status).toBe(404);
  });

  it("gives a paired device what it gets on loopback: the API and the event stream", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    for (const path of ["/api/echo", "/api/events", "/api/agents"]) {
      expect(ok(await call(w, { path, headers: { "x-choibot-user": device } })).status, path).not.toBe(401);
    }
    expect(ok(await call(w, { path: "/api/echo", headers: { "x-choibot-user": "x".repeat(43) } })).status).toBe(401);
  });

  it("needs the device token in the subprotocol for a WebSocket, and refuses an upgrade outside /api at the gate", async () => {
    const w = await world();
    const device = await w.devices.add("phone");
    const open = (path: string, protocol: string | null) => new Promise<string>((resolve) => {
      const sock = tlsConnect({ host: ADDRESS, port: w.proxy.port, localAddress: FROM, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => {
        sock.write([`GET ${path} HTTP/1.1`, "Host: s1.example", "Origin: https://s1.example", "Upgrade: websocket", "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", `${PROXY_TOKEN_HEADER}: ${TOKEN}`, ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), "", ""].join("\r\n"));
      });
      let got = "";
      sock.on("data", (c) => { got += c.toString("latin1"); if (got.includes("\r\n")) { resolve(got.split("\r\n")[0]); sock.destroy(); } });
      sock.on("error", (e) => resolve(`error ${e.message}`));
      sock.on("close", () => resolve(got.split("\r\n")[0] || "closed"));
    });
    expect(await open("/api/ws", null)).toBe("HTTP/1.1 401 Unauthorized");
    expect(await open("/api/ws", "x".repeat(43))).toBe("HTTP/1.1 401 Unauthorized");
    expect(await open("/api/ws", device)).toBe("HTTP/1.1 101 Switching Protocols");
    expect(await open("/_next/webpack-hmr", device)).toBe("HTTP/1.1 403 Forbidden");
    expect(await open("/editor/ws", device)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("decides by the route pattern and the path, with no way around it by dots or encodings", () => {
    const allow = (m: string, u: string, r: string | undefined, up = false) => allowedWithoutDevice(m, u, r, "/*", up);
    expect(allow("GET", "/", "/*")).toBe(true);
    expect(allow("GET", "/api/chief/pair/first", "/api/chief/pair/first")).toBe(true);
    expect(allow("DELETE", "/api/chief/pair/first", "/api/chief/pair/first")).toBe(false);
    expect(allow("GET", "/api/chief/pair/claim", "/api/chief/pair/claim")).toBe(false);
    expect(allow("GET", "/healthz", "/healthz")).toBe(false);
    expect(allow("GET", "/", "/*", true)).toBe(false);
    for (const u of ["/a/../api/x", "/a/./b", "/%2e%2e/x", "/a%2Fb", "/a%5cb"]) expect(allow("GET", u, "/*"), u).toBe(false);
  });
});

// A raw request; the status line of the final answer, after any 1xx ("closed" when none came).
function rawRequest(w: World, text: string, over: "proxy" | "loopback"): Promise<string> {
  return new Promise((resolve) => {
    const sock = over === "proxy"
      ? tlsConnect({ host: ADDRESS, port: w.proxy.port, localAddress: FROM, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }, () => sock.write(text))
      : netConnect({ host: "127.0.0.1", port: w.loopbackPort }, () => sock.write(text));
    let got = "";
    const final = () => [...got.matchAll(/HTTP\/1\.1 \d{3} [^\r]*/g)].map((m) => m[0]).find((l) => !/^HTTP\/1\.1 1\d\d /.test(l));
    const done = (line: string) => { resolve(line); sock.destroy(); };
    sock.setTimeout(5_000, () => done(final() ?? "timeout"));
    sock.on("data", (c: Buffer) => { got += c.toString("latin1"); const f = final(); if (f) done(f); });
    sock.on("error", (e) => done(final() ?? `error ${e.message}`));
    sock.on("close", () => done(final() ?? "closed"));
  });
}

describe("the server's other request events (checkContinue, checkExpectation, connect)", () => {
  // What a library would add one day: each listener notes the call and the token header it saw.
  function listen(w: World) {
    const calls: { event: string; token: unknown }[] = [];
    const note = (event: string) => (req: IncomingMessage, out: ServerResponse | Socket) => {
      calls.push({ event, token: req.headers[PROXY_TOKEN_HEADER] ?? req.rawHeaders.find((h) => h.toLowerCase() === PROXY_TOKEN_HEADER) });
      if ("writeHead" in out) out.writeHead(200, { "content-length": "2", connection: "close" }).end("ok");
      else out.end("HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    };
    w.app.server.on("checkContinue", note("checkContinue"));
    w.app.server.on("checkExpectation", note("checkExpectation"));
    w.app.server.on("connect", note("connect"));
    return calls;
  }
  const head = (device: string, extra: string, path = "/api/echo") =>
    `POST ${path} HTTP/1.1\r\nHost: s1.example\r\n${PROXY_TOKEN_HEADER}: ${TOKEN}\r\nx-choibot-user: ${device}\r\ncontent-type: application/json\r\ncontent-length: 2\r\n${extra}\r\n`;

  it("refuses them on the private listener, with the right token and a device: the listener is never called", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    const calls = listen(w);
    expect(await rawRequest(w, head(device, "Expect: 100-continue\r\n"), "proxy")).toBe("HTTP/1.1 403 Forbidden");
    expect(await rawRequest(w, head(device, "Expect: something-else\r\n"), "proxy")).toBe("HTTP/1.1 403 Forbidden");
    expect(await rawRequest(w, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${PROXY_TOKEN_HEADER}: ${TOKEN}\r\nx-choibot-user: ${device}\r\n\r\n`, "proxy")).toBe("HTTP/1.1 403 Forbidden");
    expect(calls).toEqual([]);
  });

  it("on loopback they reach their listener as before, with the token header removed", async () => {
    const w = await world();
    const calls = listen(w);
    expect(await rawRequest(w, head("x", "Expect: 100-continue\r\n"), "loopback")).toMatch(/^HTTP\/1\.1 200 /);
    expect(await rawRequest(w, head("x", "Expect: something-else\r\n"), "loopback")).toMatch(/^HTTP\/1\.1 200 /);
    expect(await rawRequest(w, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n${PROXY_TOKEN_HEADER}: ${TOKEN}\r\n\r\n`, "loopback")).toMatch(/^HTTP\/1\.1 200 /);
    expect(calls).toEqual([{ event: "checkContinue", token: undefined }, { event: "checkExpectation", token: undefined }, { event: "connect", token: undefined }]);
  });

  it("with no listener (today), Expect: 100-continue on the private listener is a request like any other: the token decides", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    const body = "{}";
    const send = (token: string) => rawRequest(w, `${head(device, "Expect: 100-continue\r\n", "/api/user-only").replace(`${PROXY_TOKEN_HEADER}: ${TOKEN}`, `${PROXY_TOKEN_HEADER}: ${token}`)}${body}`, "proxy");
    // Node sends "100 Continue" itself before the request event (no data in it); then the gate.
    expect(await send("x".repeat(43))).toBe("HTTP/1.1 403 Forbidden");
    expect(await send(TOKEN)).toBe("HTTP/1.1 200 OK");
  });
});

describe("no USER right from the proxy alone", () => {
  it("a locked console (no paired device) shows the pairing screen and refuses the API", async () => {
    const w = await world({ lock: true });
    const page = JSON.parse(ok(await call(w, { path: "/settings" })).body);
    expect(page).toEqual({ page: "/first-run" });
    const api = ok(await call(w, { path: "/api/user-only", method: "POST", body: "{}", headers: { origin: "https://s1.example" } }));
    expect(api.status).toBe(403);
    expect(JSON.parse(api.body)).toEqual(expect.objectContaining({ error: "pair-required", locked: true }));
  });

  it("USER routes (Deploy, Settings writes: gateUser) and Merge (gateMerge) need the paired device's token", async () => {
    const w = await world();
    const post = (path: string, extra: Record<string, string> = {}) => call(w, { path, method: "POST", body: "{}", headers: { origin: "https://s1.example", ...extra } });
    for (const path of ["/api/user-only", "/api/merge-like"]) {
      const a = ok(await post(path));
      expect([a.status, JSON.parse(a.body).error], path).toEqual([401, "pair-required"]);
    }
    // A device paired through the proxy: its token works on each request, whatever the proxy's
    // own session is (the console never sees the proxy's cookies).
    const device = await w.devices.add("laptop");
    for (let i = 0; i < 2; i++) {
      for (const path of ["/api/user-only", "/api/merge-like"]) {
        const a = ok(await post(path, { "x-choibot-user": device, cookie: `proxy-session-${i}=x` }));
        expect(a.status, path).toBe(200);
      }
    }
  });

  it("refuses a cross-origin write over the proxy too (the origin guard stands)", async () => {
    const w = await world();
    const device = await w.devices.add("laptop");
    const a = ok(await call(w, { path: "/api/user-only", method: "POST", body: "{}", headers: { origin: "https://s2.example", "x-choibot-user": device } }));
    expect(a.status).toBe(403);
  });
});

// A door of before the proof (the edge's door today): it passes a browser's request to the
// private listener with its token, removes Cookie, and passes every other header on (the door op
// and a proof too) for any path.
async function oldDoor(w: World): Promise<string> {
  const server = createHttpServer((req, res) => {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: "s1.example", [PROXY_TOKEN_HEADER]: TOKEN };
    delete headers.cookie;
    delete headers.connection;
    const up = httpsRequest({ host: ADDRESS, port: w.proxy.port, localAddress: FROM, path: req.url, method: req.method, headers, rejectUnauthorized: false, agent: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}
// A plain HTTP request as curl makes it: no header but these (fetch adds Sec-Fetch-Mode).
function plain(hostPort: string, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const [host, port] = hostPort.split(":");
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port: Number(port), path: o.path, method: o.method ?? "GET", headers: o.headers ?? {}, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

describe("the door's new claim link (relink)", () => {
  const DOOR = { [DOOR_OP_HEADER]: "relink" };
  const READ_PROOF = { [DOOR_PROOF_HEADER]: doorProof(TOKEN, RELINK_PROOF.read) };
  const newBody = () => {
    const secret = randomBytes(32).toString("base64url");
    const link = { sha256: createHash("sha256").update(secret, "utf8").digest("hex"), expiresAt: Date.now() + 3_600_000 };
    return { secret, link, body: JSON.stringify(link), proof: { [DOOR_PROOF_HEADER]: doorProof(TOKEN, RELINK_PROOF.make(link)) } };
  };

  it("a browser's request through an OLD door (the door op passed on, the token added) is refused by the real console, whatever proof it makes up", async () => {
    const w = await world({ lock: true, strong: true });
    const door = await oldDoor(w);
    const { link, body } = newBody();
    // Someone with the owner's door session (no passkey) sends what the door's control path sends.
    const attack = (proof: Record<string, string>) =>
      plain(door, { path: RELINK_ROUTE, method: "POST", body, headers: { "content-type": "application/json", cookie: "door_session=stolen", ...DOOR, ...proof } });
    const madeUp: Record<string, string>[] = [
      {}, { [DOOR_PROOF_HEADER]: "0".repeat(64) }, { [DOOR_PROOF_HEADER]: doorProof("u".repeat(43), RELINK_PROOF.make(link)) },
      { [DOOR_PROOF_HEADER]: createHash("sha256").update(RELINK_PROOF.make(link), "utf8").digest("hex") },
    ];
    for (const proof of madeUp) {
      const r = await attack(proof);
      expect([r.status, JSON.parse(r.body)]).toEqual([403, { error: "door-only" }]);
    }
    const read = await plain(door, { path: RELINK_ROUTE, headers: DOOR });
    expect([read.status, JSON.parse(read.body)]).toEqual([403, { error: "door-only" }]);
    // The console is as it was: the door's own read says not claimed, and its own call works.
    const r0 = ok(await call(w, { path: RELINK_ROUTE, headers: { ...DOOR, ...READ_PROOF } }));
    expect([r0.status, JSON.parse(r0.body)]).toEqual([200, { claimed: false }]);
  });

  it("refuses the door's call with a missing, wrong or replayed proof over the real listener", async () => {
    const w = await world({ lock: true, strong: true });
    const a = newBody();
    const b = newBody();
    for (const proof of [{}, { [DOOR_PROOF_HEADER]: "0".repeat(64) }, b.proof, READ_PROOF]) {
      const r = ok(await call(w, { path: RELINK_ROUTE, method: "POST", body: a.body, headers: { ...DOOR, ...proof } }));
      expect([r.status, JSON.parse(r.body)]).toEqual([403, { error: "door-only" }]);
    }
    for (const proof of [{}, a.proof]) {
      const r = ok(await call(w, { path: RELINK_ROUTE, headers: { ...DOOR, ...proof } }));
      expect([r.status, JSON.parse(r.body)]).toEqual([403, { error: "door-only" }]);
    }
    // The proof of a, sent again with a: the same link, so the same answer as the first time.
    expect(ok(await call(w, { path: RELINK_ROUTE, method: "POST", body: a.body, headers: { ...DOOR, ...a.proof } })).status).toBe(200);
  });

  it("checks the proof before the shape over the real listener: with no right proof, the same 403 whatever the body", async () => {
    const w = await world({ lock: true, strong: true });
    const a = newBody();
    const tries: { body: string; headers?: Record<string, string> }[] = [
      { body: JSON.stringify({ ...a.link, sha256: "x" }) }, { body: JSON.stringify({ ...a.link, more: 1 }) }, { body: JSON.stringify("x") },
      { body: "{" }, { body: a.body, headers: { "content-type": "text/plain" } }, { body: JSON.stringify({ ...a.link, pad: "x".repeat(2_000_000) }) },
    ];
    for (const t of tries) {
      const r = ok(await call(w, { path: RELINK_ROUTE, method: "POST", body: t.body, headers: { ...DOOR, ...t.headers } }));
      expect([r.status, JSON.parse(r.body)]).toEqual([403, { error: "door-only" }]);
    }
    // A bad shape with the door's proof of it: the field.
    const far = { ...a.link, expiresAt: Date.now() + 2 * 86_400_000 };
    const bad = ok(await call(w, { path: RELINK_ROUTE, method: "POST", body: JSON.stringify(far), headers: { ...DOOR, [DOOR_PROOF_HEADER]: doorProof(TOKEN, RELINK_PROOF.make(far)) } }));
    expect([bad.status, JSON.parse(bad.body)]).toEqual([400, { error: "bad-relink", field: "expiresAt is more than 24 hours away" }]);
    expect(ok(await call(w, { path: RELINK_ROUTE, method: "POST", body: a.body, headers: { ...DOOR, ...a.proof } })).status).toBe(200);
  });

  it("refuses every proof when the door's token is longer than 64 bytes (the gate takes up to 128 characters)", async () => {
    const long = "L".repeat(100);
    const w = await world({ lock: true, strong: true, token: long });
    const { link, body } = newBody();
    // The key of HMAC-SHA256 for a key of more than 64 bytes: the token's SHA-256 (CONSOLE_PROXY_TOKEN_SHA256).
    const hmac = (key: string | Buffer, m: string) => ({ [DOOR_PROOF_HEADER]: createHmac("sha256", key).update(m, "utf8").digest("hex") });
    for (const key of [long, createHash("sha256").update(long, "utf8").digest()]) {
      // JSON: the route's answer, so the gate took the long token.
      const post = ok(await call(w, { path: RELINK_ROUTE, method: "POST", body, token: long, headers: { ...DOOR, ...hmac(key, RELINK_PROOF.make(link)) } }));
      expect([post.status, JSON.parse(post.body)]).toEqual([403, { error: "door-only" }]);
      const read = ok(await call(w, { path: RELINK_ROUTE, token: long, headers: { ...DOOR, ...hmac(key, RELINK_PROOF.read) } }));
      expect([read.status, JSON.parse(read.body)]).toEqual([403, { error: "door-only" }]);
    }
  });

  it("on loopback: the same 404 before the body is read (a wrong content type, a broken body, a proof)", async () => {
    const w = await world({ lock: true, strong: true });
    const { body, proof } = newBody();
    const at = `127.0.0.1:${w.loopbackPort}`;
    const tries: { headers: Record<string, string>; body?: string; method?: string }[] = [
      { headers: { "content-type": "text/plain", ...DOOR }, body },
      { headers: { "content-type": "application/json", ...DOOR }, body: "{" },
      { headers: { "content-type": "application/json", ...DOOR, ...proof }, body },
      { headers: { "content-type": "application/json" }, body: "x".repeat(2_000_000) },
      { headers: { ...DOOR, ...READ_PROOF }, method: "GET" },
    ];
    for (const t of tries) {
      const r = await plain(at, { path: RELINK_ROUTE, method: t.method ?? "POST", headers: t.headers, body: t.body });
      expect([r.status, JSON.parse(r.body)]).toEqual([404, { error: "not found" }]);
    }
  });

  it("only over the private listener with the door's token, on a locked console, with strong protection on", async () => {
    const w = await world({ lock: true, strong: true });
    const { secret, body, proof } = newBody();
    const send = (o: { token?: string | null; headers?: Record<string, string> } = {}) =>
      call(w, { path: RELINK_ROUTE, method: "POST", body, token: o.token, headers: o.headers ?? { ...DOOR, ...proof } });
    // No token, or a wrong one: the gate's 403 before any hook.
    for (const token of [null, "u".repeat(43)]) expect([ok(await send({ token })).status, ok(await send({ token })).body]).toEqual([403, "Forbidden"]);
    // The main listener (loopback, a true local peer): as if there were no such route.
    const local = await fetch(`http://127.0.0.1:${w.loopbackPort}${RELINK_ROUTE}`, { method: "POST", headers: { "content-type": "application/json", ...DOOR }, body });
    expect([local.status, await local.json()]).toEqual([404, { error: "not found" }]);
    // A browser's request that came through the door: refused.
    const browser = ok(await send({ headers: { ...DOOR, ...proof, origin: "https://s1.example", "sec-fetch-mode": "cors" } }));
    expect([browser.status, JSON.parse(browser.body)]).toEqual([403, { error: "door-only" }]);
    // The door's read before it offers the action: not claimed.
    const read = () => call(w, { path: RELINK_ROUTE, headers: { ...DOOR, ...READ_PROOF } });
    const r0 = ok(await read());
    expect([r0.status, JSON.parse(r0.body)]).toEqual([200, { claimed: false }]);
    // The door's own request: the new link is in place, and it pairs the first device through the door.
    const made = ok(await send());
    expect([made.status, JSON.parse(made.body).ok]).toEqual([200, true]);
    const paired = ok(await call(w, { path: "/api/chief/pair/first", method: "POST", body: JSON.stringify({ claim: secret }), headers: { origin: "https://s1.example" } }));
    expect(paired.status).toBe(200);
    // Claimed: no new link any more.
    const again = ok(await send());
    expect([again.status, JSON.parse(again.body)]).toEqual([409, { error: "claimed" }]);
    // The door's read with no device proof (the device gate lets it pass, as the POST): claimed.
    const r1 = ok(await read());
    expect([r1.status, JSON.parse(r1.body)]).toEqual([200, { claimed: true }]);
  });
});

describe("what the console must not have", () => {
  const files = (root: string): string[] => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const out: string[] = [];
    for (const n of readdirSync(root)) {
      if (n === "node_modules" || n === ".next") continue;
      const p = join(root, n);
      if (statSync(p).isDirectory()) out.push(...files(p));
      else if (/\.(m?[jt]sx?)$/.test(n)) out.push(p);
    }
    return out;
  };
  const repo = join(__dirname, "..");

  it("has no route and no page under /.door/ (the front proxy keeps that prefix for itself)", () => {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const hits = files(join(repo, "server")).filter((f) => !f.endsWith(".test.ts") && /["'`]\/\.door/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    expect(existsSync(join(repo, "src", "app", ".door"))).toBe(false);
    expect(existsSync(join(repo, "public", ".door"))).toBe(false);
  });

  it("counts or limits by the peer address (req.ip) in server/auth.ts only: behind the proxy every request has the proxy's address", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const hits = files(join(repo, "server")).filter((f) => !f.endsWith(".test.ts") && /\b(req|request)\.ip\b|\.remoteAddress\b/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.slice(repo.length + 1)).sort()).toEqual(["server/auth.ts", "server/frontproxy.ts"]);
  });
});
