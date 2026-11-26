// server/setup/ghlogin.ts — Connect GitHub from the browser: GitHub's device code login, run by
// the `gh` of the box. The console starts `gh auth login --web` with no terminal. gh then asks
// nothing: it prints a one-time code and the address to open, and it waits until the user
// approves on github.com (gh manual: `gh auth login`, and `gh help environment` for the two
// env keys below). The browser gets the code, the address and a state. Nothing else.
//
// The token stays where gh keeps it. What gh prints is read only here, for the code and for the
// cause of a failure: no line of it goes into an answer or a log.
//
// One login at a time, kept in this process: a page that closes and comes back gets the same
// code. Nothing here runs by itself: only start() starts a login.
import { spawn } from "node:child_process";
import { gitOpts } from "../agents/git.js";
import { ghSetupGit } from "../gh/setupgit.js";

// The address GitHub gives for a device code.
export const DEVICE_URL = "https://github.com/login/device";
// GitHub keeps a device code for 15 minutes.
export const CODE_MS = 15 * 60_000;
// The first answer of start() waits this long for the code.
const FIRST_MS = 10_000;
const SETUP_GIT_MS = 15_000;
const KEEP_BYTES = 8_192;

const LOGIN_ARGS = ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"];
// With no terminal, gh does not make git use its login (gh manual: `gh auth setup-git`). A
// clone or a push of a private repo needs it: gh/setupgit.ts.

// expired: the code ran out. denied: the user said no on GitHub. no-gh: the tool is not on the
// box. no-answer: GitHub is not reachable. env-token: the console runs with a GitHub token in
// its settings, so gh takes no login. failed: all else.
export type LoginReason = "expired" | "denied" | "no-gh" | "no-answer" | "env-token" | "failed";

export type LoginState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "waiting"; code: string; url: string; expiresAt: number }
  | { state: "done" }
  | { state: "failed"; reason: LoginReason };

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?![A-Z0-9-])/;
const URL_RE = /Open this URL to continue in your web browser:\s*(https:\/\/github\.com\/[A-Za-z0-9/_-]+)/;

// What gh printed (code and address), or null while the code is not there.
export function parseDevice(text: string): { code: string; url: string } | null {
  const plain = text.replace(ANSI, "");
  const code = CODE_RE.exec(plain)?.[1];
  if (!code) return null;
  return { code, url: URL_RE.exec(plain)?.[1] ?? DEVICE_URL };
}

// Why a login ended with no success, from what gh printed.
export function loginFailure(text: string): LoginReason {
  const t = text.replace(ANSI, "");
  if (/environment variable is being used for authentication/i.test(t)) return "env-token";
  if (/expired|timed out waiting|authentication timed out/i.test(t)) return "expired";
  if (/access_denied|denied|cancell?ed/i.test(t)) return "denied";
  if (/dial tcp|no such host|error connecting|connection re(fused|set)|network is unreachable|i\/o timeout|\btls\b|temporary failure|could not resolve/i.test(t)) return "no-answer";
  return "failed";
}

export type GithubLoginDeps = {
  // The program to run. Default: the `gh` on the PATH of the console.
  bin?: string;
  env?: Record<string, string | undefined>;
  codeMs?: number;
  firstMs?: number;
  now?: () => number;
  // A login ended well (after `gh auth setup-git`): the step list is read again.
  onDone?: () => void;
  log?: (s: string) => void;
};

type Child = ReturnType<typeof spawn>;

export class GithubLogin {
  private st: LoginState = { state: "idle" };
  private child: Child | null = null;
  private timer: NodeJS.Timeout | null = null;
  private waiters: (() => void)[] = [];

  constructor(private d: GithubLoginDeps = {}) {}

  state(): LoginState { return this.st; }

  // Starts a login, or gives the one that runs. `fresh`: stop the one that runs and start a
  // new one (the "New code" button). The answer comes when the code is there, when the start
  // failed, or after a few seconds (then the state is "starting", and the page asks again).
  async start(o: { fresh?: boolean } = {}): Promise<LoginState> {
    if (this.child && !o.fresh) return this.settled();
    this.stop();
    // A new variable for each login: an event of an older child never changes the state. The
    // env is the one of every console gh call (gitOpts: the git overrides of a hardened install).
    const child = spawn(this.d.bin ?? "gh", LOGIN_ARGS, gitOpts(process.cwd(), {
      env: { ...this.env(), NO_COLOR: "1", GH_PROMPT_DISABLED: "1" },
      stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"],
    }));
    this.child = child;
    this.set({ state: "starting" });
    this.log("started");
    let seen = "";
    const mine = () => this.child === child;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (!mine()) return;
      seen = (seen + chunk.toString("utf8")).slice(-KEEP_BYTES);
      if (this.st.state !== "starting") return;
      const device = parseDevice(seen);
      if (!device) return;
      const ms = this.d.codeMs ?? CODE_MS;
      this.set({ state: "waiting", ...device, expiresAt: (this.d.now ?? Date.now)() + ms });
      this.log("the code is on the page");
      this.timer = setTimeout(() => { if (mine()) this.end(child, { state: "failed", reason: "expired" }); }, ms);
      this.timer.unref?.();
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (mine()) this.end(child, { state: "failed", reason: e.code === "ENOENT" ? "no-gh" : "failed" });
    });
    child.on("close", (code) => {
      if (!mine()) return;
      if (code !== 0) return this.end(child, { state: "failed", reason: loginFailure(seen) });
      this.child = null;
      this.clearTimer();
      void this.setupGit().then(() => {
        if (this.child !== null) return; // a newer login started meanwhile
        this.set({ state: "done" });
        this.log("done");
        this.d.onDone?.();
      });
    });
    return this.settled();
  }

  // Stops the login that runs (the server stops, or a new code is asked for).
  stop(): void {
    const child = this.child;
    this.child = null;
    this.clearTimer();
    if (child && child.exitCode === null) child.kill("SIGTERM");
    if (this.st.state === "starting" || this.st.state === "waiting") this.set({ state: "idle" });
  }

  private end(child: Child, next: LoginState): void {
    this.child = null;
    this.clearTimer();
    if (child.exitCode === null) child.kill("SIGTERM");
    this.set(next);
    if (next.state === "failed") this.log(`ended: ${next.reason}`);
  }

  private env(): NodeJS.ProcessEnv {
    return (this.d.env ?? process.env) as NodeJS.ProcessEnv;
  }

  private async setupGit(): Promise<void> {
    const ok = await ghSetupGit({ ...(this.d.bin ? { bin: this.d.bin } : {}), env: this.env(), timeoutMs: SETUP_GIT_MS });
    if (!ok) this.log("git does not use the GitHub login yet (gh auth setup-git failed)");
  }

  // The state once it is not "starting", or after FIRST_MS.
  private settled(): Promise<LoginState> {
    if (this.st.state !== "starting") return Promise.resolve(this.st);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(this.st);
      };
      timer = setTimeout(done, this.d.firstMs ?? FIRST_MS);
      timer.unref?.();
      this.waiters.push(done);
    });
  }

  private set(next: LoginState): void {
    this.st = next;
    if (next.state !== "starting") for (const w of [...this.waiters]) w();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Fixed words only: never a line of gh.
  private log(what: string): void {
    (this.d.log ?? ((s: string) => console.warn(s)))(`[setup] GitHub login ${what}`);
  }
}
