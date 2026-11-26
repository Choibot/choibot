// bin/lib/repair.test.ts — `repair`: when the install agent starts, and with which settings.
// The exec seam is mocked: no Claude program runs. The rules themselves are tested in
// bin/install-agent/policy.test.ts.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({ calls: [] as { cmd: string; args: string[]; env?: Record<string, string | undefined> }[], help: "  --restricted  Restricted mode\n", code: 0 }));

vi.mock("./exec.js", () => ({
  which: async () => null,
  run: async (cmd: string, args: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
    box.calls.push({ cmd, args, env: opts.env });
    if (args[0] === "--help") return { code: 0, stdout: box.help, stderr: "" };
    return { code: box.code, stdout: "", stderr: "" };
  },
}));

import { CLI_NAME } from "../../server/brand.js";
import { decide } from "../install-agent/policy.mjs";
import { AGENT_TOOLS, agentArgs, agentCtx, agentPrompt, agentSettings, firstMessage, forModel, runRepair, type AgentCtx } from "./repair.js";

let root: string, home: string, base: string, app: string, out: string[], oldHome: string | undefined, dirs: string[];
const text = (): string => out.join("\n");
const repair = (isTTY = true): Promise<number> =>
  runRepair({ repoDir: app, env: { HOME: home, PATH: "/usr/bin" }, isTTY, out: (s) => out.push(s), confirm: async () => {}, chdir: (d) => { dirs.push(d); } });
const session = () => box.calls.find((c) => c.args.includes("--restricted"));

function install(o: { marker?: boolean; claude?: boolean; login?: boolean } = {}): void {
  mkdirSync(join(app, "bin"), { recursive: true });
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(join(base, "bin", CLI_NAME), "#!/bin/sh\n");
  if (o.marker !== false) writeFileSync(join(base, `.installed-by-${CLI_NAME}`), "");
  if (o.claude !== false) {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\n");
    chmodSync(join(home, ".local", "bin", "claude"), 0o755);
  }
  if (o.login !== false) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up" } }));
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repair-"));
  home = join(root, "home"); base = join(home, "choibot"); app = join(base, "app");
  mkdirSync(home);
  oldHome = process.env.HOME;
  process.env.HOME = home;
  Object.assign(box, { calls: [], help: "  --restricted  Restricted mode\n", code: 0 });
  out = []; dirs = [];
});
afterEach(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); });

describe("when the install agent starts", () => {
  it("not on an install that the install script did not make (the owner's console, a clone by hand)", async () => {
    install({ marker: false });
    expect(await repair()).toBe(1);
    expect(box.calls).toEqual([]);
  });

  // The install does not make the person log in to Claude (the Set-up page does). The login in
  // the terminal is only an offer here, because the install agent cannot work with no login.
  const withOffer = (o: { yes: boolean; login?: () => Promise<unknown>; isTTY?: boolean }) => {
    const asked = { offer: 0, login: 0 };
    const run = runRepair({
      repoDir: app, env: { HOME: home, PATH: "/usr/bin" }, isTTY: o.isTTY ?? true, out: (s) => out.push(s), confirm: async () => {}, chdir: (d) => { dirs.push(d); },
      offerLogin: async () => { asked.offer++; return o.yes; },
      login: async () => { asked.login++; await o.login?.(); },
    });
    return { run, asked };
  };
  const logIn = async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "made-up" } }));
  };

  it("no Claude login, and the person says no to the offer: the step keeps its own fix, as before", async () => {
    install({ login: false });
    const { run, asked } = withOffer({ yes: false });
    expect(await run).toBe(1);
    expect(asked).toEqual({ offer: 1, login: 0 });
    expect(text()).toContain("It is Claude Code, so it needs your Claude login.");
    expect(text()).toContain("No install agent: Claude is not logged in on your server. You can log in later on the page of");
    expect(text()).toContain("goes on where it stopped");
    expect(session()).toBeUndefined();
  });

  it("no Claude login, and the person says yes: the login runs here, then the install agent starts", async () => {
    install({ login: false });
    const { run, asked } = withOffer({ yes: true, login: logIn });
    expect(await run).toBe(0);
    expect(asked).toEqual({ offer: 1, login: 1 });
    expect(session()).toBeDefined();
  });

  it("yes, but the login did not work: no install agent, the step keeps its own fix", async () => {
    install({ login: false });
    const { run, asked } = withOffer({ yes: true });
    expect(await run).toBe(1);
    expect(asked.login).toBe(1);
    expect(text()).toContain("No install agent: Claude is not logged in on your server.");
    expect(session()).toBeUndefined();
  });

  it("no offer with no terminal, with no Claude program, and with a login that is there", async () => {
    install({ login: false });
    let r = withOffer({ yes: true, login: logIn, isTTY: false });
    expect(await r.run).toBe(1);
    expect(r.asked).toEqual({ offer: 0, login: 0 });
    expect(text()).toContain("No install agent");
    rmSync(join(home, ".local"), { recursive: true, force: true });   // no Claude program
    r = withOffer({ yes: true, login: logIn });
    expect(await r.run).toBe(1);
    expect(r.asked).toEqual({ offer: 0, login: 0 });
    install();                                                        // logged in
    r = withOffer({ yes: false });
    expect(await r.run).toBe(0);
    expect(r.asked).toEqual({ offer: 0, login: 0 });
  });

  it("not with a Claude Code that has no restricted mode, and not with no terminal", async () => {
    install();
    box.help = "  --print\n";
    expect(await repair()).toBe(1);
    expect(text()).toContain("too old");
    box.help = "  --restricted\n";
    expect(await repair(false)).toBe(1);
    expect(session()).toBeUndefined();
  });

  it("says first what it sends to the model and what its rules are, then starts in the console's own folder", async () => {
    install();
    writeFileSync(join(base, "failed-step.log"), "Step: Set up your server\n  ✔ Settings written\n✖ The service did not start. The service manager said: exit 1\n");
    expect(await repair()).toBe(0);
    expect(text()).toContain('It sends the output of the failed step ("Set up your server") to Claude, the model of Anthropic.');
    expect(text()).toContain("It asks you first, with the exact command: sudo");
    expect(text()).toContain("Never: a public door");
    expect(dirs).toEqual([base]);
    const s = session()!;
    expect(s.cmd).toBe(join(home, ".local", "bin", "claude"));
    expect(s.args[s.args.length - 1]).toContain("This step of the install failed: Set up your server");
    expect(s.args[s.args.length - 1]).toContain("The service did not start.");
    expect(s.env?.PATH?.split(":").slice(-1)).toEqual(["/usr/bin"]);
  });
});

describe("the settings of the session hold the rules", () => {
  const c: AgentCtx = {
    base: "/home/you/choibot", app: "/home/you/choibot/app", home: "/home/you", user: "you", unit: "choibot.service",
    cronPrefix: "choibot-cron-", dataDir: "/home/you/.local/share/choibot", cli: "/home/you/choibot/bin/choibot", cliNames: ["choibot", "choi", "choibot"],
  };
  type Settings = { permissions: { defaultMode: string; disableBypassPermissionsMode: string; deny: string[]; ask: string[]; allow?: string[] }; hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] } };
  const s = agentSettings(c, "/home/you/choibot/node/bin/node") as Settings;

  it("the flags: restricted mode, six tools, the default mode (it asks), no plug-in tool", () => {
    const args = agentArgs(c, "hello");
    expect(args.slice(0, 7)).toEqual(["--restricted", "--tools", AGENT_TOOLS, "--permission-mode", "default", "--strict-mcp-config", "--disable-slash-commands"]);
    expect(AGENT_TOOLS.split(",")).toEqual(["Bash", "Read", "Edit", "Write", "Grep", "Glob"]);
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual(agentSettings(c));
    expect(args[args.length - 1]).toBe("hello");
    expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions|acceptEdits/);
  });

  it("no allow rule: only the hook lets a call run with no question", () => {
    expect(s.permissions.allow).toBeUndefined();
    expect(s.permissions.defaultMode).toBe("default");
    expect(s.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(s.permissions.ask).toEqual(["Bash(sudo *)"]);
  });

  it("the never list a second time, as deny rules: secrets, the code and the data, a public door, the pairing code", () => {
    for (const rule of ["WebFetch", "WebSearch", "Agent", "Read(~/.ssh/**)", "Read(**/.env)", "Read(~/.claude/**)", "Read(~/.config/gh/**)",
      "Read(//home/you/.local/share/choibot/**)", "Edit(//home/you/choibot/app/server/**)", "Edit(//home/you/choibot/app/bin/**)",
      "Bash(tailscale funnel *)", "Bash(sudo ufw allow *)", "Bash(/home/you/choibot/bin/choibot pair*)", "Bash(choibot pair*)"]) {
      expect(s.permissions.deny, rule).toContain(rule);
    }
  });

  it("the hook runs for every tool, with the console's own Node, and it gets this install", () => {
    const [entry] = s.hooks.PreToolUse;
    expect(entry.matcher).toBe("*");
    const m = entry.hooks[0].command.match(/^'\/home\/you\/choibot\/node\/bin\/node' '\/home\/you\/choibot\/app\/bin\/install-agent\/hook\.mjs' ([A-Za-z0-9_-]+)$/);
    expect(m).not.toBeNull();
    const ctx = JSON.parse(Buffer.from(m![1], "base64url").toString("utf8"));
    expect(ctx).toEqual(c);
    // The same context, through the rules.
    expect(decide("Bash", { command: "choibot doctor" }, ctx)?.decision).toBe("allow");
    expect(decide("Bash", { command: "choibot pair" }, ctx)?.decision).toBe("deny");
  });

  it("a folder name with a quote cannot break out of the hook command", () => {
    const odd = agentSettings({ ...c, app: "/home/you/it's/app" }, "/n/node") as Settings;
    expect(odd.hooks.PreToolUse[0].hooks[0].command).toContain("'/home/you/it'\\''s/app/bin/install-agent/hook.mjs'");
  });

  it("the prompt names the rules and the facts, and says that it cannot mark a step done", () => {
    const p = agentPrompt(c);
    expect(p).toContain("You cannot mark a step done: only its check does that.");
    expect(p).toContain("/home/you/choibot/bin/choibot doctor --details");
    expect(p).toContain("systemctl --user restart choibot.service");
  });
});

describe("what the model gets", () => {
  it("the last lines of the failed step, with no line that looks like a secret", () => {
    const many = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(forModel(many).split("\n")).toHaveLength(80);
    expect(forModel(many)).toContain("line 199");
    const leak = forModel("ok\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\nlast");
    expect(leak).toBe("ok\n[a line that looks like a secret was removed]\nlast");
    expect(firstMessage("Download", "x")).toContain("This step of the install failed: Download");
  });

  it("no agent context for a folder that is not an install of the script", () => {
    expect(agentCtx(app)).toBeNull();
    install();
    expect(agentCtx(app, { HOME: home })).toMatchObject({ base, app, cli: join(base, "bin", CLI_NAME), home });
  });
});
