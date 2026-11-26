// server/setup/ghlogin.test.ts — the GitHub code login with a fake `gh` (a small script in a
// temp folder: no test here reaches GitHub or the login of this box).
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVICE_URL, GithubLogin, loginFailure, parseDevice, type LoginState } from "./ghlogin.js";

let dir: string;
let made: GithubLogin[];
const TOKEN = "gho_ThisIsNotARealTokenThisIsNotAReal0000";

// The fake: every call is one line of calls.log. `auth login` prints what gh prints with no
// terminal (to stderr), then does what the file "mode" says.
function fakeGh(): string {
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/usr/bin/env bash
D="${dir}"
echo "$*" >> "$D/calls.log"
[ "$1 $2" = "auth setup-git" ] && exit 0
n=$(grep -c "auth login" "$D/calls.log")
case "$(cat "$D/mode" 2>/dev/null)" in
  offline) echo "error connecting to github.com" >&2; echo "check your internet connection or https://githubstatus.com" >&2; exit 1 ;;
  envtoken) echo "The value of the GH_TOKEN environment variable is being used for authentication." >&2; exit 1 ;;
esac
trap 'echo killed >> "$D/calls.log"; exit 143' TERM
printf '\\033[33m!\\033[0m First copy your one-time code: \\033[1mAB%02d-CD%02d\\033[0m\\n' "$n" "$n" >&2
echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
echo "debug: ${TOKEN}" >&2
for i in $(seq 1 200); do
  [ -f "$D/approve" ] && { echo "✓ Authentication complete." >&2; echo "✓ Logged in as ada-dev" >&2; exit 0; }
  [ -f "$D/deny" ] && { echo "failed to authenticate via web browser: access_denied" >&2; exit 1; }
  sleep 0.05
done
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}
const calls = (): string[] => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n") : []);
const until = async (ok: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); }
};
function login(o: { codeMs?: number; bin?: string; logs?: string[]; onDone?: () => void } = {}): GithubLogin {
  const l = new GithubLogin({ bin: o.bin ?? fakeGh(), env: { PATH: process.env.PATH }, codeMs: o.codeMs, log: (s) => o.logs?.push(s), onDone: o.onDone });
  made.push(l);
  return l;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "setup-ghlogin-")); made = []; });
afterEach(() => { for (const l of made) l.stop(); rmSync(dir, { recursive: true, force: true }); });

describe("what gh prints", () => {
  it("gives the code and the address, with or without colours", () => {
    expect(parseDevice("! First copy your one-time code: 7F2A-9C41\nOpen this URL to continue in your web browser: https://github.com/login/device\n"))
      .toEqual({ code: "7F2A-9C41", url: DEVICE_URL });
    expect(parseDevice("\u001b[33m!\u001b[0m First copy your one-time code: \u001b[1mQ4KD-83TN\u001b[0m\n")).toEqual({ code: "Q4KD-83TN", url: DEVICE_URL });
    expect(parseDevice("! First copy your one-time")).toBeNull();
  });

  it("takes an address only at github.com", () => {
    expect(parseDevice("one-time code: 7F2A-9C41\nOpen this URL to continue in your web browser: https://evil.example/login\n")?.url).toBe(DEVICE_URL);
  });

  it("names the cause of a failure", () => {
    expect(loginFailure("error connecting to github.com")).toBe("no-answer");
    expect(loginFailure("dial tcp: lookup github.com: no such host")).toBe("no-answer");
    expect(loginFailure("failed to authenticate via web browser: This 'device_code' has expired. (expired_token)")).toBe("expired");
    expect(loginFailure("failed to authenticate via web browser: access_denied")).toBe("denied");
    expect(loginFailure("The value of the GH_TOKEN environment variable is being used for authentication.")).toBe("env-token");
    expect(loginFailure("something new")).toBe("failed");
  });
});

describe("GithubLogin", () => {
  it("starts nothing by itself", async () => {
    const l = login();
    expect(l.state()).toEqual({ state: "idle" });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toEqual([]);
  });

  it("runs gh with no question, shows the code, and is done after the approval", async () => {
    let done = 0;
    const logs: string[] = [];
    const l = login({ logs, onDone: () => { done++; } });
    const s = await l.start();
    expect(s).toMatchObject({ state: "waiting", code: "AB01-CD01", url: DEVICE_URL });
    expect((s as Extract<LoginState, { state: "waiting" }>).expiresAt).toBeGreaterThan(Date.now());
    expect(calls()).toEqual(["auth login --hostname github.com --git-protocol https --web"]);
    writeFileSync(join(dir, "approve"), "");
    await until(() => l.state().state === "done");
    // git then uses the login of gh (a clone of a private repo needs it).
    expect(calls()).toEqual(["auth login --hostname github.com --git-protocol https --web", "auth setup-git --hostname github.com"]);
    expect(done).toBe(1);
    expect(logs.join("\n")).toMatch(/GitHub login done/);
  });

  it("gives the same code to a page that comes back, and a new one on `fresh`", async () => {
    const l = login();
    const first = await l.start();
    expect(await l.start()).toEqual(first);
    expect(l.state()).toEqual(first);
    expect(calls().filter((c) => c.startsWith("auth login"))).toHaveLength(1);
    const next = await l.start({ fresh: true });
    expect(next).toMatchObject({ state: "waiting", code: "AB02-CD02" });
    await until(() => calls().includes("killed"));
    // The end of the first login does not change the state of the second.
    expect(l.state()).toEqual(next);
  });

  it("says that the code ran out, and stops gh", async () => {
    const l = login({ codeMs: 80 });
    expect((await l.start()).state).toBe("waiting");
    await until(() => l.state().state === "failed");
    expect(l.state()).toEqual({ state: "failed", reason: "expired" });
    await until(() => calls().includes("killed"));
  });

  it("says that the user did not approve", async () => {
    const l = login();
    await l.start();
    writeFileSync(join(dir, "deny"), "");
    await until(() => l.state().state === "failed");
    expect(l.state()).toEqual({ state: "failed", reason: "denied" });
  });

  it("says that gh is not on the box", async () => {
    const l = login({ bin: join(dir, "no-such-gh") });
    expect(await l.start()).toEqual({ state: "failed", reason: "no-gh" });
  });

  it("says that GitHub is not reachable", async () => {
    const bin = fakeGh();
    writeFileSync(join(dir, "mode"), "offline");
    expect(await login({ bin }).start()).toEqual({ state: "failed", reason: "no-answer" });
  });

  it("says that a token in the settings of the console is in the way", async () => {
    const bin = fakeGh();
    writeFileSync(join(dir, "mode"), "envtoken");
    expect(await login({ bin }).start()).toEqual({ state: "failed", reason: "env-token" });
  });

  it("puts no line of gh in a state or a log", async () => {
    const logs: string[] = [];
    const l = login({ logs });
    const states = [await l.start()];
    writeFileSync(join(dir, "approve"), "");
    await until(() => l.state().state === "done");
    states.push(l.state());
    const out = JSON.stringify(states) + logs.join("\n");
    expect(out).not.toContain("gho_");
    expect(out).not.toContain("debug");
    for (const s of states) for (const k of Object.keys(s)) expect(["state", "code", "url", "expiresAt", "reason"]).toContain(k);
  });

  it("stop() ends the login that runs", async () => {
    const l = login();
    await l.start();
    l.stop();
    expect(l.state()).toEqual({ state: "idle" });
    await until(() => calls().includes("killed"));
  });
});
