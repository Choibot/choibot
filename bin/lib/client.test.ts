import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_HEADER, AGENT_TOKEN_HEADER, CONSOLE_HEADER, USER_HEADER } from "../../server/chief/auth.js";
import {
  CliError, agentHeadersFromEnv, consoleBase, consoleTokenOf, createConsoleClient, humanShell, resolveUserToken,
  userTokenPath, withInstallPort, writeUserToken, type CliEnv,
} from "./client.js";

type Call = { method: string; url: string; path: string; body: any; headers: Record<string, string> };
type Handler = (body: any) => { status?: number; body?: unknown };

const IDENTITY = [USER_HEADER, AGENT_HEADER, AGENT_TOKEN_HEADER];
const idHeaders = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => IDENTITY.includes(k.toLowerCase())));

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "chief-client-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

// Every env in this file carries a temp HOME (never the real one), except the
// one writeUserToken case that proves a missing HOME is refused.
const envOf = (extra: CliEnv = {}): CliEnv => ({ HOME: home, PORT: "4321", ...extra });

function world(routes: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), path: u.pathname, body, headers: { ...(init?.headers as Record<string, string>) } });
    const h = routes[`${method} ${u.pathname}`];
    const r = h ? h(body) : { status: 200, body: { ok: true } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

// A readFile stub over a fixed path map that records every read.
function files(map: Record<string, string> = {}) {
  const reads: string[] = [];
  const readFile = (p: string): string | null => { reads.push(p); return p in map ? map[p] : null; };
  return { reads, readFile };
}

const tokenFile = () => join(home, ".config", "choibot", "user-token");

describe("withInstallPort: a command in a person's shell calls the console of its own install", () => {
  const file = (text: string | null) => (p: string) => (p === "/srv/ada/choibot/app/.env" ? text : null);

  it("takes the port of the install's settings file when the shell has none", () => {
    const env = withInstallPort({ HOME: "/home/ada" }, "/srv/ada/choibot/app", file("CONSOLE_COOKIE_SECRET=s3cret\nPORT=3101\nHOST=127.0.0.1\n"));
    expect(consoleBase(env)).toBe("http://127.0.0.1:3101");
    // Only the port: no other value of the file is in the env of the command.
    expect(env).toEqual({ HOME: "/home/ada", PORT: "3101" });
  });

  it("keeps the port of the shell (an agent of the console, a test instance)", () => {
    const env = { PORT: "4321" };
    expect(withInstallPort(env, "/srv/ada/choibot/app", file("PORT=3101\n"))).toBe(env);
  });

  it("is the default port with no file, no port in the file, or a value that is not a port", () => {
    for (const text of [null, "HOST=127.0.0.1\n", "PORT=\n", "PORT=abc\n", "PORT=3100; rm\n"]) {
      const env = { HOME: "/home/ada" };
      expect(withInstallPort(env, "/srv/ada/choibot/app", file(text))).toBe(env);
      expect(consoleBase(env)).toBe("http://127.0.0.1:3100");
    }
  });
});

describe("consoleBase", () => {
  it("defaults to 127.0.0.1:3100 and follows PORT (string only, never fetched)", () => {
    expect(consoleBase({})).toBe("http://127.0.0.1:3100");   // consoleBase never reads HOME
    expect(consoleBase({ HOME: home })).toBe("http://127.0.0.1:3100");
    expect(consoleBase({ HOME: home, PORT: "4321" })).toBe("http://127.0.0.1:4321");
  });
  it("CHIEF_TEST=1 requires PORT and refuses 3100", () => {
    expect(() => consoleBase({ HOME: home, CHIEF_TEST: "1" })).toThrow(CliError);
    expect(() => consoleBase({ HOME: home, CHIEF_TEST: "1", PORT: "3100" })).toThrow(CliError);
    expect(() => consoleBase({ HOME: home, CHIEF_TEST: "1", PORT: "03100" })).toThrow(CliError);
    expect(consoleBase({ HOME: home, CHIEF_TEST: "1", PORT: "4321" })).toBe("http://127.0.0.1:4321");
  });
  it("createConsoleClient refuses a CHIEF_TEST env without a safe PORT", () => {
    const w = world();
    expect(() => createConsoleClient({ fetch: w.fetch, env: { HOME: home, CHIEF_TEST: "1", PORT: "3100" }, flags: {},
      stderrIsTTY: true, readFile: files().readFile })).toThrow(CliError);
    expect(w.calls).toEqual([]);
  });
});

describe("humanShell and the user-token source rule (§3.1 step 4)", () => {
  const NOT_HUMAN: [string, CliEnv, boolean][] = [
    ["CHOIBOT_AGENT_ID", { CHOIBOT_AGENT_ID: "a1" }, true],
    ["CLAUDECODE", { CLAUDECODE: "1" }, true],
    ["CODEX_HOME", { CODEX_HOME: "/x/.codex" }, true],
    ["stderr not a TTY", {}, false],
  ];

  it("is a human shell only with no agent markers and a TTY stderr", () => {
    expect(humanShell(envOf(), true)).toBe(true);
    for (const [, extra, tty] of NOT_HUMAN) expect(humanShell(envOf(extra), tty)).toBe(false);
    // "unset" means absent: a marker set to the empty string still counts.
    for (const k of ["CHOIBOT_AGENT_ID", "CLAUDECODE", "CODEX_HOME"]) expect(humanShell(envOf({ [k]: "" }), true)).toBe(false);
  });

  for (const [name, extra, tty] of NOT_HUMAN) {
    it(`ignores CHOIBOT_USER_TOKEN and the token file when ${name}`, async () => {
      const f = files({ [tokenFile()]: "file-tok\n" });
      const env = envOf({ CHOIBOT_USER_TOKEN: "env-tok", ...extra });
      expect(resolveUserToken({ flags: {}, env, stderrIsTTY: tty, readFile: f.readFile })).toBeUndefined();
      expect(f.reads).toEqual([]);
      const w = world();
      const c = createConsoleClient({ fetch: w.fetch, env, flags: {}, stderrIsTTY: tty, readFile: f.readFile });
      await c.call("GET", "/api/x");
      expect(w.calls[0].headers[USER_HEADER]).toBeUndefined();
      await expect(c.callAsUser("GET", "/api/x")).rejects.toThrow(CliError);
      expect(w.calls).toHaveLength(1);
      expect(f.reads).toEqual([]);
    });
  }

  it("decides on stderr only: a piped stdin is never read and does not block the token", async () => {
    expect(process.stdin.isTTY).toBeFalsy();   // the test runner's stdin is not a terminal
    const read = vi.spyOn(process.stdin, "read");
    const on = vi.spyOn(process.stdin, "on");
    const f = files({ [tokenFile()]: "file-tok\n" });
    const w = world();
    const c = createConsoleClient({ fetch: w.fetch, env: envOf(), flags: {}, stderrIsTTY: true, readFile: f.readFile });
    await c.call("GET", "/api/x");
    expect(idHeaders(w.calls[0].headers)).toEqual({ [USER_HEADER]: "file-tok" });
    expect(read).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  it("uses the token file in a human shell, at $HOME/.config/choibot/user-token", () => {
    expect(userTokenPath(envOf())).toBe(`${home}/.config/choibot/user-token`);
    const f = files({ [tokenFile()]: "  file-tok\n" });
    expect(resolveUserToken({ flags: {}, env: envOf(), stderrIsTTY: true, readFile: f.readFile })).toBe("file-tok");
    expect(f.reads).toEqual([tokenFile()]);
  });

  it("takes the flag over the env over the file", () => {
    const f = files({ [tokenFile()]: "file-tok" });
    const r = (flags: Record<string, string | true>, env: CliEnv) => resolveUserToken({ flags, env, stderrIsTTY: true, readFile: f.readFile });
    expect(r({ "user-token": "flag-tok" }, envOf({ CHOIBOT_USER_TOKEN: "env-tok" }))).toBe("flag-tok");
    expect(r({}, envOf({ CHOIBOT_USER_TOKEN: "env-tok" }))).toBe("env-tok");
    expect(r({}, envOf())).toBe("file-tok");
    expect(r({}, envOf({ CHOIBOT_USER_TOKEN: "" }))).toBe("file-tok");
    expect(resolveUserToken({ flags: {}, env: envOf(), stderrIsTTY: true, readFile: files({ [tokenFile()]: " \n" }).readFile })).toBeUndefined();
  });

  it("takes --user-token even outside a human shell, and refuses it without a value", () => {
    const f = files();
    expect(resolveUserToken({ flags: { "user-token": "T" }, env: envOf({ CLAUDECODE: "1" }), stderrIsTTY: false, readFile: f.readFile })).toBe("T");
    for (const v of [true, ""] as const) {
      expect(() => resolveUserToken({ flags: { "user-token": v }, env: envOf({ CHOIBOT_USER_TOKEN: "env-tok" }), stderrIsTTY: true, readFile: f.readFile }))
        .toThrow(CliError);
    }
    expect(f.reads).toEqual([]);
  });
});

describe("agentHeadersFromEnv", () => {
  it("sends both agent headers with CHOIBOT_AGENT_ID and CHOIBOT_AGENT_PASS", () => {
    expect(agentHeadersFromEnv(envOf({ CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" }))).toEqual({ [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "p" });
  });
  it("sends only x-choibot-agent for a cron job without PASS", () => {
    expect(agentHeadersFromEnv(envOf({ CHOIBOT_AGENT_ID: "cron:j1" }))).toEqual({ [AGENT_HEADER]: "cron:j1" });
  });
  it("is undefined without CHOIBOT_AGENT_ID", () => {
    expect(agentHeadersFromEnv(envOf())).toBeUndefined();
    expect(agentHeadersFromEnv(envOf({ CHOIBOT_AGENT_PASS: "p" }))).toBeUndefined();
  });
});

describe("createConsoleClient identity", () => {
  const make = (o: { env?: CliEnv; flags?: Record<string, string | true>; tty?: boolean; file?: string; routes?: Record<string, Handler> } = {}) => {
    const w = world(o.routes);
    const f = files(o.file === undefined ? {} : { [tokenFile()]: o.file });
    const c = createConsoleClient({ fetch: w.fetch, env: envOf(o.env), flags: o.flags ?? {}, stderrIsTTY: o.tty ?? true, readFile: f.readFile });
    return { ...w, ...f, c };
  };

  it("--user-token T with CHOIBOT_AGENT_ID set sends only x-choibot-user: T", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" }, flags: { "user-token": "T" } });
    expect(await m.c.call("POST", "/api/x", { a: 1 })).toEqual({ ok: true });
    expect(idHeaders(m.calls[0].headers)).toEqual({ [USER_HEADER]: "T" });
    expect(m.calls[0].url).toBe("http://127.0.0.1:4321/api/x");
    expect(m.calls[0].headers["content-type"]).toBe("application/json");
    expect(m.calls[0].body).toEqual({ a: 1 });
    expect(await m.c.identity()).toBe("user");
  });

  it("agent env sends both agent headers and no user token", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p", CHOIBOT_USER_TOKEN: "env-tok" }, file: "file-tok" });
    await m.c.call("GET", "/api/x");
    expect(idHeaders(m.calls[0].headers)).toEqual({ [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "p" });
    expect(await m.c.identity()).toBe("agent");
  });

  it("CHOIBOT_AGENT_ID=cron:j1 without PASS sends only x-choibot-agent", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "cron:j1" }, tty: false });
    await m.c.call("POST", "/api/x");
    expect(idHeaders(m.calls[0].headers)).toEqual({ [AGENT_HEADER]: "cron:j1" });
  });

  it("a human shell with a token sends the user token; with neither identity sends none", async () => {
    const u = make({ env: { CHOIBOT_USER_TOKEN: "env-tok" } });
    await u.c.call("GET", "/api/x");
    expect(idHeaders(u.calls[0].headers)).toEqual({ [USER_HEADER]: "env-tok" });
    expect(await u.c.identity()).toBe("user");
    const n = make();
    await n.c.call("GET", "/api/x");
    expect(idHeaders(n.calls[0].headers)).toEqual({});
    expect(await n.c.identity()).toBe("none");
  });

  it("--agent a1 fetches the record with only the user token, then acts with only its agent headers", async () => {
    const rec = { id: "a1", hookToken: "hk", status: "idle" };
    const m = make({
      env: { CHOIBOT_AGENT_ID: "fleet-master", CHOIBOT_AGENT_PASS: "env-pass" },
      flags: { agent: "a1", "user-token": "T" }, tty: false,
      routes: { "GET /api/agents/a1": () => ({ body: rec }) },
    });
    await m.c.call("POST", "/api/queue", { kind: "question" });
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/agents/a1", "POST /api/queue"]);
    expect(m.calls[0].headers).toEqual({ [USER_HEADER]: "T" });
    expect(idHeaders(m.calls[1].headers)).toEqual({ [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "hk" });
    expect(await m.c.identity()).toBe("agent");
    await m.c.call("GET", "/api/y");
    expect(m.calls).toHaveLength(3);   // the record is fetched once
    expect(idHeaders(m.calls[2].headers)).toEqual({ [AGENT_HEADER]: "a1", [AGENT_TOKEN_HEADER]: "hk" });
  });

  it("--agent takes the user token from the human-shell file", async () => {
    const m = make({ flags: { agent: "a1" }, file: "file-tok", routes: { "GET /api/agents/a1": () => ({ body: { id: "a1", hookToken: "hk" } }) } });
    expect(await m.c.identity()).toBe("agent");
    expect(m.calls[0].headers).toEqual({ [USER_HEADER]: "file-tok" });
  });

  it("--agent without a user token is a CliError and sends nothing", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "fleet-master", CHOIBOT_AGENT_PASS: "p", CHOIBOT_USER_TOKEN: "env-tok" }, flags: { agent: "a1" }, file: "file-tok" });
    await expect(m.c.call("GET", "/api/x")).rejects.toThrow(CliError);
    await expect(m.c.identity()).rejects.toThrow(CliError);
    expect(m.calls).toEqual([]);
  });

  it("--agent without an id, or a record without hookToken, is a CliError", async () => {
    const bare = make({ flags: { agent: true, "user-token": "T" } });
    await expect(bare.c.call("GET", "/api/x")).rejects.toThrow(CliError);
    expect(bare.calls).toEqual([]);
    const stripped = make({ flags: { agent: "a1", "user-token": "T" }, routes: { "GET /api/agents/a1": () => ({ body: { id: "a1" } }) } });
    await expect(stripped.c.call("GET", "/api/x")).rejects.toThrow(/hook token/);
    expect(stripped.calls.map((c) => c.path)).toEqual(["/api/agents/a1"]);
  });

  it("callAsUser sends only the user token, ignoring --agent and agent env", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" }, flags: { agent: "a2", "user-token": "T" } });
    await m.c.callAsUser("POST", "/api/brain/devices/x/revoke");
    expect(m.calls).toHaveLength(1);
    expect(idHeaders(m.calls[0].headers)).toEqual({ [USER_HEADER]: "T" });
  });

  it("callAsUser without a user token is a CliError and sends nothing", async () => {
    const m = make();
    await expect(m.c.callAsUser("GET", "/api/brain/devices")).rejects.toThrow(CliError);
    expect(m.calls).toEqual([]);
  });

  it("callBare sends no identity headers at all", async () => {
    const m = make({ env: { CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" }, flags: { "user-token": "T" } });
    await m.c.callBare("POST", "/api/chief/pair/claim", { code: "c" });
    expect(idHeaders(m.calls[0].headers)).toEqual({});
    expect(m.calls[0].body).toEqual({ code: "c" });
  });

  it("passes extra headers but never lets them add a second identity", async () => {
    const m = make({ flags: { "user-token": "T" } });
    await m.c.call("POST", "/api/agents/w1/stop", undefined, { "x-choibot-actor": "fleet-master", "X-ChoiBot-Agent": "a9", [AGENT_TOKEN_HEADER]: "z" });
    expect(m.calls[0].headers["x-choibot-actor"]).toBe("fleet-master");
    expect(idHeaders(m.calls[0].headers)).toEqual({ [USER_HEADER]: "T" });
  });
});

describe("createConsoleClient errors", () => {
  const client = (routes: Record<string, Handler>, fetchImpl?: typeof fetch) =>
    createConsoleClient({ fetch: fetchImpl ?? world(routes).fetch, env: envOf(), flags: {}, stderrIsTTY: false, readFile: files().readFile });

  it("maps !res.ok and ok:false to CliError(json.error ?? HTTP <status>)", async () => {
    await expect(client({ "GET /a": () => ({ status: 403, body: { error: "pair-required", userAuth: "log" } }) }).call("GET", "/a"))
      .rejects.toThrow(new CliError("pair-required"));
    await expect(client({ "GET /a": () => ({ status: 500 }) }).call("GET", "/a")).rejects.toThrow(new CliError("HTTP 500"));
    await expect(client({ "GET /a": () => ({ status: 200, body: { ok: false, error: "nope" } }) }).call("GET", "/a")).rejects.toThrow(new CliError("nope"));
    await expect(client({ "GET /a": () => ({ status: 200, body: { ok: false } }) }).call("GET", "/a")).rejects.toThrow(new CliError("HTTP 200"));
    expect(await client({ "POST /a": () => ({ status: 202 }) }).call("POST", "/a")).toEqual({});
  });

  it("turns a network failure into a CliError naming the base", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await expect(client({}, down).callBare("GET", "/a")).rejects.toThrow(/console unreachable at http:\/\/127\.0\.0\.1:4321/);
  });
});

describe("writeUserToken", () => {
  it("writes the token 0600 in a 0700 dir under the given HOME and returns the path", async () => {
    const p = await writeUserToken({ HOME: home }, "t");
    expect(p).toBe(tokenFile());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "choibot")).mode & 0o777).toBe(0o700);
    const f = files({ [p]: readFileSync(p, "utf8") });
    expect(resolveUserToken({ flags: {}, env: { HOME: home }, stderrIsTTY: true, readFile: f.readFile })).toBe("t");
  });

  it("tightens an existing token file and dir", async () => {
    mkdirSync(join(home, ".config", "choibot"), { recursive: true, mode: 0o755 });
    writeFileSync(tokenFile(), "old", { mode: 0o644 });
    await writeUserToken({ HOME: home }, "new");
    expect(statSync(tokenFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config", "choibot")).mode & 0o777).toBe(0o700);
  });

  it("throws without HOME and never falls back to homedir()", async () => {
    expect(homedir()).not.toBe(userInfo().homedir);   // the setup guard's temp HOME
    await expect(writeUserToken({}, "t")).rejects.toThrow(CliError);
    await expect(writeUserToken({ HOME: "" }, "t")).rejects.toThrow(CliError);
    expect(existsSync(join(homedir(), ".config", "choibot", "user-token"))).toBe(false);
  });

  it("refuses an empty token", async () => {
    await expect(writeUserToken({ HOME: home }, "")).rejects.toThrow(CliError);
    expect(existsSync(tokenFile())).toBe(false);
  });
});

describe("CliError status and the long call", () => {
  it("a non-2xx answer carries status and body", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "duplicate", id: "r_1" }), { status: 409 })) as typeof fetch;
    const c = createConsoleClient({ fetch: f, env: { HOME: "/nonexistent/x", PORT: "4321" }, flags: { "user-token": "ut" }, stderrIsTTY: true, readFile: () => null });
    const e = await c.callAsUser("POST", "/api/x", {}).catch((x) => x);
    expect(e).toBeInstanceOf(CliError);
    expect(e.status).toBe(409);
    expect(e.body).toEqual({ error: "duplicate", id: "r_1" });
  });
  it("callAsUserLong uses node:http, waits for a slow answer and sends only the user header", async () => {
    const http = await import("node:http");
    let seen: any;
    const srv = http.createServer((req, res) => {
      let b = ""; req.on("data", (x) => (b += x)); req.on("end", () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(b) };
        setTimeout(() => { res.setHeader("content-type", "application/json"); res.end('{"ok":true,"n":1}'); }, 150);
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    try {
      const c = createConsoleClient({ fetch: (() => { throw new Error("global fetch used"); }) as any,
        env: { HOME: "/nonexistent/x", PORT: String(port) }, flags: { "user-token": "ut" }, stderrIsTTY: true, readFile: () => null });
      expect(await c.callAsUserLong("POST", "/api/brain/distill", { dryRun: true })).toEqual({ ok: true, n: 1 });
      expect(seen.url).toBe("/api/brain/distill");
      expect(seen.body).toEqual({ dryRun: true });
      expect(seen.headers["x-choibot-user"]).toBe("ut");
    } finally { srv.close(); }
  });
  it("callAsUserLong maps an error answer to CliError with status, and honours the total timeout", async () => {
    const http = await import("node:http");
    const srv = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/slow") return; // never answers
      res.statusCode = 503; res.end('{"error":"distill unavailable"}');
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;
    try {
      const c = createConsoleClient({ fetch: fetch, env: { HOME: "/nonexistent/x", PORT: String(port) }, flags: { "user-token": "ut" },
        stderrIsTTY: true, readFile: () => null, longTimeoutMs: 200 });
      const e = await c.callAsUserLong("POST", "/x", {}).catch((x) => x);
      expect(e.status).toBe(503);
      expect(e.message).toBe("distill unavailable");
      const t = await c.callAsUserLong("POST", "/slow", {}).catch((x) => x);
      expect(t).toBeInstanceOf(CliError);
      expect(t.message).toContain("timed out");
    } finally { srv.closeAllConnections(); srv.close(); }
  });
  it("callAsUserLong refuses port 3100 via consoleBase", () => {
    expect(() => createConsoleClient({ fetch, env: { HOME: "/x", CHIEF_TEST: "1", PORT: "3100" }, flags: {}, stderrIsTTY: true, readFile: () => null })).toThrow(CliError);
  });
});

describe("the console's own account (strong protection): its token, a short list", () => {
  const OWN = "o".repeat(43);
  it("sends the console token when it has no other identity, never with an agent marker", async () => {
    const w = world();
    const c = createConsoleClient({ fetch: w.fetch, env: envOf(), flags: {}, stderrIsTTY: false, readFile: files().readFile, consoleToken: () => OWN });
    await c.call("GET", "/api/setup/steps");
    expect(w.calls[0].headers).toEqual({ [CONSOLE_HEADER]: OWN });
    expect(await c.identity()).toBe("console");
    // An agent's env: its own headers, never the console token.
    const a = world();
    const ac = createConsoleClient({ fetch: a.fetch, env: envOf({ CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p" }), flags: {}, stderrIsTTY: false, readFile: files().readFile, consoleToken: () => OWN });
    await ac.call("GET", "/api/queue");
    expect(a.calls[0].headers).not.toHaveProperty(CONSOLE_HEADER);
    expect(consoleTokenOf(envOf({ CHOIBOT_AGENT_ID: "a1" }), () => OWN)).toBeUndefined();
  });

  it("a person's user token comes first; with neither, nothing is sent (as today)", async () => {
    const w = world();
    const c = createConsoleClient({ fetch: w.fetch, env: envOf(), flags: { "user-token": "u".repeat(43) }, stderrIsTTY: true, readFile: files().readFile, consoleToken: () => OWN });
    await c.call("GET", "/api/agents");
    expect(w.calls[0].headers).toEqual({ [USER_HEADER]: "u".repeat(43) });
    const n = world();
    const nc = createConsoleClient({ fetch: n.fetch, env: envOf(), flags: {}, stderrIsTTY: false, readFile: files().readFile, consoleToken: () => undefined });
    await nc.call("GET", "/api/agents");
    expect(n.calls[0].headers).toEqual({});
  });

  it("`brain pair` (the pairing start) sends the console token; `brain claim` sends nothing", async () => {
    const w = world();
    const c = createConsoleClient({ fetch: w.fetch, env: envOf(), flags: {}, stderrIsTTY: true, readFile: files().readFile, consoleToken: () => OWN });
    await c.callBare("POST", "/api/chief/pair/start", { label: "x" });
    await c.callBare("POST", "/api/chief/pair/claim", { code: "c" });
    expect(w.calls.map((x) => x.headers[CONSOLE_HEADER])).toEqual([OWN, undefined]);
  });

  it("reads the token file of the install's chief data folder", () => {
    const env = envOf({ CHIEF_DATA_DIR: "/srv/x/chief" });
    const seen: string[] = [];
    expect(consoleTokenOf(env, (f) => { seen.push(f); return OWN; })).toBe(OWN);
    expect(seen).toEqual(["/srv/x/chief/console-token"]);
  });
});
