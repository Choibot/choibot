// server/gh/applogin.test.ts — the app login against a fake GitHub (testkit.ts) with the real
// flow client and the real token file: the code on the page, a slow down, a code that runs out,
// a "no" on GitHub, the refresh before use (one at a time), a refresh that GitHub refuses and one
// that fails.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GithubApp, REFRESH_BEFORE_MS, REFRESH_RETRY_MS, githubFlow } from "./applogin.js";
import { TokenFile } from "./appstore.js";
import { FAKE_ACCESS, FAKE_REFRESH, deviceCode, fakeGithub, oauthError, tokenPair, type FakeGithub } from "./testkit.js";

const CLIENT = "Iv23liFAKEclient01";
const NEW_ACCESS = "ghu_FAKErefreshed0000000000000000000";
const NEW_REFRESH = "ghr_FAKErefreshed00000000000000000000000000000000000000000000000000000000";
let gh: FakeGithub;
let root: string;
let clock: number;
let logs: string[];
let sleeps: number[];
beforeEach(async () => {
  gh = await fakeGithub();
  root = mkdtempSync(join(tmpdir(), "gh-applogin-"));
  clock = 1_800_000_000_000;
  logs = [];
  sleeps = [];
});
afterEach(async () => { await gh.close(); rmSync(root, { recursive: true, force: true }); });

function make(o: { clientId?: string; onDone?: () => void } = {}) {
  const store = new TokenFile(join(root, "github-app"), (s) => logs.push(s));
  // Each wait moves the clock; it does not wait.
  const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
  const app = new GithubApp({
    clientId: o.clientId ?? CLIENT, store, flow: githubFlow({ base: gh.base, now: () => clock }),
    now: () => clock, sleep, log: (s) => logs.push(s), ...(o.onDone ? { onDone: o.onDone } : {}),
  });
  return { app, store };
}
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };
const tokenCalls = () => gh.requests.filter((r) => r.path === "/login/oauth/access_token");

describe("GithubApp login", () => {
  it("shows the code, waits through pending and slow_down, then stores the pair", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    gh.answer("/login/oauth/access_token", oauthError("authorization_pending"), oauthError("slow_down", { interval: 10 }), tokenPair());
    let done = 0;
    const { app, store } = make({ onDone: () => done++ });
    const s = await app.start();
    expect(s).toEqual({ state: "waiting", code: "WDJB-MJHT", url: `${gh.base}/login/device`, expiresAt: 1_800_000_000_000 + 900_000 });
    await until(() => app.loginState().state === "done");
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);
    expect(done).toBe(1);
    expect(await store.read()).toMatchObject({ clientId: CLIENT, accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH });
    // The pair came at the third poll, 20 seconds after the start: the clock now.
    expect(await app.tokenState()).toEqual({ state: "ok", accessExpiresAt: clock + 28_800_000, refreshExpiresAt: clock + 15_897_600_000 });
    expect(await app.token()).toBe(FAKE_ACCESS);
    expect(logs.join("\n")).not.toMatch(/gh[ur]_|WDJB/);
  });

  it("adds 5 seconds on a slow_down with no interval", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    gh.answer("/login/oauth/access_token", oauthError("slow_down"), tokenPair());
    const { app } = make();
    await app.start();
    await until(() => app.loginState().state === "done");
    expect(sleeps).toEqual([5_000, 10_000]);
  });

  it("ends with expired when the code runs out, and with denied on a no", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5, expiresIn: 12 }));
    gh.answer("/login/oauth/access_token", oauthError("authorization_pending"));
    const a = make().app;
    await a.start();
    await until(() => a.loginState().state === "failed");
    expect(a.loginState()).toEqual({ state: "failed", reason: "expired" });

    gh.answer("/login/device/code", deviceCode(gh.base));
    gh.answer("/login/oauth/access_token", oauthError("access_denied"));
    const b = make().app;
    await b.start();
    await until(() => b.loginState().state === "failed");
    expect(b.loginState()).toEqual({ state: "failed", reason: "denied" });
    expect(await b.token()).toBeNull();
  });

  it("says disabled and bad-client from the first answer", async () => {
    gh.answer("/login/device/code", oauthError("device_flow_disabled"));
    expect(await make().app.start()).toEqual({ state: "failed", reason: "disabled" });
    gh.answer("/login/device/code", oauthError("incorrect_client_credentials"));
    expect(await make().app.start()).toEqual({ state: "failed", reason: "bad-client" });
  });

  it("gives the login that runs; fresh starts a new code and the old loop stops", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base));
    gh.answer("/login/oauth/access_token", oauthError("authorization_pending"));
    const { app } = make();
    await app.start();
    await app.start();
    expect(gh.requests.filter((r) => r.path === "/login/device/code")).toHaveLength(1);
    await app.start({ fresh: true });
    expect(gh.requests.filter((r) => r.path === "/login/device/code")).toHaveLength(2);
    app.stop();
    expect(app.loginState()).toEqual({ state: "idle" });
  });
});

describe("GithubApp token", () => {
  async function connected() {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    gh.answer("/login/oauth/access_token", tokenPair());
    const m = make();
    await m.app.start();
    await until(() => m.app.loginState().state === "done");
    gh.requests.length = 0;
    return m;
  }

  it("refreshes once, before use, when less than 30 minutes are left", async () => {
    const { app, store } = await connected();
    clock += 28_800_000 - REFRESH_BEFORE_MS + 1_000;
    gh.answer("/login/oauth/access_token", tokenPair({ access: NEW_ACCESS, refresh: NEW_REFRESH }));
    // Two calls at the same time: one refresh (GitHub ends the old pair at the first one).
    const [a, b] = await Promise.all([app.token(), app.token()]);
    expect([a, b]).toEqual([NEW_ACCESS, NEW_ACCESS]);
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0].form).toEqual({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: FAKE_REFRESH });
    expect(await store.read()).toMatchObject({ accessToken: NEW_ACCESS, refreshToken: NEW_REFRESH });
    // A new process reads the new pair.
    expect(await make().app.token()).toBe(NEW_ACCESS);
  });

  it("a refresh that GitHub refuses ends the login: no token, the file is gone", async () => {
    const { app, store } = await connected();
    clock += 28_800_000;
    gh.answer("/login/oauth/access_token", oauthError("bad_refresh_token"));
    expect(await app.token()).toBeNull();
    expect(await app.tokenState()).toEqual({ state: "signed-out", why: "refused" });
    expect(await store.read()).toBeNull();
    expect(logs.join("\n")).toMatch(/connect the app again/);
  });

  it("a refresh that fails keeps the old token while it lasts, and waits before the next try", async () => {
    const { app } = await connected();
    clock += 28_800_000 - REFRESH_BEFORE_MS + 1_000;
    gh.answer("/login/oauth/access_token", { status: 503, type: "text/plain", body: "down" });
    expect(await app.token()).toBe(FAKE_ACCESS);
    expect(await app.token()).toBe(FAKE_ACCESS);
    expect(tokenCalls()).toHaveLength(1);
    clock += REFRESH_RETRY_MS;
    gh.answer("/login/oauth/access_token", tokenPair({ access: NEW_ACCESS, refresh: NEW_REFRESH }));
    expect(await app.token()).toBe(NEW_ACCESS);
    expect(tokenCalls()).toHaveLength(2);
  });

  it("gives no token that has ended when the refresh fails", async () => {
    const { app } = await connected();
    clock += 28_800_000;
    gh.answer("/login/oauth/access_token", { status: 503, type: "text/plain", body: "down" });
    expect(await app.token()).toBeNull();
  });

  it("never uses a stored pair of another client id", async () => {
    await connected();
    const other = make({ clientId: "Iv23liOTHERclient9" }).app;
    expect(await other.token()).toBeNull();
    expect(await other.tokenState()).toEqual({ state: "none" });
  });

  it("disconnect removes the pair from this server", async () => {
    const { app, store } = await connected();
    await app.disconnect();
    expect(await store.read()).toBeNull();
    expect(await app.token()).toBeNull();
    expect(await app.tokenState()).toEqual({ state: "none" });
  });
});

describe("GithubApp token: a new pair that cannot be stored", () => {
  it("works until a restart (unsaved); then GitHub refuses the old pair: signed-out, why refused", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    gh.answer("/login/oauth/access_token", tokenPair());
    const file = new TokenFile(join(root, "github-app"), (s) => logs.push(s));
    let writes = 0;
    // The first write (the login) works; the second (the refresh) fails.
    const store = { read: () => file.read(), remove: () => file.remove(), write: async (t: Parameters<TokenFile["write"]>[0]) => { if (++writes > 1) throw new Error("disk full"); await file.write(t); } };
    const sleep = async (ms: number) => { clock += ms; };
    const mk = () => new GithubApp({ clientId: CLIENT, store, flow: githubFlow({ base: gh.base, now: () => clock }), now: () => clock, sleep, log: (s) => logs.push(s) });
    const app = mk();
    await app.start();
    await until(() => app.loginState().state === "done");

    clock += 28_800_000 - REFRESH_BEFORE_MS + 1_000;
    gh.answer("/login/oauth/access_token", tokenPair({ access: NEW_ACCESS, refresh: NEW_REFRESH }));
    expect(await app.token()).toBe(NEW_ACCESS);
    expect(await app.tokenState()).toMatchObject({ state: "ok", unsaved: true });
    expect(logs.join("\n")).toMatch(/until a restart/);

    // A restart: the file holds the old pair, whose refresh token GitHub ended.
    const again = mk();
    gh.answer("/login/oauth/access_token", oauthError("bad_refresh_token"));
    expect(await again.token()).toBeNull();
    expect(await again.tokenState()).toEqual({ state: "signed-out", why: "refused" });
  });

  it("both ends passed: signed-out, why ended", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    gh.answer("/login/oauth/access_token", tokenPair());
    const { app } = make();
    await app.start();
    await until(() => app.loginState().state === "done");
    clock += 15_897_600_000 + 1;
    expect(await app.tokenState()).toEqual({ state: "signed-out", why: "ended" });
  });
});

describe("GithubApp login: the log", () => {
  it("one line for each change of GitHub's answer, never one for each check, and no code or token", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 5 }));
    const down = { status: 502, type: "text/plain", body: "bad gateway" };
    gh.answer("/login/oauth/access_token",
      oauthError("authorization_pending"), oauthError("slow_down", { interval: 10 }), oauthError("slow_down", { interval: 10 }),
      down, down, oauthError("authorization_pending"), oauthError("authorization_pending"), tokenPair());
    const { app } = make();
    await app.start();
    await until(() => app.loginState().state === "done");
    expect(logs).toEqual([
      "[github] app login started",
      "[github] app login the code is on the page",
      "[github] app login GitHub asks for slower checks: one in 10 s",
      "[github] app login a check failed (GitHub gave an answer that is not JSON (HTTP 502)): the next one in 10 s",
      "[github] app login GitHub answers again: it waits for the approval",
      "[github] app login approved on GitHub: the key is saved",
    ]);
    expect(logs.join("\n")).not.toMatch(/gh[ur]_|WDJB|3584d8|bad gateway/);
  });

  it("a code that runs out and a no on GitHub each end with one line", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base));
    gh.answer("/login/oauth/access_token", oauthError("access_denied"));
    const { app } = make();
    await app.start();
    await until(() => app.loginState().state === "failed");
    expect(logs.at(-1)).toBe("[github] app login ended: denied");
  });
});
