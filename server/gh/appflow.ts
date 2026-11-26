// server/gh/appflow.ts — GitHub's device flow and token refresh for the ChoiBot GitHub app, with
// the app's public client id only: no client secret and no callback address. From GitHub's docs
// (read 2026-11-26), "Generating a user access token for a GitHub App" and "Refreshing user access
// tokens":
//   POST /login/device/code         client_id → device_code, user_code, verification_uri,
//                                   expires_in (default 900), interval (default 5)
//   POST /login/oauth/access_token  client_id, device_code,
//                                   grant_type=urn:ietf:params:oauth:grant-type:device_code
//                                   → access_token (ghu_, expires_in 28800), refresh_token (ghr_,
//                                   refresh_token_expires_in 15897600), or an error:
//                                   authorization_pending, slow_down (a new interval), expired_token,
//                                   access_denied, device_flow_disabled, incorrect_client_credentials,
//                                   incorrect_device_code, unsupported_grant_type
//   POST /login/oauth/access_token  client_id, grant_type=refresh_token, refresh_token; the
//                                   client_secret is "Required unless the user access token was
//                                   generated using the device flow" → a new pair, or
//                                   bad_refresh_token. The old pair stops working.
// The docs show query parameters. Here they go in a form body (the OAuth form of RFC 6749), so
// that no code and no token is ever part of a URL: the first run with the real app proves that
// GitHub takes it.
// No answer of GitHub goes into a log or an error text: only fixed words and GitHub's error code.

export const GITHUB_WEB = "https://github.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TIMEOUT_MS = 15_000;
// A token or a device code is kept only in this form: no space, no line break.
const TOKEN_RE = /^[A-Za-z0-9_]{16,255}$/;
const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{8,200}$/;
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ERROR_RE = /^[a-z_]{1,60}$/;
// One year: a longer lifetime in an answer is not believed.
const MAX_LIFE_S = 366 * 24 * 3600;

export type FlowDeps = {
  // GitHub's web address. Tests: a fake GitHub.
  base?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export type DeviceCode = { deviceCode: string; userCode: string; url: string; expiresAt: number; intervalMs: number };

// accessExpiresAt / refreshExpiresAt null: the app's tokens do not expire ("Expire user
// authorization tokens" off), so there is no refresh token either.
export type AppTokens = { accessToken: string; accessExpiresAt: number | null; refreshToken: string | null; refreshExpiresAt: number | null };

export type DeviceAnswer = { kind: "code"; code: DeviceCode } | { kind: "disabled" } | { kind: "bad-client" } | { kind: "failed"; why: string };
export type PollAnswer =
  | { kind: "token"; tokens: AppTokens }
  | { kind: "pending" }
  | { kind: "slow-down"; intervalMs: number | null }
  | { kind: "expired" }
  | { kind: "denied" }
  | { kind: "disabled" }
  | { kind: "bad-client" }
  | { kind: "failed"; why: string };
export type RefreshAnswer = { kind: "token"; tokens: AppTokens } | { kind: "revoked" } | { kind: "failed"; why: string };

type Body = Record<string, unknown>;
type Posted = { ok: true; status: number; body: Body } | { ok: false; why: string };

async function post(d: FlowDeps, path: string, params: Record<string, string>): Promise<Posted> {
  const base = d.base ?? GITHUB_WEB;
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(d.timeoutMs ?? TIMEOUT_MS),
    });
  } catch {
    return { ok: false, why: "GitHub did not answer" };
  }
  let text: string;
  try { text = await res.text(); } catch { return { ok: false, why: "GitHub's answer broke off" }; }
  const type = res.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (/json/i.test(type)) {
    try { body = JSON.parse(text); } catch { body = null; }
  } else if (/x-www-form-urlencoded/i.test(type)) {
    body = Object.fromEntries(new URLSearchParams(text));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, why: `GitHub gave an answer that is not JSON (HTTP ${res.status})` };
  return { ok: true, status: res.status, body: body as Body };
}

const errorOf = (b: Body): string | null => (typeof b.error === "string" && ERROR_RE.test(b.error) ? b.error : null);
// Whole seconds in 1..max, else null.
function seconds(v: unknown, max: number): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

// The pair in an answer, or null when the answer does not hold a usable token.
export function tokensOf(b: Body, now: number): AppTokens | null {
  if (typeof b.access_token !== "string" || !TOKEN_RE.test(b.access_token)) return null;
  const accessS = seconds(b.expires_in, MAX_LIFE_S);
  if (b.expires_in !== undefined && accessS === null) return null;
  let refreshToken: string | null = null;
  let refreshExpiresAt: number | null = null;
  if (b.refresh_token !== undefined && b.refresh_token !== "") {
    if (typeof b.refresh_token !== "string" || !TOKEN_RE.test(b.refresh_token)) return null;
    const refreshS = seconds(b.refresh_token_expires_in, MAX_LIFE_S);
    if (refreshS === null) return null;
    refreshToken = b.refresh_token;
    refreshExpiresAt = now + refreshS * 1000;
  }
  return { accessToken: b.access_token, accessExpiresAt: accessS === null ? null : now + accessS * 1000, refreshToken, refreshExpiresAt };
}

// Step 1: a device code and the code that the person enters on GitHub.
export async function requestDeviceCode(clientId: string, d: FlowDeps = {}): Promise<DeviceAnswer> {
  const now = (d.now ?? Date.now)();
  const r = await post(d, "/login/device/code", { client_id: clientId });
  if (!r.ok) return { kind: "failed", why: r.why };
  const err = errorOf(r.body);
  if (err === "device_flow_disabled") return { kind: "disabled" };
  if (err === "incorrect_client_credentials" || err === "unauthorized_client") return { kind: "bad-client" };
  if (err) return { kind: "failed", why: `GitHub said ${err}` };
  const b = r.body;
  const base = new URL(d.base ?? GITHUB_WEB);
  let url: URL | null = null;
  try { url = typeof b.verification_uri === "string" ? new URL(b.verification_uri) : null; } catch { url = null; }
  // The address to open must be GitHub's own device page.
  if (!url || url.origin !== base.origin || !url.pathname.startsWith("/login/device")) return { kind: "failed", why: "GitHub gave no device page" };
  if (typeof b.device_code !== "string" || !DEVICE_CODE_RE.test(b.device_code)) return { kind: "failed", why: "GitHub gave no device code" };
  if (typeof b.user_code !== "string" || !USER_CODE_RE.test(b.user_code)) return { kind: "failed", why: "GitHub gave no user code" };
  const expiresS = seconds(b.expires_in ?? 900, 3600) ?? 900;
  const intervalS = seconds(b.interval ?? 5, 120) ?? 5;
  return {
    kind: "code",
    code: { deviceCode: b.device_code, userCode: b.user_code, url: url.href, expiresAt: now + expiresS * 1000, intervalMs: intervalS * 1000 },
  };
}

// Step 2, once per interval: the token, or why there is none yet.
export async function pollDeviceToken(clientId: string, deviceCode: string, d: FlowDeps = {}): Promise<PollAnswer> {
  const now = (d.now ?? Date.now)();
  const r = await post(d, "/login/oauth/access_token", { client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT });
  if (!r.ok) return { kind: "failed", why: r.why };
  const err = errorOf(r.body);
  switch (err) {
    case null: {
      const tokens = tokensOf(r.body, now);
      return tokens ? { kind: "token", tokens } : { kind: "failed", why: "GitHub gave no usable token" };
    }
    case "authorization_pending": return { kind: "pending" };
    case "slow_down": {
      const s = seconds(r.body.interval, 120);
      return { kind: "slow-down", intervalMs: s === null ? null : s * 1000 };
    }
    // The docs name both spellings for a code that ran out.
    case "expired_token": case "token_expired": return { kind: "expired" };
    case "access_denied": return { kind: "denied" };
    case "device_flow_disabled": return { kind: "disabled" };
    case "incorrect_client_credentials": return { kind: "bad-client" };
    // A device code that GitHub does not know: the same end as one that ran out.
    case "incorrect_device_code": case "bad_verification_code": return { kind: "expired" };
    default: return { kind: "failed", why: `GitHub said ${err}` };
  }
}

// A new pair for the refresh token. "revoked": GitHub refuses this refresh token for good
// (it ran out, it was used, or the person revoked the app): the person must connect again.
export async function refreshTokens(clientId: string, refreshToken: string, d: FlowDeps = {}): Promise<RefreshAnswer> {
  const now = (d.now ?? Date.now)();
  const r = await post(d, "/login/oauth/access_token", { client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
  if (!r.ok) return { kind: "failed", why: r.why };
  const err = errorOf(r.body);
  if (err === "bad_refresh_token") return { kind: "revoked" };
  if (err) return { kind: "failed", why: `GitHub said ${err}` };
  const tokens = tokensOf(r.body, now);
  return tokens ? { kind: "token", tokens } : { kind: "failed", why: "GitHub gave no usable token" };
}
