// bin/lib/doctor.steps.test.ts — `doctor` speaks the step list (server/setup/steps.ts): the
// technical checks become facts of the box, the running console gives the steps only it knows,
// and the exit code stays the technical one. The exec seam is mocked: nothing is spawned.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./exec.js", () => ({ which: vi.fn(), run: vi.fn() }));
// The GitHub probe runs through the server's own gh helper: here it is not logged in.
vi.mock("../../server/gh/exec.js", async (orig) => {
  const real = await orig<typeof import("../../server/gh/exec.js")>();
  return { ...real, gh: vi.fn(async () => { throw new real.GhError("not_authed", "gh auth login"); }) };
});
import { which, run } from "./exec.js";
import {
  CONSOLE_DOWN, CONSOLE_LOCKED, CONSOLE_OLD, FACT_CHECKS, NO_DEVICE, TOOL_CHECKS, boxFactsOf, cliSteps, formatSteps, hasRequiredFailure,
  runChecks, runDoctor, serviceState, type CheckResult,
} from "./doctor.js";
import { DISPLAY_NAME } from "../../server/brand.js";
import { CONSOLE_HEADER } from "../../server/chief/auth.js";
import { STEPS, cli, stepOf, type StepId, type StepStatus } from "../../server/setup/steps.js";

let repo: string;
const out: string[] = [];
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "doctor-steps-"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, ".env"), "CONSOLE_COOKIE_SECRET=an-actually-random-secret-value-here-32\nWORKSPACE_DIR=/srv/ws\nPORT=45999\n");
  vi.mocked(which).mockReset().mockImplementation(async (b) => `/usr/bin/${b}`);
  vi.mocked(run).mockReset().mockResolvedValue({ code: 0, stdout: "Linger=yes\n", stderr: "" });
  out.length = 0;
  vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const by = (steps: StepStatus[], id: StepId): StepStatus => steps.find((s) => s.id === id)!;
// A step that a console may leave out (the second sign-in) has no row in the CLI's own checks.
const consoleIds = STEPS.filter((s) => s.on === "console" && !s.sometimes).map((s) => s.id);

describe("the technical checks as facts of the box", () => {
  it("has a plain fact for every required technical check", async () => {
    const required = (await runChecks(repo)).filter((r) => r.required).map((r) => r.name);
    expect(required.length).toBeGreaterThan(8);
    for (const name of required) expect(Object.hasOwn(TOOL_CHECKS, name) || FACT_CHECKS.includes(name), name).toBe(true);
  });

  it("maps each failing required check to its fact", () => {
    const res = (failing: string[]): CheckResult[] =>
      [...Object.keys(TOOL_CHECKS), ...FACT_CHECKS, "gh"].map((name) => ({ name, required: name !== "gh", ok: !failing.includes(name), detail: "" }));
    const live = { service: "running" as const, answers: true };
    expect(boxFactsOf(res([]), live)).toEqual({
      linux: true, node: process.versions.node, userServices: true, missingTools: [], checkout: true, settings: true,
      queue: true, staysOn: true, unknownFailures: 0, service: "running", answers: true,
    });
    expect(boxFactsOf(res(["platform"]), live).linux).toBe(false);
    expect(boxFactsOf(res(["systemd (user)"]), live).userServices).toBe(false);
    expect(boxFactsOf(res(["git", "claude", "build tools"]), live).missingTools).toEqual(["git", "Claude Code", "the build tools"]);
    expect(boxFactsOf(res(["git repo"]), live).checkout).toBe(false);
    expect(boxFactsOf(res([".env"]), live).settings).toBe(false);
    expect(boxFactsOf(res(["chief"]), live).queue).toBe(false);
    expect(boxFactsOf(res(["linger"]), live).staysOn).toBe(false);
    // An advisory check never counts. A required one with no fact of its own still does.
    expect(boxFactsOf(res(["gh"]), live).unknownFailures).toBe(0);
    expect(boxFactsOf([{ name: "a new check", required: true, ok: false, detail: "" }], live).unknownFailures).toBe(1);
  });

  it("runs only the required checks when asked, on the settings it is given", async () => {
    rmSync(join(repo, ".env"));
    const res = await runChecks(repo, { requiredOnly: true, env: new Map([["CONSOLE_COOKIE_SECRET", "an-actually-random-secret-value-here-32"], ["WORKSPACE_DIR", "/srv/ws"]]) });
    expect(res.every((r) => r.required)).toBe(true);
    expect(res.find((r) => r.name === ".env")!.ok).toBe(true);
    expect(hasRequiredFailure(res)).toBe(false);
    // Without the given settings the missing file fails, as before.
    expect((await runChecks(repo)).find((r) => r.name === ".env")!.ok).toBe(false);
  });

  it("reads the state of the service", async () => {
    expect(await serviceState("x.service")).toBe("running");
    vi.mocked(run).mockImplementation(async (_c, args) => ({ code: args.includes("is-active") ? 3 : 0, stdout: "", stderr: "" }));
    expect(await serviceState("x.service")).toBe("stopped");
    vi.mocked(run).mockResolvedValue({ code: 1, stdout: "", stderr: "No files found" });
    expect(await serviceState("x.service")).toBe("none");
  });
});

describe("cliSteps", () => {
  it("checks the steps of the box itself and leaves the others open when the console does not run", async () => {
    const steps = await cliSteps(repo, await runChecks(repo), { fetch: down });
    // A step that a console may leave out (the second sign-in) has no row in the CLI's own checks.
    expect(steps.map((s) => s.id)).toEqual(STEPS.filter((s) => !s.sometimes).map((s) => s.id));
    expect(by(steps, "install")).toMatchObject({ state: "todo", text: `${DISPLAY_NAME} does not answer on this server.` });
    for (const id of consoleIds) expect(by(steps, id), id).toMatchObject({ state: "todo", text: CONSOLE_DOWN });
    expect(by(steps, "github").text).toBe("GitHub is not connected."); // checked here, with the mocked gh
  });

  it("asks the running console on its own port, and takes its state for the steps only it knows", async () => {
    const f = answer({ steps: [
      { id: "pair", state: "done", text: "1 device paired" },
      { id: "agent", state: "blocked", text: "First: Pick a repo.", blockedBy: "repo" },
      { id: "merge", state: "todo", text: "No pull request of an agent is merged yet.", error: "see /home/you/x" },
      // The console's word on a step of the box is not taken: the CLI checked it itself.
      { id: "github", state: "done", text: "Connected as somebody" },
      { id: "phone", state: "finished", text: "?" },
      null,
    ] });
    const steps = await cliSteps(repo, await runChecks(repo), { fetch: f });
    expect(vi.mocked(f).mock.calls[0][0]).toBe("http://127.0.0.1:45999/api/setup/steps");
    expect(by(steps, "install")).toMatchObject({ state: "done" });
    expect(by(steps, "pair")).toMatchObject({ state: "done", text: "1 device paired", title: stepOf("pair").title });
    expect(by(steps, "agent")).toMatchObject({ state: "blocked", blockedBy: "repo" });
    expect(by(steps, "merge")).toMatchObject({ state: "todo", error: "see a file" });
    expect(by(steps, "github").state).toBe("todo");
    expect(by(steps, "phone")).toMatchObject({ state: "todo", text: CONSOLE_OLD }); // a state it does not know
    expect(by(steps, "lead")).toMatchObject({ state: "todo", text: CONSOLE_OLD });  // not in the answer
  });

  it("strong protection: the console's own account sends the token that only it can read; else nothing", async () => {
    const chief = join(repo, "chief-data");
    mkdirSync(chief, { recursive: true });
    writeFileSync(join(repo, ".env"), `CONSOLE_COOKIE_SECRET=an-actually-random-secret-value-here-32\nWORKSPACE_DIR=/srv/ws\nPORT=45999\nCHIEF_DATA_DIR=${chief}\n`);
    const none = answer({ steps: [] });
    await cliSteps(repo, await runChecks(repo), { fetch: none });
    expect((vi.mocked(none).mock.calls[0] as unknown[])[1]).not.toHaveProperty("headers");
    writeFileSync(join(chief, "console-token"), `${"t".repeat(43)}\n`, { mode: 0o600 });
    const f = answer({ steps: [] });
    await cliSteps(repo, await runChecks(repo), { fetch: f });
    expect((vi.mocked(f).mock.calls[0] as unknown[])[1]).toMatchObject({ headers: { [CONSOLE_HEADER]: "t".repeat(43) } });
  });

  it("“Open … from your devices” is done when the running console says so (a paired device: the SSH tunnel)", async () => {
    // The box itself has no private address: the mocked `tailscale serve status` names no port of this console.
    const tunnel = answer({ steps: [{ id: "access", state: "done", text: "Open through the SSH tunnel" }] });
    expect(by(await cliSteps(repo, await runChecks(repo), { fetch: tunnel }), "access")).toMatchObject({ state: "done", text: "Open through the SSH tunnel" });
    // The console's "not done" is not taken: the CLI checked the box itself, and its reason stays.
    const open = answer({ steps: [{ id: "access", state: "todo", text: "something else" }] });
    const a = by(await cliSteps(repo, await runChecks(repo), { fetch: open }), "access");
    expect(a.state).toBe("todo");
    expect(a.text).not.toBe("something else");
    // The console does not run: the facts of the box only.
    expect(by(await cliSteps(repo, await runChecks(repo), { fetch: down }), "access").state).toBe("todo");
  });

  it("a console that is locked to its pairing screen: the pair step is open, the others wait for it", async () => {
    const steps = await cliSteps(repo, await runChecks(repo), { fetch: answer({ error: "pair-required", userAuth: "log", locked: true }, 403) });
    expect(by(steps, "install").state).toBe("done"); // it answers
    expect(by(steps, "pair")).toMatchObject({ state: "todo", text: NO_DEVICE, completes: { name: "pair-device" } });
    for (const id of consoleIds.filter((x) => x !== "pair")) expect(by(steps, id), id).toMatchObject({ state: "todo", text: CONSOLE_LOCKED });
    expect(formatSteps(steps)).toContain(`To pair a device: ${cli("pair")}`);
    // Another 403 is not the lock.
    const other = await cliSteps(repo, await runChecks(repo), { fetch: answer({ error: "pair-required" }, 403) });
    expect(by(other, "pair").text).toBe(CONSOLE_OLD);
  });

  it("says the console is an older version when it answers without the list", async () => {
    const steps = await cliSteps(repo, await runChecks(repo), { fetch: answer({ error: "not found" }, 404) });
    expect(by(steps, "install").state).toBe("done"); // it answers
    for (const id of consoleIds) expect(by(steps, id).text, id).toBe(CONSOLE_OLD);
  });
});

describe("formatSteps", () => {
  const s = (id: StepId, state: StepStatus["state"], text: string, error?: string): StepStatus =>
    ({ id, title: stepOf(id).title, why: stepOf(id).why, optional: stepOf(id).optional === true, state, text, ...(error ? { error } : {}) });

  it("prints the plain titles, the count, and the optional steps apart", () => {
    const text = formatSteps([
      s("claude", "done", "Logged in"), s("github", "todo", "GitHub is not connected.", "GitHub answered: not logged in."),
      s("repo", "blocked", "First: Connect GitHub."), s("telegram", "todo", "No Telegram bot is set up."), s("lead", "done", "1 lead at work"),
    ]);
    expect(text.split("\n")).toEqual([
      `Set-up of ${DISPLAY_NAME}: 1 of 3 steps done`,
      "",
      "✔ Log in to Claude      Logged in",
      "✖ Connect GitHub        GitHub is not connected.",
      "                        Last error: GitHub answered: not logged in.",
      "– Pick a repo           First: Connect GitHub.",
      "",
      "Optional, when you want",
      "○ Telegram              No Telegram bot is set up.",
      "✔ A lead for your repo  1 lead at work",
    ]);
  });
});

describe("runDoctor", () => {
  it("prints the step list in plain words and exits 0 when every required technical check passes", async () => {
    expect(await runDoctor(repo, { fetch: down })).toBe(0);
    const text = out.join("\n");
    for (const step of STEPS.filter((s) => !s.sometimes)) expect(text).toContain(step.title);
    expect(text).toContain(`For the technical checks: ${cli("doctor --details")}`);
    expect(text).not.toContain("Technical checks\n");
    expect(text).not.toMatch(/WORKSPACE_DIR|CONSOLE_COOKIE_SECRET|\.env|\/srv\/ws/);
  });

  it("exits 1 when a required technical check fails, as before, and says so", async () => {
    vi.mocked(which).mockImplementation(async (b) => (b === "dtach" ? null : `/usr/bin/${b}`));
    expect(hasRequiredFailure(await runChecks(repo))).toBe(true);
    expect(await runDoctor(repo, { fetch: down })).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("dtach is not on your server.");
    expect(text).toContain(`To repair: ${cli("setup")}`);
    expect(text).toContain("A technical check failed. For the technical checks:");
  });

  it("keeps exit 0 when only steps are open: a step never changes the exit code", async () => {
    const f = answer({ steps: STEPS.map((x) => ({ id: x.id, state: "todo", text: "open" })) });
    expect(await runDoctor(repo, { fetch: f })).toBe(0);
  });

  it("adds the technical checks with --details", async () => {
    expect(await runDoctor(repo, { details: true, fetch: down })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("Technical checks\n");
    expect(text).toMatch(/✔ platform\s+linux/);
    expect(text).toMatch(/✔ linger\s+enabled/);
  });
});
