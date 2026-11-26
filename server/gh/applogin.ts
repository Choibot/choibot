// server/gh/applogin.ts — the ChoiBot GitHub app login of the console (PR 1 of the GitHub app
// plan): the device flow with the app's public client id, the stored pair (appstore.ts) and its
// refresh. GitHub's facts are in appflow.ts. Nothing here runs by itself: only start() starts a
// login, and only token() refreshes, when a console call asks for the token.
//
// One login at a time, kept in this process (a page that closes and comes back gets the same
// code). The browser gets the code, the address and the time that is left: never a token.
// One refresh at a time: GitHub ends the old pair when it gives a new one, so a second refresh
// with the same refresh token would fail.
import { pollDeviceToken, refreshTokens, requestDeviceCode, type AppTokens, type DeviceAnswer, type FlowDeps, type PollAnswer, type RefreshAnswer } from "./appflow.js";
import type { StoredTokens, TokenStore } from "./appstore.js";

// expired: the code ran out. denied: the person said no on GitHub. disabled: the app has no
// device flow. bad-client: GitHub does not know the client id. no-answer: GitHub is not
// reachable. failed: all else.
export type AppLoginReason = "expired" | "denied" | "disabled" | "bad-client" | "no-answer" | "failed";

export type AppLoginState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "waiting"; code: string; url: string; expiresAt: number }
  | { state: "done" }
  | { state: "failed"; reason: AppLoginReason };

// none: no token. ok: a token, with the times; unsaved: GitHub gave a new pair at a refresh and
// the server could not store it, so it lives in this process only (GitHub ended the old pair:
// after a restart the person connects again). signed-out: the person connects again, because
// GitHub refused the refresh (why "refused": the app was revoked, the refresh token ran out, or
// it was the old pair of a refresh that could not be stored), or because both ends have passed
// (why "ended").
export type AppTokenState =
  | { state: "none" }
  | { state: "ok"; accessExpiresAt: number | null; refreshExpiresAt: number | null; unsaved?: true }
  | { state: "signed-out"; why: "refused" | "ended" };

// A token with less than this left is refreshed before use.
export const REFRESH_BEFORE_MS = 30 * 60_000;
// A token with less than this left is not given to a call.
const USE_MARGIN_MS = 60_000;
// After a refresh that failed (GitHub did not answer), the next try waits this long.
export const REFRESH_RETRY_MS = 60_000;
// Polls in a row that fail (GitHub does not answer) before the login stops.
const POLL_FAILS = 5;

export type Flow = {
  requestDeviceCode(clientId: string): Promise<DeviceAnswer>;
  pollDeviceToken(clientId: string, deviceCode: string): Promise<PollAnswer>;
  refreshTokens(clientId: string, refreshToken: string): Promise<RefreshAnswer>;
};

export function githubFlow(d: FlowDeps = {}): Flow {
  return {
    requestDeviceCode: (c) => requestDeviceCode(c, d),
    pollDeviceToken: (c, code) => pollDeviceToken(c, code, d),
    refreshTokens: (c, r) => refreshTokens(c, r, d),
  };
}

export type GithubAppDeps = {
  clientId: string;
  store: TokenStore;
  flow?: Flow;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  // A login ended well and its pair is stored.
  onDone?: () => void;
  log?: (s: string) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export class GithubApp {
  private st: AppLoginState = { state: "idle" };
  // Each login has its own number: an older loop never changes the state.
  private run = 0;
  private kept: StoredTokens | null | undefined = undefined;
  private signedOut = false;
  // The kept pair is not in the store (its write failed after a refresh).
  private unsaved = false;
  private refreshing: Promise<string | null> | null = null;
  private retryAt = 0;
  private readonly flow: Flow;
  private readonly now: () => number;

  constructor(private readonly d: GithubAppDeps) {
    this.flow = d.flow ?? githubFlow();
    this.now = d.now ?? Date.now;
  }

  loginState(): AppLoginState { return this.st; }

  // Starts a login, or gives the one that runs. `fresh`: stop it and start a new one (a new code).
  async start(o: { fresh?: boolean } = {}): Promise<AppLoginState> {
    if ((this.st.state === "starting" || this.st.state === "waiting") && !o.fresh) return this.st;
    const mine = ++this.run;
    this.st = { state: "starting" };
    this.log("started");
    const a = await this.flow.requestDeviceCode(this.d.clientId);
    if (mine !== this.run) return this.st;
    if (a.kind !== "code") return this.fail(a.kind === "failed" ? "no-answer" : a.kind);
    this.st = { state: "waiting", code: a.code.userCode, url: a.code.url, expiresAt: a.code.expiresAt };
    this.log("the code is on the page");
    void this.poll(mine, a.code.deviceCode, a.code.intervalMs, a.code.expiresAt);
    return this.st;
  }

  // Stops the login that runs (the server stops, or the page asks for a new code).
  stop(): void {
    this.run++;
    if (this.st.state === "starting" || this.st.state === "waiting") this.st = { state: "idle" };
  }

  // One log line for each CHANGE of what GitHub answers to the polls, never one for each poll: a
  // wait that goes wrong shows in the log. Fixed words, GitHub's error word and an HTTP status
  // only (appflow.ts): never a code, a token or a body.
  private async poll(mine: number, deviceCode: string, intervalMs: number, expiresAt: number): Promise<void> {
    const sleep = this.d.sleep ?? defaultSleep;
    let wait = intervalMs;
    let fails = 0;
    let said = "waiting";
    const tell = (now: string, line: string) => { if (now !== said) { said = now; this.log(line); } };
    for (;;) {
      await sleep(wait);
      if (mine !== this.run) return;
      if (this.now() >= expiresAt) { this.fail("expired"); return; }
      const a = await this.flow.pollDeviceToken(this.d.clientId, deviceCode);
      if (mine !== this.run) return;
      switch (a.kind) {
        case "pending": fails = 0; tell("waiting", "GitHub answers again: it waits for the approval"); continue;
        // GitHub adds 5 seconds and says the new interval.
        case "slow-down": {
          fails = 0;
          wait = a.intervalMs ?? wait + 5_000;
          tell(`slow-${wait}`, `GitHub asks for slower checks: one in ${Math.round(wait / 1000)} s`);
          continue;
        }
        case "failed": {
          tell(`failed-${a.why}`, `a check failed (${a.why}): the next one in ${Math.round(wait / 1000)} s`);
          if (++fails >= POLL_FAILS) { this.fail("no-answer"); return; }
          continue;
        }
        case "token": {
          try {
            await this.save(a.tokens);
          } catch {
            this.log("the token could not be stored");
            this.fail("failed");
            return;
          }
          if (mine !== this.run) return;
          this.st = { state: "done" };
          this.log("approved on GitHub: the key is saved");
          this.d.onDone?.();
          return;
        }
        default: this.fail(a.kind); return;
      }
    }
  }

  private fail(reason: AppLoginReason): AppLoginState {
    this.st = { state: "failed", reason };
    this.log(`ended: ${reason}`);
    return this.st;
  }

  private async save(t: AppTokens): Promise<void> {
    const stored: StoredTokens = { ...t, clientId: this.d.clientId, savedAt: this.now() };
    await this.d.store.write(stored);
    this.kept = stored;
    this.signedOut = false;
    this.unsaved = false;
    this.retryAt = 0;
  }

  // The stored pair of this client id, read once and then kept.
  private async stored(): Promise<StoredTokens | null> {
    if (this.kept === undefined) {
      const t = await this.d.store.read();
      if (t && t.clientId !== this.d.clientId) {
        this.log("the stored token is of another client id: it is not used");
        this.kept = null;
      } else {
        this.kept = t;
      }
    }
    return this.kept;
  }

  async tokenState(): Promise<AppTokenState> {
    if (this.signedOut) return { state: "signed-out", why: "refused" };
    const t = await this.stored();
    if (!t) return { state: "none" };
    const now = this.now();
    const dead = (at: number | null) => at !== null && at <= now;
    if (dead(t.accessExpiresAt) && (t.refreshToken === null || dead(t.refreshExpiresAt))) return { state: "signed-out", why: "ended" };
    return { state: "ok", accessExpiresAt: t.accessExpiresAt, refreshExpiresAt: t.refreshExpiresAt, ...(this.unsaved ? { unsaved: true as const } : {}) };
  }

  // The token for one console call, refreshed first when it ends soon; null when there is none.
  async token(): Promise<string | null> {
    if (this.signedOut) return null;
    const t = await this.stored();
    if (!t) return null;
    const now = this.now();
    if (t.accessExpiresAt === null || t.accessExpiresAt - now > REFRESH_BEFORE_MS) return t.accessToken;
    const usable = t.accessExpiresAt - now > USE_MARGIN_MS ? t.accessToken : null;
    if (t.refreshToken === null || (t.refreshExpiresAt !== null && t.refreshExpiresAt <= now)) return usable;
    if (now < this.retryAt) return usable;
    this.refreshing ??= this.refresh(t).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refresh(t: StoredTokens): Promise<string | null> {
    const a = await this.flow.refreshTokens(this.d.clientId, t.refreshToken as string);
    const now = this.now();
    const usable = t.accessExpiresAt !== null && t.accessExpiresAt - now > USE_MARGIN_MS ? t.accessToken : null;
    if (a.kind === "revoked") {
      this.log("GitHub refused the refresh: connect the app again");
      this.signedOut = true;
      this.kept = null;
      await this.d.store.remove().catch(() => {});
      return null;
    }
    if (a.kind === "failed") {
      this.log(`the refresh failed (${a.why}): the next try in ${REFRESH_RETRY_MS / 1000} s`);
      this.retryAt = now + REFRESH_RETRY_MS;
      return usable;
    }
    try {
      await this.save(a.tokens);
    } catch {
      // GitHub ended the old pair: the new one lives only in this process until a store works.
      this.log("the refreshed token could not be stored: it works until a restart, then connect the app again");
      this.kept = { ...a.tokens, clientId: this.d.clientId, savedAt: now };
      this.unsaved = true;
    }
    this.log("token refreshed");
    return a.tokens.accessToken;
  }

  // Removes the pair from this server. GitHub's side is the person's: Settings → Applications →
  // Authorized GitHub Apps → Revoke, and the install under Installed GitHub Apps.
  async disconnect(): Promise<void> {
    this.stop();
    await this.d.store.remove();
    this.kept = null;
    this.signedOut = false;
    this.unsaved = false;
    this.st = { state: "idle" };
    this.log("disconnected on this server");
  }

  // Fixed words only: never a token, a code or a line of GitHub.
  private log(what: string): void {
    (this.d.log ?? ((s: string) => console.warn(s)))(`[github] app login ${what}`);
  }
}
