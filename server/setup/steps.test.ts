// server/setup/steps.test.ts — the step list: its order, each check with fake probes, and the
// rule that only a passing check makes a step done.
import { describe, expect, it, vi } from "vitest";
import { CLI_NAME, DISPLAY_NAME } from "../brand.js";
import { ACCESS_READY, ACCESS_TUNNEL, PERSISTENT_NOT_READY,
  CHECK_FAILED, NOT_CHECKED, STEPS, cli, plain, runSteps, stepOf,
  type BoxFacts, type Probes, type StepId, type StepStatus,
} from "./steps.js";

const BOX: BoxFacts = {
  linux: true, node: "22.11.0", userServices: true, missingTools: [], checkout: true, settings: true,
  queue: true, staysOn: true, unknownFailures: 0, service: "running", answers: true,
};

// No bot, no account, no chat.
const NO_TG = { bot: "none", account: false, tested: false, name: null, tickets: false, master: false } as const;

// A box where every step is done.
function good(over: Partial<Probes> = {}): Probes {
  return {
    box: async () => BOX,
    claude: async () => ({ installed: true, loggedIn: true }),
    access: async () => ({ state: "ready" }),
    github: async () => ({ installed: true, login: "ada-dev", commitName: true }),
    repos: async () => ({ onBox: 2, canPush: "shop" }),
    devices: async () => ({ pairing: true, count: 2 }),
    agents: async () => ({ started: 1, running: 1, pullRequests: 1, tickets: true }),
    merged: async () => ({ count: 1 }),
    telegram: async () => ({ ...NO_TG, bot: "ok", account: true, tickets: true, master: true }),
    leads: async () => ({ on: true, live: 1 }),
    persistentLogin: async () => ({ wanted: true, ready: true, loggedIn: true, waits: [] }),
    ...over,
  };
}
const box = (over: Partial<BoxFacts>) => ({ box: async () => ({ ...BOX, ...over }) });
const by = (steps: StepStatus[], id: StepId): StepStatus => steps.find((s) => s.id === id)!;
const one = async (id: StepId, over: Partial<Probes>): Promise<StepStatus> => by(await runSteps(good(over)), id);

describe("the step list", () => {
  it("has the steps of the design, in order, with the optional ones last", () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      "install", "claude", "access", "pair", "github", "repo", "agent", "merge", "phone", "telegram", "lead", "persistent",
    ]);
    expect(STEPS.filter((s) => s.optional).map((s) => s.id)).toEqual(["phone", "telegram", "lead", "persistent"]);
  });

  it("needs only steps that come earlier", () => {
    STEPS.forEach((s, i) => {
      for (const n of s.needs ?? []) expect(STEPS.findIndex((x) => x.id === n), `${s.id} needs ${n}`).toBeLessThan(i);
    });
  });

  it("gives each step a plain title, one line of why, and a name for what completes it", () => {
    for (const s of STEPS) {
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.why, s.id).toMatch(/^[A-Z].*\.$/);
      expect(s.why.includes("\n"), s.id).toBe(false);
      expect(s.completes.name, s.id).toMatch(/^[a-z][a-z-]+$/);
      expect(["action", "form"], s.id).toContain(s.completes.kind);
    }
    expect(new Set(STEPS.map((s) => s.completes.name)).size).toBe(STEPS.length);
  });

  it("takes every name a user reads from the brand constants", () => {
    expect(stepOf("install").title).toBe(`Install ${DISPLAY_NAME}`);
    expect(stepOf("access").title).toBe(`Open ${DISPLAY_NAME} from your devices`);
    expect(cli("doctor")).toBe(`pnpm ${CLI_NAME} doctor`);
  });

  it("names the command of an install that the install script made (it gives its name in the env)", () => {
    const before = process.env.CHOIBOT_CLI;
    try {
      process.env.CHOIBOT_CLI = "choibot";
      expect(cli("doctor")).toBe("choibot doctor");
      process.env.CHOIBOT_CLI = "/home/you/choibot/bin/choibot";
      expect(cli("doctor")).toBe("/home/you/choibot/bin/choibot doctor");
      process.env.CHOIBOT_CLI = "rm -rf /; x";
      expect(cli("doctor")).toBe(`pnpm ${CLI_NAME} doctor`);
    } finally {
      if (before === undefined) delete process.env.CHOIBOT_CLI; else process.env.CHOIBOT_CLI = before;
    }
  });

  it("names the parts that exist today, and marks the others as not built", () => {
    expect(Object.fromEntries(STEPS.map((s) => [s.completes.name, s.completes.built]))).toEqual({
      setup: true, "claude-login": true, "private-address": false, "pair-device": true, "github-login": true,
      "repo-picker": true, "first-agent": true, merge: true, "add-device": true, telegram: true, "new-lead": true, "persistent-login": true,
    });
  });
});

describe("runSteps", () => {
  it("marks every step done on a box where every check passes", async () => {
    const steps = await runSteps(good());
    expect(steps.map((s) => s.state)).toEqual(STEPS.map(() => "done"));
    expect(steps.map((s) => s.id)).toEqual(STEPS.map((s) => s.id));
    expect(by(steps, "install").text).toBe("Node 22, the tools and the service are ready");
    expect(by(steps, "github").text).toBe("Connected as ada-dev");
    expect(by(steps, "repo").text).toBe("shop and 1 more");
    expect(by(steps, "pair").text).toBe("2 devices paired");
    expect(by(steps, "agent").text).toBe("1 agent at work");
    expect(by(steps, "lead").text).toBe("1 lead at work");
  });

  it("“Open … from your devices”: done with the private address, or with a paired device (the SSH tunnel)", async () => {
    const access = async (over: Partial<Probes>) => by(await runSteps(good(over)), "access");
    expect(await access({})).toMatchObject({ state: "done", text: ACCESS_READY });
    // No Tailscale at all, but the user opened the console and paired a device: the tunnel of the install.
    expect(await access({ access: async () => ({ state: "none" }) })).toMatchObject({ state: "done", text: ACCESS_TUNNEL });
    expect(await access({ access: async () => ({ state: "signed-out" }), devices: async () => ({ pairing: true, count: 1 }) })).toMatchObject({ state: "done", text: ACCESS_TUNNEL });
    // The private address wins: a new device can come in.
    expect((await access({ devices: async () => ({ pairing: true, count: 1 }) })).text).toBe(ACCESS_READY);
    // No device yet, or pairing is off: only the private address counts.
    expect((await access({ access: async () => ({ state: "none" }), devices: async () => ({ pairing: true, count: 0 }) })).state).toBe("todo");
    expect((await access({ access: async () => ({ state: "none" }), devices: async () => ({ pairing: false, count: 3 }) })).state).toBe("todo");
  });

  it("a reader with no device list (the CLI with the console stopped) keeps the reason of the box", async () => {
    const { devices: _d, ...noDevices } = good({ access: async () => ({ state: "none" }) });
    expect(by(await runSteps(noDevices), "access")).toMatchObject({ state: "todo", text: "Tailscale is not on your server. It gives the console a private address." });
  });

  it("with the tunnel only, the set-up can end: each required step is done", async () => {
    const steps = await runSteps(good({ access: async () => ({ state: "none" }) }));
    expect(steps.filter((s) => !s.optional && s.state !== "done")).toEqual([]);
  });

  it("shows a part that completes a step only when it is built", async () => {
    const steps = await runSteps(good());
    expect(by(steps, "install").completes).toEqual({ kind: "action", name: "setup" });
    expect(by(steps, "telegram").completes).toEqual({ kind: "form", name: "telegram" });
    for (const s of STEPS.filter((x) => !x.completes.built)) expect(by(steps, s.id).completes, s.id).toBeUndefined();
    expect(by(steps, "github").completes).toEqual({ kind: "action", name: "github-login" });
    expect(by(steps, "repo").completes).toEqual({ kind: "form", name: "repo-picker" });
    expect(by(steps, "agent").completes).toEqual({ kind: "action", name: "first-agent" });
    expect(by(steps, "phone").completes).toEqual({ kind: "form", name: "add-device" });
    // The Claude login is on the page (the sign-in link and its code): no terminal.
    expect(by(steps, "claude").completes).toEqual({ kind: "form", name: "claude-login" });
    expect(JSON.stringify(steps)).not.toMatch(/built|private-address/);
  });

  it("runs a probe one time for all the steps that read it", async () => {
    const devices = vi.fn(async () => ({ pairing: true, count: 2 }));
    await runSteps(good({ devices }));
    expect(devices).toHaveBeenCalledTimes(1); // pair and phone
  });

  it("never reports done when the check throws, and tells the caller why", async () => {
    const errors: StepId[] = [];
    const broken = new Proxy(good(), { get: () => async () => { throw new Error("boom at /home/you/.env"); } });
    const steps = await runSteps(broken, { onError: (id) => errors.push(id) });
    expect(steps.filter((s) => s.state === "done")).toEqual([]);
    for (const s of STEPS.filter((x) => !x.needs)) expect(by(steps, s.id), s.id).toMatchObject({ state: "todo", text: CHECK_FAILED });
    expect(JSON.stringify(steps)).not.toContain("boom");
    expect(errors).toEqual(STEPS.map((s) => s.id));
  });

  it("never reports done when a probe gives a fact of the wrong shape", async () => {
    const steps = await runSteps(good({ box: async () => null as never, devices: async () => undefined as never }));
    for (const id of ["install", "pair", "phone"] as const) expect(by(steps, id).state, id).not.toBe("done");
  });

  it("leaves a step open when the reader has no probe for it", async () => {
    const { devices: _d, agents: _a, ...rest } = good();
    const steps = await runSteps(rest);
    expect(by(steps, "pair")).toMatchObject({ state: "todo", text: NOT_CHECKED });
    expect(by(steps, "agent")).toMatchObject({ state: "todo", text: NOT_CHECKED });
    expect(by(steps, "merge").state).toBe("done"); // its own check passed
  });

  it("the app's key works but could not be saved: done, with the line to connect again after a restart", async () => {
    const steps = await runSteps(good({ github: async () => ({ installed: true, login: "ada-dev", commitName: true, unsaved: true }) }));
    expect(by(steps, "github")).toMatchObject({
      state: "done", text: "Connected as ada-dev. Your server could not save the new key: after a restart, connect GitHub again.",
    });
  });

  it("says which step comes first when an earlier step is open", async () => {
    const steps = await runSteps(good({
      github: async () => ({ installed: true, login: null, problem: "signed-out", commitName: false }),
      repos: async () => ({ onBox: 0, canPush: null }),
      agents: async () => ({ started: 0, running: 0, pullRequests: 0, tickets: true }),
      merged: async () => ({ count: 0 }),
      leads: async () => ({ on: true, live: 0 }),
    }));
    expect(by(steps, "github")).toMatchObject({ state: "todo", text: "GitHub is not connected.", error: "GitHub answered: not logged in." });
    expect(by(steps, "repo")).toMatchObject({ state: "blocked", blockedBy: "github", text: "First: Connect GitHub." });
    expect(by(steps, "agent")).toMatchObject({ state: "blocked", blockedBy: "repo", text: "First: Pick a repo." });
    expect(by(steps, "merge")).toMatchObject({ state: "blocked", blockedBy: "agent" });
    expect(by(steps, "lead")).toMatchObject({ state: "blocked", blockedBy: "repo" });
    expect(by(steps, "repo").error).toBeUndefined();
  });

  it("keeps a step done when its own check passes, also with an earlier step open", async () => {
    const steps = await runSteps(good({ claude: async () => ({ installed: true, loggedIn: false }) }));
    expect(by(steps, "claude").state).toBe("todo");
    expect(by(steps, "agent").state).toBe("done");
  });
});

describe("each check", () => {
  const cases: Array<[StepId, string, Partial<Probes>, string, string?]> = [
    ["install", "not Linux", box({ linux: false }), `This server does not run Linux. ${DISPLAY_NAME} needs Linux.`],
    ["install", "an old Node", box({ node: "18.19.1" }), `This server has Node 18. ${DISPLAY_NAME} needs Node 22 or newer.`],
    ["install", "no Node version", box({ node: "" }), `This server has an unknown Node version. ${DISPLAY_NAME} needs Node 22 or newer.`],
    ["install", "no user services", box({ userServices: false }), "This user cannot run services on your server. Log in to your server as this user with SSH, not with su."],
    ["install", "one tool missing", box({ missingTools: ["dtach"] }), "dtach is not on your server."],
    ["install", "tools missing", box({ missingTools: ["git", "dtach", "the build tools"] }), "git, dtach and the build tools are not on your server."],
    ["install", "not an install", box({ checkout: false }), `This folder is not an install of ${DISPLAY_NAME}.`],
    ["install", "settings", box({ settings: false }), "The settings of the console are not complete."],
    ["install", "queue settings", box({ queue: false }), "The Queue is on, but its settings are not complete."],
    ["install", "stops at logout", box({ staysOn: false }), `${DISPLAY_NAME} stops when you log out of your server.`],
    ["install", "an unknown technical failure", box({ unknownFailures: 1 }), "A technical check failed."],
    ["install", "no service", box({ service: "none" }), `The service of ${DISPLAY_NAME} is not installed.`],
    ["install", "service stopped", box({ service: "stopped" }), `The service of ${DISPLAY_NAME} does not run.`],
    ["install", "no answer", box({ answers: false }), `${DISPLAY_NAME} does not answer on this server.`],
    ["claude", "no program", { claude: async () => ({ installed: false, loggedIn: true }) }, "The Claude program is not on your server."],
    ["claude", "no login", { claude: async () => ({ installed: true, loggedIn: false }) }, "Claude is not logged in on your server."],
    // No device is paired yet: only the private address can make the step done.
    ["access", "no Tailscale", { access: async () => ({ state: "none" }), devices: async () => ({ pairing: true, count: 0 }) }, "Tailscale is not on your server. It gives the console a private address."],
    ["access", "signed out", { access: async () => ({ state: "signed-out" }), devices: async () => ({ pairing: true, count: 0 }) }, "Tailscale is on your server, but it is not signed in."],
    ["access", "no address", { access: async () => ({ state: "no-address" }), devices: async () => ({ pairing: true, count: 0 }) }, "The console has no private address yet."],
    ["pair", "pairing off", { devices: async () => ({ pairing: false, count: 0 }) }, "Device pairing is off on this console."],
    ["pair", "no device", { devices: async () => ({ pairing: true, count: 0 }) }, "No device is paired yet."],
    ["github", "no tool", { github: async () => ({ installed: false, login: null, commitName: true }) }, "The GitHub tool is not on your server."],
    ["github", "signed out", { github: async () => ({ installed: true, login: null, problem: "signed-out", commitName: true }) }, "GitHub is not connected.", "GitHub answered: not logged in."],
    ["github", "no answer", { github: async () => ({ installed: true, login: null, problem: "no-answer", commitName: true }) }, "GitHub is not connected.", "GitHub did not answer."],
    ["github", "no commit name", { github: async () => ({ installed: true, login: "ada-dev", commitName: false }) }, "GitHub is connected as ada-dev. Your server has no name and e-mail for commits yet."],
    // The GitHub app switch is on: only the app's key makes the step done.
    ["github", "app not connected", { github: async () => ({ installed: true, login: null, problem: "app-none", commitName: true }) }, "GitHub is not connected."],
    ["github", "app refused", { github: async () => ({ installed: true, login: null, problem: "app-refused", commitName: true }) }, "GitHub no longer takes the key of your server.", "Connect GitHub again."],
    ["github", "app key ended", { github: async () => ({ installed: true, login: null, problem: "app-ended", commitName: true }) }, "The GitHub key of your server ran out.", "Connect GitHub again."],
    ["repo", "no repo", { repos: async () => ({ onBox: 0, canPush: null }) }, "No repo is on your server yet."],
    ["repo", "read only", { repos: async () => ({ onBox: 2, canPush: null }) }, "GitHub gives no push access to the repos on your server. Agents cannot open pull requests there."],
    ["agent", "none", { agents: async () => ({ started: 0, running: 0, pullRequests: 0, tickets: true }) }, "No agent has started yet."],
    ["merge", "none", { merged: async () => ({ count: 0 }) }, "No pull request of an agent is merged yet."],
    ["phone", "pairing off", { devices: async () => ({ pairing: false, count: 0 }) }, "First: Pair this device."],
    ["phone", "one device", { devices: async () => ({ pairing: true, count: 1 }) }, "Only 1 device is paired."],
    ["telegram", "no bot", { telegram: async () => NO_TG }, "No Telegram bot is set up."],
    ["telegram", "bot fails", { telegram: async () => ({ ...NO_TG, bot: "failed", tickets: true, master: true }) }, "The Telegram bot does not work.", "Telegram did not accept the bot, or it did not answer."],
    ["telegram", "no message yet", { telegram: async () => ({ ...NO_TG, bot: "ok" }) }, "The bot works. It waits for your message."],
    ["telegram", "no test message", { telegram: async () => ({ ...NO_TG, bot: "ok", account: true, tickets: true }) }, "Your Telegram account is connected, but no test message went out yet."],
    ["telegram", "an account, but no ticket comes", { telegram: async () => ({ ...NO_TG, bot: "ok", account: true, tested: true }) }, "Your Telegram account is connected, but the Queue of this console does not run, so no ticket comes to Telegram."],
    ["lead", "leads off", { leads: async () => ({ on: false, live: 0 }) }, "Leads are off on this console."],
    ["lead", "no lead", { leads: async () => ({ on: true, live: 0 }) }, "No lead runs yet."],
    ["persistent", "not signed in", { persistentLogin: async () => ({ wanted: true, ready: true, loggedIn: false, waits: [] }) }, "Not signed in yet. Sign in when you want them."],
    ["persistent", "agents wait", { persistentLogin: async () => ({ wanted: true, ready: true, loggedIn: false, waits: ["fleet-master", "coordinator", "lead-app"] }) }, "The fleet master, the helper for tickets and the lead for app wait for this sign-in."],
    ["persistent", "not ready (its settings or its helper): no sign-in offered, the command of the server", { persistentLogin: async () => ({ wanted: true, ready: false, loggedIn: false, waits: ["fleet-master"] }) }, PERSISTENT_NOT_READY],
    ["persistent", "one waits", { persistentLogin: async () => ({ wanted: true, ready: true, loggedIn: false, waits: ["lead-app"] }) }, "The lead for app waits for this sign-in."],
  ];

  it("the second sign-in has a row only where the second account is asked for (no row without it, or without its probe)", async () => {
    expect(by(await runSteps(good()), "persistent")).toMatchObject({ state: "done", text: "Signed in", optional: true });
    const none = await runSteps(good({ persistentLogin: async () => ({ wanted: false, ready: false, loggedIn: false, waits: [] }) }));
    expect(none.map((s) => s.id)).not.toContain("persistent");
    const { persistentLogin: _gone, ...noProbe } = good();
    expect((await runSteps(noProbe)).map((s) => s.id)).not.toContain("persistent");
    // Not ready: the command of the server (the RUNBOOK's), and no technical cause on the page.
    expect(PERSISTENT_NOT_READY).toBe("Your server is not ready for this sign-in yet. Run strong-setup again on your server, as root, then press Check again.");
    // Its words name no account, uid or folder.
    const step = STEPS.find((s) => s.id === "persistent")!;
    expect(`${step.title} ${step.why}`).not.toMatch(/uid|folder|Linux|account on|choibot-|CHIEF_/i);
  });

  it("Telegram is done only when tickets really come: to the connected chat after the test message, or to the fleet master chat", async () => {
    const tg = (over: object) => ({ telegram: async () => ({ ...NO_TG, bot: "ok" as const, ...over }) });
    // "Connect your chat" alone: the ticket cards go to the user's chat with the bot.
    expect(by(await runSteps(good(tg({ account: true, tested: true, tickets: true, name: "@ada" }))), "telegram")).toMatchObject({ state: "done", text: "Tickets come to @ada in Telegram" });
    expect(by(await runSteps(good(tg({ account: true, tested: true, tickets: true }))), "telegram")).toMatchObject({ state: "done", text: "Tickets come to Telegram" });
    // An account with no ticket card is never "done".
    expect(by(await runSteps(good(tg({ account: true, tested: true, name: "@ada" }))), "telegram").state).not.toBe("done");
    // The owner's console: the ids are in its settings, no test message is on record.
    expect(by(await runSteps(good(tg({ account: true, tickets: true, master: true }))), "telegram")).toMatchObject({ state: "done", text: "Tickets come to Telegram" });
  });

  it.each(cases)("%s: %s", async (id, _name, over, text, error) => {
    const s = await one(id, over);
    expect(s.state).not.toBe("done");
    expect(s.text).toBe(text);
    expect(s.error).toBe(error);
  });

  it("covers every step with a failing case", () => {
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(STEPS.map((s) => s.id)));
  });

  it("keeps the agent step open until a pull request is on record", async () => {
    const agents = (started: number, running: number, pullRequests: number, tickets = true) => ({ agents: async () => ({ started, running, pullRequests, tickets }) });
    expect(await one("agent", agents(1, 1, 0))).toMatchObject({ state: "todo", text: "An agent works. Its pull request is not open yet." });
    expect(await one("agent", agents(1, 0, 0))).toMatchObject({ state: "todo", text: "An agent started, but no pull request is on record yet." });
    expect(await one("agent", agents(1, 1, 1))).toMatchObject({ state: "done", text: "1 agent at work" });
    expect(await one("agent", agents(18, 0, 40))).toMatchObject({ state: "done", text: "Started" });
    // A console with no Queue has no tickets: an agent that started is enough there, as before.
    expect(await one("agent", agents(1, 0, 0, false))).toMatchObject({ state: "done", text: "Started" });
    expect(await one("agent", agents(0, 0, 0, false))).toMatchObject({ state: "todo", text: "No agent has started yet." });
  });

  it("counts a first agent that is gone when its pull request is on record", async () => {
    expect(await one("agent", { agents: async () => ({ started: 0, running: 0, pullRequests: 1, tickets: true }) })).toMatchObject({ state: "done", text: "Started" });
  });

  it("says one repo by its name", async () => {
    expect((await one("repo", { repos: async () => ({ onBox: 1, canPush: "shop" }) })).text).toBe("shop");
  });
});

describe("what a user reads", () => {
  const PATH = /(^|[\s"'(=:])~?\/[\w.-]+/;
  const KEY = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;

  it("has no file path and no settings key in any title, why or state text", async () => {
    const texts: string[] = STEPS.flatMap((s) => [s.title, s.why]);
    // Every failing case of every step, and the all-done case.
    const overs: Array<Partial<Probes>> = [
      {}, box({ linux: false }), box({ node: "18.0.0" }), box({ userServices: false }), box({ missingTools: ["git"] }),
      box({ checkout: false }), box({ settings: false }), box({ queue: false }), box({ staysOn: false }), box({ unknownFailures: 2 }),
      box({ service: "none" }), box({ service: "stopped" }), box({ answers: false }),
      { claude: async () => ({ installed: false, loggedIn: false }) }, { access: async () => ({ state: "none" }) },
      { github: async () => ({ installed: true, login: null, problem: "no-answer", commitName: false }) },
      { devices: async () => ({ pairing: true, count: 0 }) }, { telegram: async () => ({ ...NO_TG, bot: "failed" }) },
    ];
    for (const over of overs) for (const s of await runSteps(good(over))) texts.push(s.text, s.error ?? "");
    for (const t of texts) {
      expect(t, t).not.toMatch(PATH);
      expect(t, t).not.toMatch(KEY);
    }
  });

  it("drops a path or a settings key that comes in with a fact", async () => {
    const steps = await runSteps(good({
      github: async () => ({ installed: true, login: "/home/you/.config/gh", commitName: true }),
      repos: async () => ({ onBox: 1, canPush: "TELEGRAM_BOT_TOKEN" }),
    }));
    expect(by(steps, "github").text).toBe("Connected as a file");
    expect(by(steps, "repo").text).toBe("a setting");
    expect(plain("see ~/.config/x and /tmp, key=CHIEF_ENABLED")).toBe("see a file and a file, key=a setting");
    expect(plain("Open github.com/login/device or https://box.example.ts.net/#claim=K7QF")).toBe("Open github.com/login/device or https://box.example.ts.net/#claim=K7QF");
  });
});
