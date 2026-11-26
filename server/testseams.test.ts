import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { describe, expect, it } from "vitest";
import { collectRoutes, readTestSeams, writeRouteDump } from "./testseams.js";

describe("the test settings of the route walk", () => {
  it("are off when not set, and refused without CHIEF_TEST=1", () => {
    expect(readTestSeams({})).toEqual({ routeDump: null, proxyTest: null });
    expect(readTestSeams({ CONSOLE_ROUTE_DUMP: "/tmp/x" })).toEqual({ refused: "CONSOLE_ROUTE_DUMP: a test setting, only with CHIEF_TEST=1" });
    expect(readTestSeams({ CONSOLE_PROXY_TEST_ADDRESS: "127.0.0.3,127.0.0.2", CHIEF_TEST: "0" })).toEqual({ refused: "CONSOLE_PROXY_TEST_ADDRESS: a test setting, only with CHIEF_TEST=1" });
    expect(readTestSeams({ CONSOLE_ROUTE_DUMP: "", CONSOLE_PROXY_TEST_ADDRESS: "" })).toEqual({ refused: "CONSOLE_ROUTE_DUMP and CONSOLE_PROXY_TEST_ADDRESS: a test setting, only with CHIEF_TEST=1" });
  });

  it("take a test address in 127.0.0.0/8 only, in canonical form, and an absolute dump path", () => {
    const t = { CHIEF_TEST: "1" };
    expect(readTestSeams({ ...t, CONSOLE_PROXY_TEST_ADDRESS: "127.0.0.3,127.0.0.2" })).toEqual({ routeDump: null, proxyTest: { address: "127.0.0.3", from: "127.0.0.2" } });
    for (const bad of ["10.0.0.3,127.0.0.2", "127.0.0.3,10.0.0.2", "0.0.0.0,127.0.0.2", "127.0.0.3", "127.0.0.03,127.0.0.2", "127.0.0.3,127.0.0.2,127.0.0.4", "::1,127.0.0.2", ""]) {
      expect("refused" in readTestSeams({ ...t, CONSOLE_PROXY_TEST_ADDRESS: bad }), bad).toBe(true);
    }
    expect("refused" in readTestSeams({ ...t, CONSOLE_ROUTE_DUMP: "routes.json" })).toBe(true);
    expect(readTestSeams({ ...t, CONSOLE_ROUTE_DUMP: "/r/routes.json" })).toEqual({ routeDump: "/r/routes.json", proxyTest: null });
  });

  it("dump every route, a WebSocket route as WS, methods and paths only, in one file of mode 0600", async () => {
    const app = Fastify();
    const routes = collectRoutes(app);
    await app.register(websocket);
    app.get("/api/a/:id", async () => "a");
    app.route({ method: ["POST", "DELETE"], url: "/api/b", handler: async () => "b" });
    app.register(async (child) => { child.get("/api/ws", { websocket: true }, () => {}); });
    await app.ready();
    const dir = mkdtempSync(join(tmpdir(), "seams-"));
    const file = join(dir, "routes.json");
    writeFileSync(file, "old", { mode: 0o644 });
    writeRouteDump(file, routes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const got = JSON.parse(readFileSync(file, "utf8")) as string[];
    expect(got).toEqual(["DELETE /api/b", "GET /api/a/:id", "HEAD /api/a/:id", "POST /api/b", "WS /api/ws"]);
    // Never through a link.
    const link = join(dir, "link.json");
    symlinkSync(join(dir, "elsewhere.json"), link);
    expect(() => writeRouteDump(link, routes)).toThrow();
    expect(existsSync(join(dir, "elsewhere.json"))).toBe(false);
    await app.close();
  });

  it("make the server refuse to start without CHIEF_TEST=1, before it writes or binds anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "seams-start-"));
    const seams: Record<string, string>[] = [{ CONSOLE_ROUTE_DUMP: join(dir, "routes.json") }, { CONSOLE_PROXY_TEST_ADDRESS: "127.0.0.3,127.0.0.2" }];
    for (const env of seams) {
      const r = spawnSync(join(process.cwd(), "node_modules/.bin/tsx"), ["server/index.ts"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: dir, CONSOLE_COOKIE_SECRET: "a".repeat(40), PORT: "1", HOST: "127.0.0.1", ...env } as unknown as NodeJS.ProcessEnv,
      });
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toMatch(/Refusing to start: CONSOLE_(ROUTE_DUMP|PROXY_TEST_ADDRESS): a test setting, only with CHIEF_TEST=1\./);
    }
    expect(existsSync(join(dir, "routes.json"))).toBe(false);
  }, 120_000);

  it("are in no file for users", () => {
    for (const f of ["README.md", ".env.example", "bin/lib/env.ts"]) {
      if (!existsSync(f)) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/CONSOLE_ROUTE_DUMP|CONSOLE_PROXY_TEST_ADDRESS/);
    }
  });
});
