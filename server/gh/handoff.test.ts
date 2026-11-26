// server/gh/handoff.test.ts — the hand-off of the app's token: only to the one child of a console
// gh call, or of a console git call that talks to a remote, and only when there is a source and
// a valid token. Then the proof, offline, with the real gh and the real git: gh's credential
// helper gives git the GH_TOKEN of its env, as username x-access-token (a fake token, an empty
// temp gh config, a dead proxy: nothing reaches GitHub).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../agents/git.js";
import { gh } from "./exec.js";
import { gitSubcommand, gitTalksToRemote, githubEnv, setGithubTokenSource } from "./handoff.js";
import { FAKE_ACCESS } from "./testkit.js";

let dir: string;
const savedPath = process.env.PATH;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gh-handoff-")); delete process.env.GH_TOKEN; });
afterEach(() => { setGithubTokenSource(null); process.env.PATH = savedPath; rmSync(dir, { recursive: true, force: true }); });

describe("githubEnv", () => {
  it("is null with no source, so a call runs exactly as before", async () => {
    expect(await githubEnv({ PATH: "/bin" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  it("adds GH_TOKEN to a copy of the env", async () => {
    setGithubTokenSource(async () => FAKE_ACCESS);
    const env = { PATH: "/bin" } as unknown as NodeJS.ProcessEnv;
    expect(await githubEnv(env)).toEqual({ PATH: "/bin", GH_TOKEN: FAKE_ACCESS });
    expect(env).toEqual({ PATH: "/bin" });
  });
  it("is null when the source has no token, a token that is not one, or fails", async () => {
    for (const s of [async () => null, async () => `${FAKE_ACCESS}\nX=1`, async () => "short", async () => { throw new Error("x"); }]) {
      setGithubTokenSource(s);
      expect(await githubEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    }
  });
});

describe("gitTalksToRemote", () => {
  it("finds the subcommand after the global options", () => {
    expect(gitSubcommand(["-c", "core.hooksPath=/dev/null", "-C", "/r", "fetch", "origin"])).toBe("fetch");
    expect(gitSubcommand(["--no-pager", "log"])).toBe("log");
  });
  it("is true for fetch, push, pull, ls-remote and clone only", () => {
    for (const sub of ["fetch", "push", "pull", "ls-remote", "clone"]) expect(gitTalksToRemote(["-C", "/r", sub])).toBe(true);
    for (const sub of ["status", "log", "remote", "rev-parse", "config", "commit"]) expect(gitTalksToRemote(["-C", "/r", sub])).toBe(false);
    expect(gitTalksToRemote(["-C", "/r"])).toBe(false);
  });
});

// A fake program on PATH that says whether its env holds the fake token, never the token.
function fakeBin(name: string): void {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\nif [ "$GH_TOKEN" = "${FAKE_ACCESS}" ]; then echo token-given; elif [ -z "$GH_TOKEN" ]; then echo no-token; else echo other; fi\n`);
  chmodSync(join(bin, name), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

describe("the console's own calls", () => {
  it("a gh call gets the token only with a source", async () => {
    fakeBin("gh");
    expect((await gh(["api", "user"])).trim()).toBe("no-token");
    setGithubTokenSource(async () => FAKE_ACCESS);
    expect((await gh(["api", "user"])).trim()).toBe("token-given");
    expect((await gh(["pr", "create", "--body-file", "-"], { input: "body" })).trim()).toBe("token-given");
    // The console's own env never holds it.
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("a git call gets the token only when it talks to a remote", async () => {
    fakeBin("git");
    setGithubTokenSource(async () => FAKE_ACCESS);
    expect((await runGit(dir, ["-C", dir, "fetch", "origin"])).stdout.trim()).toBe("token-given");
    expect((await runGit(dir, ["-C", dir, "push", "origin", "b"], { timeout: 5_000 })).stdout.trim()).toBe("token-given");
    expect((await runGit(dir, ["-C", dir, "status"])).stdout.trim()).toBe("no-token");
    setGithubTokenSource(null);
    expect((await runGit(dir, ["-C", dir, "fetch", "origin"])).stdout.trim()).toBe("no-token");
  });
});

// The real gh and git on this machine (skipped where there is none).
const which = (name: string): string | null => {
  try { return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { PATH: savedPath } as unknown as NodeJS.ProcessEnv }).trim() || null; } catch { return null; }
};
const realGh = which("gh");
const realGit = which("git");

describe.skipIf(!realGh || !realGit)("the real gh and git, offline", () => {
  // No real config, no real login, no network: an empty gh config folder, a temp HOME, no global
  // or system git config, and a proxy that answers nothing.
  const env = (token?: string): NodeJS.ProcessEnv => {
    const cfg = join(dir, "gh-config");
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    return {
      PATH: savedPath, HOME: dir, GH_CONFIG_DIR: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
      HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "",
      ...(token ? { GH_TOKEN: token } : {}),
    } as unknown as NodeJS.ProcessEnv;
  };
  const ASK = "protocol=https\nhost=github.com\npath=acme/shop.git\n\n";

  it("gh's git helper answers with x-access-token and the GH_TOKEN of its env", () => {
    const r = spawnSync(realGh!, ["auth", "git-credential", "get"], { input: ASK, env: env(FAKE_ACCESS), encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("username=x-access-token\n");
    expect(r.stdout).toContain(`password=${FAKE_ACCESS}\n`);
  });

  it("git, through the helper that `gh auth setup-git` sets, gets that token; with no GH_TOKEN it gets none", () => {
    const helper = ["-c", "credential.helper=", "-c", `credential.https://github.com.helper=!${realGh} auth git-credential`];
    const yes = spawnSync(realGit!, [...helper, "credential", "fill"], { input: ASK, env: env(FAKE_ACCESS), encoding: "utf8", timeout: 20_000 });
    expect(yes.status).toBe(0);
    expect(yes.stdout).toContain("username=x-access-token\n");
    expect(yes.stdout).toContain(`password=${FAKE_ACCESS}\n`);
    const no = spawnSync(realGit!, [...helper, "credential", "fill"], { input: ASK, env: env(), encoding: "utf8", timeout: 20_000 });
    expect(no.status).not.toBe(0);
    expect(no.stdout).not.toContain("password=");
  });
});
