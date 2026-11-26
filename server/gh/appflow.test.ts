// server/gh/appflow.test.ts — GitHub's device flow and refresh with the client id only, against
// a fake GitHub (testkit.ts): what is sent (a form body, never a code or a token in the URL, no
// client secret) and how each answer of GitHub's docs is read.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollDeviceToken, refreshTokens, requestDeviceCode, tokensOf } from "./appflow.js";
import { FAKE_ACCESS, FAKE_REFRESH, deviceCode, fakeGithub, oauthError, tokenPair, type FakeGithub } from "./testkit.js";

const CLIENT = "Iv23liFAKEclient01";
const NOW = 1_800_000_000_000;
let gh: FakeGithub;
beforeEach(async () => { gh = await fakeGithub(); });
afterEach(async () => { await gh.close(); });
const deps = () => ({ base: gh.base, now: () => NOW });

describe("requestDeviceCode", () => {
  it("sends the client id in a form body and reads the code, the page, the end and the interval", async () => {
    gh.answer("/login/device/code", deviceCode(gh.base, { interval: 7 }));
    const a = await requestDeviceCode(CLIENT, deps());
    expect(a).toEqual({ kind: "code", code: {
      deviceCode: "3584d83530557fdd1f46af8289938c8ef79f9dc5", userCode: "WDJB-MJHT",
      url: `${gh.base}/login/device`, expiresAt: NOW + 900_000, intervalMs: 7_000,
    } });
    const r = gh.requests[0];
    expect(r.method).toBe("POST");
    expect(r.query).toBe("");
    expect(r.form).toEqual({ client_id: CLIENT });
    expect(r.headers.accept).toBe("application/json");
    expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("refuses a device page that is not GitHub's own", async () => {
    gh.answer("/login/device/code", { body: { ...(deviceCode(gh.base).body as object), verification_uri: "https://evil.example/login/device" } });
    expect(await requestDeviceCode(CLIENT, deps())).toEqual({ kind: "failed", why: "GitHub gave no device page" });
  });

  it("reads device_flow_disabled, a wrong client id and an answer that is not JSON", async () => {
    gh.answer("/login/device/code", oauthError("device_flow_disabled"));
    expect(await requestDeviceCode(CLIENT, deps())).toEqual({ kind: "disabled" });
    gh.answer("/login/device/code", oauthError("incorrect_client_credentials"));
    expect(await requestDeviceCode(CLIENT, deps())).toEqual({ kind: "bad-client" });
    gh.answer("/login/device/code", { status: 502, type: "text/html", body: "<html>bad gateway</html>" });
    expect(await requestDeviceCode(CLIENT, deps())).toEqual({ kind: "failed", why: "GitHub gave an answer that is not JSON (HTTP 502)" });
  });

  it("says so when GitHub does not answer, with no text of the cause", async () => {
    const base = gh.base;
    await gh.close();
    expect(await requestDeviceCode(CLIENT, { base, timeoutMs: 2_000 })).toEqual({ kind: "failed", why: "GitHub did not answer" });
    gh = await fakeGithub();
  });
});

describe("pollDeviceToken", () => {
  it("sends the device grant and reads the pair with its two ends", async () => {
    gh.answer("/login/oauth/access_token", tokenPair());
    const a = await pollDeviceToken(CLIENT, "3584d83530557fdd1f46af8289938c8ef79f9dc5", deps());
    expect(a).toEqual({ kind: "token", tokens: {
      accessToken: FAKE_ACCESS, accessExpiresAt: NOW + 28_800_000, refreshToken: FAKE_REFRESH, refreshExpiresAt: NOW + 15_897_600_000,
    } });
    expect(gh.requests[0].query).toBe("");
    expect(gh.requests[0].form).toEqual({
      client_id: CLIENT, device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5", grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(gh.requests[0].form.client_secret).toBeUndefined();
  });

  it("reads each error of the docs' table", async () => {
    const cases: [string, Record<string, unknown>, unknown][] = [
      ["authorization_pending", {}, { kind: "pending" }],
      ["slow_down", { interval: 10 }, { kind: "slow-down", intervalMs: 10_000 }],
      ["slow_down", {}, { kind: "slow-down", intervalMs: null }],
      ["expired_token", {}, { kind: "expired" }],
      ["token_expired", {}, { kind: "expired" }],
      ["incorrect_device_code", {}, { kind: "expired" }],
      ["bad_verification_code", {}, { kind: "expired" }],
      ["access_denied", {}, { kind: "denied" }],
      ["device_flow_disabled", {}, { kind: "disabled" }],
      ["incorrect_client_credentials", {}, { kind: "bad-client" }],
      ["unsupported_grant_type", {}, { kind: "failed", why: "GitHub said unsupported_grant_type" }],
    ];
    for (const [error, extra, want] of cases) {
      gh.answer("/login/oauth/access_token", oauthError(error, extra));
      expect(await pollDeviceToken(CLIENT, "3584d83530557fdd1f46af8289938c8ef79f9dc5", deps())).toEqual(want);
    }
  });

  it("reads a form answer too (no Accept: JSON on GitHub's side)", async () => {
    gh.answer("/login/oauth/access_token", { type: "application/x-www-form-urlencoded", body: "error=authorization_pending&error_description=x" });
    expect(await pollDeviceToken(CLIENT, "3584d83530557fdd1f46af8289938c8ef79f9dc5", deps())).toEqual({ kind: "pending" });
  });
});

describe("refreshTokens", () => {
  it("sends the refresh grant with the client id and no secret, and reads the new pair", async () => {
    gh.answer("/login/oauth/access_token", tokenPair({ access: "ghu_FAKEnew000000000000000000000000000" }));
    const a = await refreshTokens(CLIENT, FAKE_REFRESH, deps());
    expect(a).toMatchObject({ kind: "token", tokens: { accessToken: "ghu_FAKEnew000000000000000000000000000" } });
    expect(gh.requests[0].query).toBe("");
    expect(gh.requests[0].form).toEqual({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: FAKE_REFRESH });
  });

  it("bad_refresh_token is the end of the login; any other failure is not", async () => {
    gh.answer("/login/oauth/access_token", oauthError("bad_refresh_token"));
    expect(await refreshTokens(CLIENT, FAKE_REFRESH, deps())).toEqual({ kind: "revoked" });
    gh.answer("/login/oauth/access_token", { status: 500, type: "text/plain", body: "oops" });
    expect(await refreshTokens(CLIENT, FAKE_REFRESH, deps())).toEqual({ kind: "failed", why: "GitHub gave an answer that is not JSON (HTTP 500)" });
  });
});

describe("tokensOf", () => {
  it("takes a pair with no ends (the app's tokens do not expire)", () => {
    expect(tokensOf({ access_token: FAKE_ACCESS, scope: "", token_type: "bearer" }, NOW)).toEqual({
      accessToken: FAKE_ACCESS, accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null,
    });
  });
  it("refuses a token with a space or a line break, and a refresh token with no end", () => {
    expect(tokensOf({ access_token: "ghu_abc def000000000000000" }, NOW)).toBeNull();
    expect(tokensOf({ access_token: `${FAKE_ACCESS}\nX=1` }, NOW)).toBeNull();
    expect(tokensOf({ access_token: FAKE_ACCESS, expires_in: 28800, refresh_token: FAKE_REFRESH }, NOW)).toBeNull();
    expect(tokensOf({ access_token: FAKE_ACCESS, expires_in: -1 }, NOW)).toBeNull();
  });
});
