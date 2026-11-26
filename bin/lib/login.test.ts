// bin/lib/login.test.ts — `login`: the Claude login step. The exec seam is mocked: no Claude
// program runs, and HOME is a temp dir, so no real login is read or written.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  calls: [] as string[],
  // What `claude auth login` does at each call: true = the login file is there after it.
  logins: [] as boolean[],
  request: { code: 0, stdout: "ready\n", stderr: "" },
  home: "",
}));

vi.mock("./exec.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    which: async () => null,
    run: async (cmd: string, args: string[]) => {
      box.calls.push([path.basename(cmd), ...args].join(" "));
      if (args[0] === "auth" && args[1] === "login") {
        if (box.logins.shift()) {
          fs.mkdirSync(path.join(box.home, ".claude"), { recursive: true });
          fs.writeFileSync(path.join(box.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up" } }));
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "status") {
        return { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "ada@example.invalid", subscriptionType: "max" }), stderr: "" };
      }
      if (args[0] === "-p") return box.request;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
});

import { LOGIN_TRIES, parseStatus, requestResult, runLogin } from "./login.js";

let root: string, out: string[], oldHome: string | undefined;
const text = (): string => out.join("\n");
const login = (isTTY = true): Promise<number> => runLogin({ repoDir: root, env: { HOME: box.home }, isTTY, out: (s) => out.push(s) });
const claudeIsThere = (): void => {
  mkdirSync(join(box.home, ".local", "bin"), { recursive: true });
  writeFileSync(join(box.home, ".local", "bin", "claude"), "#!/bin/sh\n");
  chmodSync(join(box.home, ".local", "bin", "claude"), 0o755);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "login-"));
  box.home = join(root, "home");
  mkdirSync(box.home);
  oldHome = process.env.HOME;
  process.env.HOME = box.home;
  Object.assign(box, { calls: [], logins: [], request: { code: 0, stdout: "ready\n", stderr: "" } });
  out = [];
});
afterEach(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); });

describe("login", () => {
  it("goes on with no AI when Claude Code is not on the server", async () => {
    expect(await login()).toBe(1);
    expect(text()).toContain("The Claude program is not on your server.");
    expect(text()).toContain("goes on with no AI");
    expect(box.calls).toEqual([]);
  });

  it("starts no login with no terminal, and names the command", async () => {
    claudeIsThere();
    expect(await login(false)).toBe(1);
    expect(text()).toContain("The login needs a terminal with a person.");
    expect(box.calls).toEqual([]);
  });

  it("logs in, lets the check of the step list decide, and shows the account and the plan", async () => {
    claudeIsThere();
    box.logins = [true];
    expect(await login()).toBe(0);
    expect(box.calls).toEqual(["claude auth login", "claude auth status", "claude -p Reply with the one word: ready --model haiku"]);
    expect(text()).toContain("✔ Logged in as ada@example.invalid. Plan: Max.");
    expect(text()).toContain("✔ Claude answers a test request");
    expect(text()).toContain("Not the right account? Run: claude auth logout");
  });

  it("a wrong code: it starts the login again, with a new link each time", async () => {
    claudeIsThere();
    box.logins = [false, false, true];
    expect(await login()).toBe(0);
    expect(box.calls.filter((c) => c === "claude auth login")).toHaveLength(3);
    expect(text()).toContain("The login did not work (try 2 of 3). Here is a new link.");
  });

  it(`stops after ${LOGIN_TRIES} tries: a login that Claude reports but the check does not see is not a login`, async () => {
    claudeIsThere();
    box.logins = [false, false, false, true];
    expect(await login()).toBe(1);
    expect(box.calls).toEqual(["claude auth login", "claude auth login", "claude auth login"]);
    expect(text()).toContain("Claude is not logged in on your server. 3 tries did not work.");
  });

  it("asks for no new login when one is there", async () => {
    claudeIsThere();
    mkdirSync(join(box.home, ".claude"));
    writeFileSync(join(box.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up" } }));
    expect(await login(false)).toBe(0);
    expect(box.calls[0]).toBe("claude auth status");
  });

  it("no paid plan: says which plans work and goes on with no AI", async () => {
    claudeIsThere();
    box.logins = [true];
    box.request = { code: 1, stdout: "Your account does not have access to Claude Code.\n", stderr: "" };
    expect(await login()).toBe(2);
    expect(text()).toContain("Claude said: Your account does not have access to Claude Code.");
    expect(text()).toContain("Pro, Max, Team or Enterprise");
    expect(text()).toContain("goes on with no AI");
  });

  it("a plan at its limit: logged in, and no AI for now", async () => {
    claudeIsThere();
    box.logins = [true];
    box.request = { code: 1, stdout: "You've hit your session limit · resets 2pm\n", stderr: "" };
    expect(await login()).toBe(2);
    expect(text()).toContain("Your Claude plan is at its limit now.");
  });
});

describe("the answers of Claude Code", () => {
  it("reads the status fields one by one", () => {
    expect(parseStatus('{"loggedIn":true,"email":"a@example.invalid","subscriptionType":"pro"}')).toEqual({ loggedIn: true, email: "a@example.invalid", plan: "Pro" });
    expect(parseStatus('{"loggedIn":true}')).toEqual({ loggedIn: true, email: null, plan: null });
    expect(parseStatus("not json")).toEqual({ loggedIn: false, email: null, plan: null });
    expect(parseStatus('{"loggedIn":true,"email":"<script>"}').email).toBeNull();
  });

  it("gives Claude's own first line, with no file path in it", () => {
    expect(requestResult({ code: 0, stdout: "ready", stderr: "" })).toEqual({ state: "works" });
    expect(requestResult({ code: 1, stdout: "", stderr: "\nRequest rejected (429)\nmore" })).toEqual({ state: "limit", said: "Request rejected (429)" });
    expect(requestResult({ code: 1, stdout: "cannot read /home/you/.claude/x.json", stderr: "" })).toEqual({ state: "failed", said: "cannot read a file" });
  });
});
