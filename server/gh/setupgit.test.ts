// server/gh/setupgit.test.ts — a hardened console (strong protection) gives git the console
// user's global credential helpers through gitEnv, read once and kept for the process. On a new
// server there is no helper until a GitHub login runs `gh auth setup-git`. These tests prove that
// the console's own git calls see the new helper right after that, with no restart: after the
// ChoiBot app login (gh/appsetup.ts), after gh's own code login (setup/ghlogin.ts), and in the
// push of runGit (agents/git.ts), which also gets the app's GH_TOKEN. Then, with the real gh and
// the real git (skipped where there is no gh), the whole path offline: `gh auth setup-git` writes
// the helper, and `git credential fill` under the console's hardened env gets the app's key.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitEnv, resetCredentialHelpers, runGit } from "../agents/git.js";
import { GithubLogin } from "../setup/ghlogin.js";
import { setupGitForApp } from "./appsetup.js";
import { setGithubTokenSource } from "./handoff.js";
import { FAKE_ACCESS } from "./testkit.js";

const HARD: Record<string, string> = { CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001" };
const HELPER_KEY = "credential.https://github.com.helper";
const which = (name: string): string | null => {
  try { return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim() || null; } catch { return null; }
};
const realGit = which("git")!;
const realGh = which("gh");

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "gh-setupgit-")));
  // The console's own global config: <base>/.gitconfig, with no helper. Hardened mode on.
  vi.stubEnv("HOME", base);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(base, ".gitconfig"));
  writeFileSync(join(base, ".gitconfig"), "");
  for (const [k, v] of Object.entries(HARD)) vi.stubEnv(k, v);
  resetCredentialHelpers();
});
afterEach(() => {
  setGithubTokenSource(null);
  vi.unstubAllEnvs();
  resetCredentialHelpers();
  rmSync(base, { recursive: true, force: true });
});

// The helpers a hardened console git call gets: the GIT_CONFIG_KEY_n/VALUE_n pairs of gitEnv.
function helpers(env: NodeJS.ProcessEnv): string[] {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0);
  return Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]] as const)
    .filter(([k]) => k === HELPER_KEY).map(([, v]) => String(v));
}

// A fake gh: `auth login` prints a code and ends well; `auth setup-git` writes gh's helper into
// the global config as gh does (an empty value, then its own); `auth git-credential` answers
// with the GH_TOKEN of its env.
function fakeGh(): string {
  const bin = join(base, "fake-gh");
  writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "auth login") echo "! First copy your one-time code: ABCD-1234" >&2; echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2; exit 0 ;;
  "auth setup-git") ${realGit} config --global --replace-all ${HELPER_KEY} "" && ${realGit} config --global --add ${HELPER_KEY} "!$0 auth git-credential"; exit $? ;;
  "auth git-credential") [ -n "$GH_TOKEN" ] && printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; exit 0 ;;
esac
exit 1
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("a hardened console sees gh's new helper at once", () => {
  it("after the ChoiBot app login (setupGitForApp)", async () => {
    // The first console git call on a new server: no helper yet, and that is kept.
    expect(helpers(gitEnv(base))).toEqual([]);
    setGithubTokenSource(async () => FAKE_ACCESS);
    const gh = fakeGh();
    expect(await setupGitForApp({ bin: gh })).toBe(true);
    expect(helpers(gitEnv(base))).toEqual(["", `!${gh} auth git-credential`]);
  });

  it("after gh's own code login (the old login path)", async () => {
    expect(helpers(gitEnv(base))).toEqual([]);
    const gh = fakeGh();
    let done = false;
    const login = new GithubLogin({ bin: gh, onDone: () => { done = true; }, log: () => {} });
    await login.start();
    for (let i = 0; i < 200 && !done; i++) await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(true);
    expect(helpers(gitEnv(base))).toEqual(["", `!${gh} auth git-credential`]);
  });

  it("a push of runGit gets the helper and the app's GH_TOKEN in its one git child", async () => {
    // A fake git on PATH that reports what its env holds; `git config` goes to the real git (gitEnv reads with it).
    const dir = join(base, "bin");
    mkdirSync(dir);
    writeFileSync(join(dir, "git"), `#!/bin/sh
if [ "$1" = config ]; then exec ${realGit} "$@"; fi
h=no; i=0; while [ $i -lt "\${GIT_CONFIG_COUNT:-0}" ]; do eval "v=\\$GIT_CONFIG_VALUE_$i"; case "$v" in *"auth git-credential"*) h=yes ;; esac; i=$((i+1)); done
t=no; [ "$GH_TOKEN" = "${FAKE_ACCESS}" ] && t=yes
echo "helper=$h token=$t"
`);
    chmodSync(join(dir, "git"), 0o755);
    vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
    expect((await runGit(base, ["-C", base, "push", "origin", "b"])).stdout.trim()).toBe("helper=no token=no");
    setGithubTokenSource(async () => FAKE_ACCESS);
    expect(await setupGitForApp({ bin: fakeGh() })).toBe(true);
    expect((await runGit(base, ["-C", base, "push", "origin", "b"])).stdout.trim()).toBe("helper=yes token=yes");
  });
});

describe.skipIf(!realGh)("the real gh and git, hardened, offline", () => {
  it("`gh auth setup-git` writes the helper, and git under the console's env gets the app's key", async () => {
    const cfg = join(base, "gh-config");
    mkdirSync(cfg, { mode: 0o700 });
    // No real login, no network: an empty gh config and a proxy that answers nothing.
    for (const [k, v] of Object.entries({ GH_CONFIG_DIR: cfg, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" })) vi.stubEnv(k, v);
    expect(helpers(gitEnv(base))).toEqual([]);
    setGithubTokenSource(async () => FAKE_ACCESS);
    expect(await setupGitForApp({ bin: realGh! })).toBe(true);
    // What runGit gives a push: the hardened env plus GH_TOKEN. `git credential fill` asks the helper.
    const env = { ...gitEnv(base, { ...process.env, GH_TOKEN: FAKE_ACCESS, GIT_TERMINAL_PROMPT: "0" }) };
    expect(helpers(env).some((v) => v.includes("auth git-credential"))).toBe(true);
    const r = spawnSync(realGit, ["credential", "fill"], { input: "protocol=https\nhost=github.com\npath=acme/shop.git\n\n", env, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("username=x-access-token\n");
    expect(r.stdout).toContain(`password=${FAKE_ACCESS}\n`);
  });
});
