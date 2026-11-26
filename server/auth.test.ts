// server/auth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import { registerAuth } from "./auth.js";
import { makeSessionValue } from "./session.js";

beforeAll(() => {
  process.env.CONSOLE_COOKIE_SECRET = "x".repeat(32);
});

// A non-loopback client IP, so the cookie path (not loopback auto-trust) is exercised.
const REMOTE = "203.0.113.7";

describe("registerAuth", () => {
  it("auto-trusts loopback requests without a cookie", async () => {
    const app = Fastify();
    registerAuth(app);
    app.get("/", async () => "home");
    app.get("/api/ping", async () => ({ ok: true }));
    await app.ready();
    // inject defaults remoteAddress to 127.0.0.1 → loopback auto-trust.
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/ping" })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects non-loopback requests without a session cookie: 403 for pages, 401 for API", async () => {
    const app = Fastify();
    registerAuth(app);
    app.get("/api/ping", async () => ({ ok: true }));
    app.get("/", async () => "home");
    await app.ready();

    const page = await app.inject({ method: "GET", url: "/", remoteAddress: REMOTE });
    expect(page.statusCode).toBe(403);

    const api = await app.inject({ method: "GET", url: "/api/ping", remoteAddress: REMOTE });
    expect(api.statusCode).toBe(401);

    await app.close();
  });

  it("for non-loopback, rejects an expired session cookie and accepts a fresh one", async () => {
    const app = Fastify();
    registerAuth(app);
    app.get("/api/secret", async () => ({ ok: true }));
    await app.ready();
    const fresh = app.signCookie(makeSessionValue(60_000));
    const stale = app.signCookie(makeSessionValue(-1));
    const okRes = await app.inject({ method: "GET", url: "/api/secret", remoteAddress: REMOTE, cookies: { session: fresh } });
    expect(okRes.statusCode).toBe(200);
    const badRes = await app.inject({ method: "GET", url: "/api/secret", remoteAddress: REMOTE, cookies: { session: stale } });
    expect(badRes.statusCode).toBe(401);
    await app.close();
  });
});
