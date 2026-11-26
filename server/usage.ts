// server/usage.ts
//
// Subscription usage readout for every runtime the console hosts. Agents bill
// against the box's own subscription logins — Claude Code's (see
// server/agents/terminal.ts, where ANTHROPIC_API_KEY is deliberately unset) and,
// for Codex agents, ChatGPT's — so "how much of my plan is left" is account-wide,
// not per-agent. The two sources are read independently and merged into one
// windows[] (see mergeUsage below), and either can be missing: a box with no
// Codex shows exactly the Claude windows, and vice versa.
//
// The Claude half surfaces the same numbers the `claude` /usage command shows;
// the ChatGPT half lives in agents/runtimes/codex-usage.ts.
//
// Source: GET https://api.anthropic.com/api/oauth/usage, authorized with the
// OAuth access token that `claude` keeps fresh in ~/.claude/.credentials.json.
// This endpoint is UNDOCUMENTED/internal — it can change without notice, so every
// path here degrades to { ok:false } and never throws. The widget treats that as
// "usage unavailable" and the rest of the console is unaffected.
//
// The response's authoritative field is `limits[]` (the flat five_hour/seven_day_*
// fields are legacy and go null as models are scoped), so we render whatever
// windows it returns — Fable today, Opus/Sonnet/whatever tomorrow — with no code
// change. That same property is what lets the Codex windows simply be appended:
// the widget renders whatever it is handed, so a second subscription needed no
// UI change at all.
import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexUsageWindows } from "./agents/runtimes/codex-usage.js";
import { accessTokenFor, listAccounts, type AccountInfo } from "./agents/accounts.js";
import { resolveClaudeBin } from "./defaults.js";

const execFileP = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// The address of the usage read. A test instance (CHIEF_TEST=1, scripts/chief-instance.sh) may
// give a fake on the server itself with CHIEF_TEST_USAGE_API: a loopback http origin only,
// because the login's token goes there. Every other console reads Anthropic.
export function usageUrl(env: Record<string, string | undefined> = process.env): string {
  const v = (env.CHIEF_TEST_USAGE_API ?? "").trim();
  return env.CHIEF_TEST === "1" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(v) ? `${v}/api/oauth/usage` : USAGE_URL;
}
const OAUTH_BETA = "oauth-2025-04-20";
// The endpoint 429s hard without a claude-code User-Agent. Anthropic asks for a
// polite ~180s floor between calls; we cache well above the UI's poll rate.
const OK_TTL_MS = 180_000;
const FAIL_TTL_MS = 30_000;

export type UsageWindow = {
  key: string; // stable id for React keys / dedupe: "session" | "weekly:all" | "weekly:<model>"
  label: string; // display: "Session", "Week", "Week · Fable"
  group: "session" | "weekly";
  percent: number; // 0..100, rounded
  severity: "normal" | "warning" | "critical";
  resetsAt: string | null; // ISO 8601
  active: boolean; // the currently-binding window, per the API's is_active
  // Which login the window belongs to, set only when more than one Claude
  // account is configured (accounts.ts): the meter then groups by it. Absent on
  // a single-login box, so the widget reads exactly as it did before accounts.
  account?: string;
};
export type UsageResult =
  | { ok: true; windows: UsageWindow[] }
  | { ok: false; reason: string };

// ── Pure normalizer (unit-tested) ───────────────────────────────────────────
// Maps the raw endpoint payload to a stable, display-ready shape. Prefers the
// forward-compatible `limits[]` array; falls back to the legacy flat fields only
// if `limits` is absent, so the widget still works on an older response shape.
export function normalizeUsage(raw: unknown): UsageResult {
  const r = raw as Record<string, any> | null | undefined;
  if (!r || typeof r !== "object") return { ok: false, reason: "empty" };

  const entries = Array.isArray(r.limits) && r.limits.length
    ? r.limits.map(fromLimit)
    : fromLegacy(r);

  const windows = entries.filter((w): w is UsageWindow => w !== null).sort(byOrder);
  if (!windows.length) return { ok: false, reason: "no-windows" };
  return { ok: true, windows };
}

function fromLimit(lim: Record<string, any>): UsageWindow | null {
  if (!lim || typeof lim !== "object") return null;
  const kind = String(lim.kind ?? "");
  const model =
    lim.scope && lim.scope.model && typeof lim.scope.model.display_name === "string"
      ? lim.scope.model.display_name
      : null;

  let key: string, label: string, group: "session" | "weekly";
  if (kind === "session") {
    key = "session"; label = "Session"; group = "session";
  } else if (kind === "weekly_all") {
    key = "weekly:all"; label = "Week"; group = "weekly";
  } else if (kind === "weekly_scoped") {
    key = `weekly:${model ?? "scoped"}`;
    label = model ? `Week · ${model}` : "Week · scoped";
    group = "weekly";
  } else {
    // Unknown kind: keep it rather than drop it, so a new window type still shows.
    key = model ? `${kind}:${model}` : kind || "unknown";
    label = model ?? humanize(kind);
    group = String(lim.group) === "session" ? "session" : "weekly";
  }

  return {
    key, label, group,
    percent: clampPct(lim.percent),
    severity: severityOf(lim.severity, lim.percent),
    resetsAt: typeof lim.resets_at === "string" ? lim.resets_at : null,
    active: Boolean(lim.is_active),
  };
}

// Legacy shape: build Session + Week from the flat five_hour/seven_day objects.
function fromLegacy(r: Record<string, any>): (UsageWindow | null)[] {
  const mk = (
    obj: any, key: string, label: string, group: "session" | "weekly",
  ): UsageWindow | null => {
    if (!obj || typeof obj !== "object" || obj.utilization == null) return null;
    return {
      key, label, group,
      percent: clampPct(obj.utilization),
      severity: severityOf(undefined, obj.utilization),
      resetsAt: typeof obj.resets_at === "string" ? obj.resets_at : null,
      active: false,
    };
  };
  return [
    mk(r.five_hour, "session", "Session", "session"),
    mk(r.seven_day, "weekly:all", "Week", "weekly"),
  ];
}

function clampPct(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Trust the API's severity when it's one we know; otherwise derive from percent
// so an unfamiliar/blank severity still colors sensibly.
function severityOf(sev: unknown, pct: unknown): UsageWindow["severity"] {
  const s = String(sev ?? "").toLowerCase();
  if (s === "critical") return "critical";
  if (s === "warning" || s === "warn") return "warning";
  if (s === "normal" || s === "ok") return "normal";
  const n = Number(pct);
  if (Number.isFinite(n)) {
    if (n >= 90) return "critical";
    if (n >= 75) return "warning";
  }
  return "normal";
}

function humanize(kind: string): string {
  return kind ? kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Usage";
}

// Session first, then weekly; within weekly show "all" before scoped, and scoped
// by descending pressure so the window nearest its cap leads.
function byOrder(a: UsageWindow, b: UsageWindow): number {
  const g = (w: UsageWindow) => (w.group === "session" ? 0 : 1);
  if (g(a) !== g(b)) return g(a) - g(b);
  const wk = (w: UsageWindow) => (w.key === "weekly:all" ? 0 : 1);
  if (wk(a) !== wk(b)) return wk(a) - wk(b);
  return b.percent - a.percent;
}

// ── Live fetch (cached) ──────────────────────────────────────────────────────
let cache: { at: number; value: UsageResult } | null = null;
let uaCache: string | null = null;

async function userAgent(): Promise<string> {
  if (uaCache) return uaCache;
  const bin = resolveClaudeBin();
  try {
    const { stdout } = await execFileP(bin, ["--version"], { timeout: 4000 });
    const v = stdout.match(/\d+\.\d+\.\d+/)?.[0];
    uaCache = `claude-code/${v ?? "2.1.203"}`;
  } catch {
    uaCache = "claude-code/2.1.203";
  }
  return uaCache;
}

// One Claude login's windows, tagged with the account label and keyed so two
// accounts' "session" windows never collide. Accounts that are not logged in
// contribute nothing: they have no token, and showing an "unavailable" row per
// pending login would bury the real meters.
export function tagAccount(result: UsageResult, account: AccountInfo, tag: boolean): UsageWindow[] {
  if (!result.ok) return [];
  if (!tag) return result.windows;
  return result.windows.map((w) => ({ ...w, key: `${account.id}/${w.key}`, account: account.label }));
}

// Every configured login's windows in one list, default account first. ok:false
// only when NO account produced windows — and then with the default account's
// reason, which is the one the owner can act on.
export function mergeAccounts(results: { account: AccountInfo; result: UsageResult }[]): UsageResult {
  const tag = results.length > 1;
  const windows = results.flatMap((r) => tagAccount(r.result, r.account, tag));
  if (windows.length) return { ok: true, windows };
  const first = results[0]?.result;
  return first && !first.ok ? first : { ok: false, reason: "no-windows" };
}

// Both runtimes bill against their own subscription, and the meter is
// account-wide, so the two window lists concatenate. Claude leads because it is
// the default runtime; a failure on either side degrades to the other's windows
// rather than blanking the strip.
export function mergeUsage(claude: UsageResult, codex: UsageWindow[]): UsageResult {
  if (!codex.length) return claude;
  const windows = [...(claude.ok ? claude.windows : []), ...codex];
  if (!windows.length) return claude.ok ? { ok: false, reason: "no-windows" } : claude;
  return { ok: true, windows };
}

// One refresh at a time, shared by every caller that misses the cache. The
// cache is only written once both sources settle, so N concurrent cold-cache
// requests would otherwise each start their own — which used to mean N HTTP
// calls and now also means N `codex app-server` processes. It matters most in
// the failure case: FAIL_TTL_MS is 30s, so a Claude outage puts the UI's poll
// straight through to a spawn six times more often than a healthy one does.
let inflight: Promise<UsageResult> | null = null;

export async function getUsage(): Promise<UsageResult> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.value.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
    return cache.value;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      // Independent sources, so neither waits on the other; both resolve rather
      // than reject, which is what keeps Promise.all safe here.
      const [claude, codex] = await Promise.all([fetchAllAccounts(), codexUsageWindows()]);
      const value = mergeUsage(claude, codex);
      // Stamped with the time the refresh STARTED, so a slow fetch cannot extend
      // the TTL past what a caller was told to expect.
      cache = { at: now, value };
      return value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// The last answer that is kept, of any age, with no wait: for a caller that must answer at
// once (the list of logins, the pick of a login for a new agent). It starts a new read when
// the kept one is old, so the next call has a newer one. Null: nothing was read yet.
export function peekUsage(): UsageResult | null {
  void getUsage().catch(() => {});
  return cache?.value ?? null;
}

// For a caller that can wait a short time (the pick of a login for a new agent): a new read
// when the kept answer is old, but never longer than `ms`. After that time, or when the read
// fails: the kept answer, of any age. Null: nothing was read yet.
export async function usageWithin(ms: number): Promise<UsageResult | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getUsage(),
      new Promise<UsageResult | null>((r) => { timer = setTimeout(() => r(cache?.value ?? null), ms); }),
    ]);
  } catch {
    return cache?.value ?? null;
  } finally {
    clearTimeout(timer);
  }
}

// Each login is its own subscription, so each gets its own call. Read the token
// fresh each time: a live agent on that account keeps it rotated on disk, so we
// never manage refresh ourselves.
async function fetchAllAccounts(): Promise<UsageResult> {
  let accounts: AccountInfo[];
  try { accounts = await listAccounts(); } catch { return { ok: false, reason: "no-credentials" }; }
  const results = await Promise.all(accounts.map(async (account) => ({
    account, result: await fetchUsage(await accessTokenFor(account.id)),
  })));
  return mergeAccounts(results);
}

async function fetchUsage(token: string | null): Promise<UsageResult> {
  if (!token) return { ok: false, reason: "no-credentials" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(usageUrl(), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "user-agent": await userAgent(),
        "content-type": "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return normalizeUsage(await res.json());
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

// Registered after registerAuth() in server/index.ts, so the session cookie gates
// it — usage is only ever exposed to the console owner. Always 200 with an `ok`
// flag; the client renders "unavailable" rather than erroring on failure.
export function registerUsageApi(app: FastifyInstance): void {
  app.get("/api/usage", async () => getUsage());
}
