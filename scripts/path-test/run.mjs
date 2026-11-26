#!/usr/bin/env node
// scripts/path-test/run.mjs — the new-server test: ONE command that runs the whole path of a
// new user on a clean install, from the install line to the first merged pull request and the
// optional steps, and says pass or fail for each step. README.md next to this file says what
// it proves, what it cannot prove, and the checks a person does on the first real server.
//
//   CHOIBOT_TEST_PLAYWRIGHT=<folder of playwright-core> pnpm test:path [--keep] [--until <step>] [--out <folder>]
//
// It runs two installs, each in a throwaway folder with its own HOME, an empty environment and
// a PATH of fakes (scripts/install-test/run.sh):
//   A  "phone and laptop": the happy path, at the private address (a fake Tailscale).
//   B  "laptop only, and things go wrong": the SSH tunnel address, and the failures that the
//      design names and that a script can make happen.
// Nothing of a console that runs on this machine is touched: the last steps prove it.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Fail, PRIVATE_NAME, Root, Steps, findPlaywright, freePort, haveOpenssl, listenersOf, must, mustBePlain, mustHave,
  notPlain, portDiff, sha256, sleep, snapshot, snapshotDiff, stopCommands,
} from "./lib/harness.mjs";
import { TG_USER, fakePrivateAddress, fakeTelegram } from "./lib/net.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const KEEP = flag("--keep");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const OUT = value("--out") ?? join(tmpdir(), `choibot-path-test-${stamp}`);
const tag = Math.random().toString(36).slice(2, 8);
const P = `https://${PRIVATE_NAME}`;
const REPOS = [
  { slug: "ada-dev/hello", private: true, archived: false, language: "JavaScript", pushedAt: new Date(Date.now() - 3_600_000).toISOString(), sizeKb: 120, push: true },
  { slug: "ada-dev/notes", private: false, archived: false, language: "Markdown", pushedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(), sizeKb: 40, push: true },
  { slug: "some-org/big-app", private: true, archived: false, language: "TypeScript", pushedAt: new Date(Date.now() - 86_400_000).toISOString(), sizeKb: 900_000, push: false },
  { slug: "ada-dev/old-site", private: false, archived: true, language: "HTML", pushedAt: "2023-01-10T10:00:00Z", sizeKb: 300, push: true },
];
const CODE_RE = /\b[0-9A-Z]{4}-[0-9A-Z]{4}\b/;
// --shots <folder>: a picture of some screens of the path, for a person who reads a change.
const SHOTS = value("--shots");
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: join(SHOTS, `${name}.png`) }).catch(() => {}); };
const PR_TITLE = 'Add a "Run it locally" section to the README';

const chromium = await findPlaywright();
if (!chromium) {
  console.error([
    "The path test needs a headless browser: playwright-core with its Chromium.",
    "This repo does not depend on it. Give the folder of an installed playwright-core:",
    "",
    "  CHOIBOT_TEST_PLAYWRIGHT=<folder of playwright-core> pnpm test:path",
    "",
    "(For example: `npm install playwright-core` in a folder outside this repo, then",
    "`npx playwright-core install chromium`.)",
  ].join("\n"));
  process.exit(2);
}
if (!haveOpenssl()) { console.error("The path test needs `openssl` for the certificate of its fake private address."); process.exit(2); }

const S = new Steps(OUT, { until: value("--until") });
const A = new Root(`/tmp/choibot-it-pa${tag}`, await freePort());
const B = new Root(`/tmp/choibot-it-pb${tag}`, await freePort());
let tg, address, browser, laptop, page, phone;
const before = await snapshot();
console.log(`The new-server test. Output folder of a failed step: ${OUT}\n`);

// ------------------------------------------------------------------ helpers

const text = async (loc) => (await loc.innerText({ timeout: 15_000 })).replace(/\n{2,}/g, "\n");
const body = (pg) => text(pg.locator("body"));

// Ask until `fn` gives a value that is not false. Else: fail with `what` and the last text.
async function until(fn, what, ms = 30_000, every = 400) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last !== false && last !== null && last !== undefined) return last; } catch (e) { last = `(${e?.message?.split("\n")[0]})`; }
    if (Date.now() >= end) throw new Fail(`${what} (waited ${Math.round(ms / 1000)} s)${typeof last === "string" ? `\n--- last seen:\n${last.slice(-1200)}` : ""}`);
    await sleep(every);
  }
}
// Wait for a text on the page. The value while it waits is the text itself, for the report.
const see = (loc, part, what, ms = 30_000) => {
  let last = "";
  return until(async () => { last = await text(loc); return (typeof part === "string" ? last.includes(part) : part.test(last)) ? last : false; }, what, ms)
    .catch((e) => { throw new Fail(`${e.message.split("\n")[0]}\n--- the page said:\n${last.slice(-1500)}`); });
};
// A page reacts to a click only when its code has loaded: press until the target shows.
async function press(button, shows, what, ms = 20_000) {
  await until(async () => { if (await shows()) return true; await button.click({ timeout: 3000 }).catch(() => {}); await sleep(600); return (await shows()) || false; }, what, ms, 300);
}
// A call of the console from the page itself, as the paired device.
const api = (pg, path) => pg.evaluate(async (p) => {
  const token = localStorage.getItem("choibot.userToken");
  const r = await fetch(p, { headers: token ? { "x-choibot-user": token } : {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}, path);
const steps = async (pg) => Object.fromEntries(((await api(pg, "/api/setup/steps")).body?.steps ?? []).map((s) => [s.id, s]));
// A POST of the page itself, as the paired device.
const apiPost = (pg, path, payload = {}) => pg.evaluate(async ([p, b]) => {
  const token = localStorage.getItem("choibot.userToken");
  const r = await fetch(p, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-choibot-user": token } : {}) }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, payload]);

// The rows of the Set-up list. A card in the thread of the guide has the same mark: the list
// is the part that works with no guide, so the test presses there.
function rows(pg) {
  const row = (id) => pg.locator(`[data-step=${id}]:not(section[aria-label=Guide] *)`).first();
  const open = async (id) => {
    const head = row(id).locator("button").first();
    await head.waitFor({ timeout: 20_000 });
    if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
    return row(id);
  };
  // The state of a step as the page shows it, with no reload.
  const state = (id, want, what, ms = 40_000) => until(async () => ((await row(id).getAttribute("data-state")) === want ? true : text(row(id)).then(() => false)), what, ms)
    .catch(async (e) => { throw new Fail(`${e.message.split("\n")[0]}\n--- the row said:\n${await text(row(id)).catch(() => "?")}`); });
  // The same after a change on the server that no button of the page made (a login in the
  // terminal): the person presses "Check again". The console keeps an answer for 5 seconds.
  const recheck = (id, want, what, ms = 40_000) => until(async () => {
    if ((await row(id).getAttribute("data-state")) === want) return true;
    await pg.getByRole("button", { name: "Check again" }).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(1500);
    return false;
  }, what, ms, 200).catch(async (e) => { throw new Fail(`${e.message.split("\n")[0]}\n--- the row said:\n${await text(row(id)).catch(() => "?")}`); });
  return { row, open, state, recheck };
}

// The steps of the Set-up list that both installs do. Each one acts as a person does.
function flows(root, pg) {
  const { row, open, state, recheck } = rows(pg);

  async function githubCode() {
    const said = await see(row("github"), CODE_RE, "The row shows no code for github.com");
    const code = CODE_RE.exec(said)[0];
    must(code === root.read("gh/code").trim(), "The code on the page is not the code that the GitHub tool gave.");
    mustHave(said, "github.com/login/device", "The row with the code");
    return code;
  }
  async function connectGithub() {
    const r = await open("github");
    await r.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await githubCode();
    writeFileSync(join(root.dir, "gh/approve"), "");   // the person types the code on github.com and approves
    await see(row("github"), "connected as ada-dev", "After the approval the row does not say which account is connected", 40_000);
    must(root.has("gh/setup-git"), "The console did not make git use the GitHub login (gh auth setup-git).");
  }
  async function expiredCode() {
    root.set("gh-login", "expire");
    const r = await open("github");
    await r.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    await see(row("github"), "The code ran out. Press New code.", "The row does not say that the code ran out");
    root.set("gh-login");
    await row("github").getByRole("button", { name: "New code" }).click();
    await githubCode();
    writeFileSync(join(root.dir, "gh/approve"), "");
    await see(row("github"), "connected as ada-dev", "A new code did not connect GitHub", 40_000);
  }
  async function commitName() {
    must(!/^\[user\]/m.test(root.read("home/.gitconfig")), "The test's home has a commit name before the step.");
    const r = await open("github");
    await see(r, "Ada Dev", "The row does not show the name of the GitHub account");
    await r.getByRole("button", { name: "Use this name" }).click();
    await state("github", "done", "The step Connect GitHub is not done after the name was set");
    mustHave(await text(row("github")), "Connected as ada-dev", "The GitHub row");
    const cfg = root.read("home/.gitconfig");
    must(/name = Ada Dev/.test(cfg) && /email = \d+\+ada-dev@users\.noreply\.github\.com/.test(cfg), "git has no name and e-mail for commits after the step.");
  }
  async function pickRepo() {
    const r = await open("repo");
    await r.getByRole("radio", { name: /ada-dev\/hello/ }).click();
    await r.getByRole("button", { name: "Use ada-dev/hello" }).click();
  }
  async function repo({ fail = false } = {}) {
    const r = await open("repo");
    await r.getByRole("radio", { name: /ada-dev\/hello/ }).waitFor({ timeout: 20_000 });
    must(await r.getByRole("radio", { name: /some-org\/big-app/ }).isDisabled(), "A repo with no push access can be picked.");
    must(await r.getByRole("radio", { name: /ada-dev\/old-site/ }).isDisabled(), "An archived repo can be picked.");
    if (fail) {
      root.set("gh-clone", "network");
      await pickRepo();
      await see(row("repo"), "GitHub did not answer during the copy. Press the button again.", "The row does not say that the copy failed");
      must(!root.has("home/workspace/hello"), "A failed copy left a folder.");
    }
    await pickRepo();
    await state("repo", "done", "The step Pick a repo is not done after the copy");
    const origin = (await root.sh(`git -C ${root.home}/workspace/hello config --get remote.origin.url`)).out.trim();
    must(/^https:\/\/github\.com\/ada-dev\/hello(\.git)?$/.test(origin), `The copy of the repo has the address “${origin}”.`);
  }
  async function startAgent() {
    const r = await open("agent");
    // The button in the row (the head of the row has the same words, and more).
    const start = r.getByRole("button", { name: "Start the first agent", exact: true });
    await start.waitFor({ timeout: 20_000 });
    await start.click();
    await until(() => /the first agent started in hello/.test(root.read("state/choibot.log").split("copy of ada-dev/hello started").pop()), "The console did not start the first agent", 20_000);
  }
  async function agentStops() {
    root.set("agent-mode", "stop");
    await startAgent();
    await until(async () => { const r = await open("agent"); const t = await text(r); return t.includes("The agent stopped and opened no pull request.") ? t : false; }, "The row does not say that the agent stopped with no pull request", 40_000);
    root.set("agent-mode", "pr");
    const starts = () => root.read("state/choibot.log").split("the first agent started in hello").length - 1;
    const n = starts();
    await (await open("agent")).getByRole("button", { name: "Try again", exact: true }).click();
    await until(() => starts() > n, "“Try again” did not start a new agent", 20_000);
  }
  // The fake agent made a real commit with the commit name, pushed it and opened a pull request.
  async function pullRequest() {
    await until(() => root.has("gh/prs/ada-dev__hello/1.json"), `No pull request came to the fake GitHub.\n--- the fake agent said:\n${root.read("state/agent.log").slice(-600)}`, 60_000);
    const pr = JSON.parse(root.read("gh/prs/ada-dev__hello/1.json"));
    const author = (await root.remoteGit("ada-dev/hello", "log", "-1", "--format=%an", pr.headRefName)).out.trim();
    must(author === "Ada Dev", `The commit of the agent has the author “${author}”, not the commit name of the step.`);
    await state("agent", "done", "The step Start the first agent is not done after the pull request", 60_000);
    return pr;
  }
  async function ticketInRow() {
    const r = await open("merge");
    const card = r.locator("[data-part=ticket]");
    const said = await see(card, PR_TITLE, "The row Merge the first PR does not show the ticket");
    mustHave(said, "ada-dev/hello #1", "The ticket in the row");
    return card;
  }
  async function merge() {
    const card = await ticketInRow();
    await card.getByRole("button", { name: "Merge PR #1" }).click();
    await card.getByRole("button", { name: "Cancel" }).waitFor({ timeout: 15_000 });
    // The console has a new answer for the step list now, as after each read of the page
    // (it keeps one for 5 seconds). The step after this one asks: is the answer after the
    // merge the new one?
    await until(async () => Date.now() - ((await api(pg, "/api/setup/steps")).body?.checkedAt ?? 0) < 1500, "The console gave no new answer for the step list", 20_000, 500);
    await card.getByRole("button", { name: "Merge", exact: true }).click();
    await until(async () => /\(#1\)/.test((await root.remoteGit("ada-dev/hello", "log", "-1", "--format=%s", "main")).out), "The main branch on the fake GitHub has no merge commit", 30_000);
    must(JSON.parse(root.read("gh/prs/ada-dev__hello/1.json")).state === "MERGED", "The pull request on the fake GitHub is not merged.");
    await until(async () => (await api(pg, "/api/setup/first")).body?.ticket?.state === "merged", "The ticket of the pull request does not say “merged”", 20_000, 200);
  }
  return { row, open, state, recheck, connectGithub, expiredCode, commitName, repo, startAgent, agentStops, pullRequest, ticketInRow, merge };
}

// The pairing screen, and no other answer, at one address of a console with no paired device.
async function lockedAt(pg, base) {
  for (const path of ["/", "/settings/devices", "/pair", "/queue"]) {
    await pg.goto(`${base}${path}`, { waitUntil: "load" });
    mustHave(await body(pg), "This is your new ChoiBot", `${base}${path}`);
  }
  const got = await pg.evaluate(async () => {
    const out = [];
    const get = ["/api/agents", "/api/setup/steps", "/api/setup/home", "/api/queue", "/api/settings/telegram", "/api/brain/devices", "/api/guide", "/api/files?path=/", "/api/accounts"];
    const post = ["/api/agents", "/api/chief/devices/add", "/api/chief/devices/claim", "/api/chief/pair/start", "/api/chief/pair/claim", "/api/setup/github/login", "/api/setup/first", "/api/guide/message", "/api/settings/telegram/setup"];
    for (const [method, list] of [["GET", get], ["POST", post]]) {
      for (const p of list) {
        const r = await fetch(p, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
        out.push({ p: `${method} ${p}`, status: r.status, error: (await r.json().catch(() => null))?.error });
      }
    }
    const ws = await new Promise((done) => {
      const s = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/agents/x/terminal`);
      s.onopen = () => { s.close(); done("open"); };
      s.onerror = () => done("refused");
      setTimeout(() => done("no answer"), 5000);
    });
    const first = await (await fetch("/api/chief/pair/first")).json();
    return { out, ws, first };
  });
  const open = got.out.filter((r) => r.status !== 403 || r.error !== "pair-required");
  must(open.length === 0, `These routes answer a browser that is not paired:\n${open.map((r) => `  ${r.p} → ${r.status}`).join("\n")}`);
  must(got.ws === "refused", `A socket of the console opens for a browser that is not paired (${got.ws}).`);
  must(got.first.locked === true, "The console does not say that it is locked.");
}

// Type a code on the pairing screen and press the button. The answer of the screen is in
// `main [role=status]` (paired) or `main [role=alert]` (the reason).
async function pairWith(pg, code) {
  const field = pg.locator("main input").first();
  await until(async () => {
    if (await pg.locator("main [role=status], main [role=alert]").count()) return true;
    // The page takes the text only when its code has loaded: type again until it stays.
    if ((await field.inputValue()) !== code) await field.fill(code);
    await pg.getByRole("button", { name: "Pair this device" }).click({ timeout: 2000 }).catch(() => {});
    await sleep(500);
    return (await pg.locator("main [role=status], main [role=alert]").count()) > 0;
  }, "The pairing screen gave no answer to the code", 20_000, 300);
}

const newCode = async (root) => {
  const r = await root.cli("pair");
  const code = CODE_RE.exec(r.out)?.[0];
  must(r.code === 0 && code, `\`pair\` printed no code:\n${r.out}`);
  return code;
};

// The words of an install output: plain, with the full path of the command (a path is right there).
const plainOutput = (out, where) => {
  const hits = notPlain(out).filter((h) => !h.startsWith("a file path") && !h.startsWith("the word “pnpm”"));
  must(hits.length === 0, `${where} has words that are not for a new user:\n  ${hits.join("\n  ")}`);
};

// ------------------------------------------------------------------ the run

async function main() {
  tg = await fakeTelegram();
  address = await fakePrivateAddress({ name: PRIVATE_NAME, target: A.port, dir: OUT });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", `--host-resolver-rules=MAP ${PRIVATE_NAME} 127.0.0.1:${address.port}`] });
  laptop = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  page = await laptop.newPage();
  S.pages.set("laptop", page);
  S.logs.set("console A", () => A.logTail());

  // --only a | b: one of the two installs, for a person who works on the test.
  const only = value("--only");
  if (only !== "b") await pathA();
  if (only !== "a") await pathB();
}

// ---------------------------------------------------------------- install A

async function pathA() {
  const f = flows(A, page);
  const done = page.locator("[data-done]");
  let out = "", scriptCode = "", pr = null, envFile = "", phonePage = null;

  await S.step("a1", "A · The install line: one script, no question, no sudo", async () => {
    await A.make();
    A.serviceEnv({ telegramApi: tg.api, ports: [Number(tg.api.split(":").pop())] });
    await A.tool("tailscale", "no-address");   // Tailscale is on the server and signed in
    const r = await A.install();
    out = r.out;
    writeFileSync(join(OUT, "a-install.txt"), out);
    S.logs.set("install A", () => out.split("\n").slice(-40).join("\n"));
    must(r.code === 0, `The install line ended with exit code ${r.code}.\n${out.slice(-1500)}`);
    for (const part of ["Step 1 of 2 · Set up your server", "Step 2 of 2 · Open it", /Done in \d+ min \d+ s\. ChoiBot runs on your server\./]) mustHave(out, part, "The output of the install line");
    must(A.read("state/sudo.log").trim() === "", `The install line ran sudo:\n${A.read("state/sudo.log")}`);
    scriptCode = CODE_RE.exec(out.split("Pair your first device")[1] ?? "")?.[0] ?? "";
    must(scriptCode, "The install line printed no code for the first device.");
    plainOutput(out, "The output of the install line");
    A.fakeGithub(REPOS);
    await A.makeRemote("ada-dev/hello");
  });

  await S.step("a2", "A · The install asks for no Claude login: it says that the page does it", async () => {
    must(!/Log in to Claude\n|Paste code here|claude\.com\//.test(out), "The install line started a Claude login in the terminal.");
    must(!A.has("home/.claude/.credentials.json"), "A Claude login is on the server after the install.");
    mustHave(out, "the page of ChoiBot shows the next step: log in to Claude. You do it in the browser.", "The end of the install line");
  }, { needs: ["a1"] });

  await S.step("a3", "A · The console runs under the new names, on the server itself only", async () => {
    must(await A.up(), "The console does not answer on its port.");
    must(A.has("home/.config/systemd/user/choibot.service"), "No service file with the new name.");
    must(A.has("home/.local/share/choibot"), "No data folder with the new name.");
    const old = ["home/.config/systemd/user/choibot.service", "home/.local/share/choibot", "home/.config/choibot"].filter((p) => A.has(p));
    must(old.length === 0, `The install made a thing with an old name: ${old.join(", ")}`);
    const keys = A.envKeys().filter((k) => k.startsWith("CHOIBOT_"));
    must(keys.length === 0, `A process of the install has an env key with the old prefix: ${keys.join(", ")}`);
    mustHave(A.read("state/choibot.log"), "names: new (choibot.service, data dir choibot)", "The log of the console");
    const l = await listenersOf(A.pids());
    must(l.all.length > 0 && l.open.length === 0, `The install listens on: ${l.all.join(", ") || "nothing"}. All must be on 127.0.0.1.`);
  }, { needs: ["a1"] });

  await S.step("a4", "A · The install prints the SSH tunnel line and turns the private address on", async () => {
    mustHave(out, `ssh -N -L ${A.port}:127.0.0.1:${A.port} `, "The output of the install line");
    mustHave(out, `Open http://localhost:${A.port} in the browser of your laptop.`, "The output of the install line");
    mustHave(out, `✔ The private address is ready: ${P}`, "The output of the install line");
    mustHave(out, "Its links use the private address now.", "The output of the install line");
  }, { needs: ["a1"] });

  await S.step("a5", "A · Before pairing: both addresses show only the pairing screen, each other route refuses", async () => {
    await lockedAt(page, A.base);
    await lockedAt(page, P);
    await sleep(500);
    const log = A.read("state/choibot.log");
    must(!/uncaughtException|ERR_HTTP_SOCKET_ASSIGNED/.test(log), `A refused socket wrote an error to the log of the console:\n${log.split("\n").filter((l) => /uncaughtException|SOCKET_ASSIGNED/.test(l)).slice(0, 3).join("\n")}`);
  }, { needs: ["a3"] });

  await S.step("a6", "A · The words of the pairing screen are plain, and its command works on this server", async () => {
    await page.goto(P, { waitUntil: "load" });
    const said = await body(page);
    const commands = await page.locator("code").allInnerTexts();
    must(commands.length > 0, "The pairing screen names no command for a new code.");
    for (const c of new Set(commands)) {
      // A new SSH session of the user: the PATH of the system, and the folder of the user's own commands.
      const r = await A.sh(`PATH="$HOME/.local/bin:$PATH"; command -v ${c.split(" ")[0].replace(/[^A-Za-z0-9._-]/g, "")}`);
      must(r.code === 0, `The pairing screen says: run \`${c}\` on your server. This server has no command “${c.split(" ")[0]}”: the install line made the command \`choibot\`.`);
    }
    mustBePlain(said, "The pairing screen");
  }, { needs: ["a3"] });

  await S.step("a7", "A · Pair the first device with the code of the install script", async () => {
    await page.goto(P, { waitUntil: "load" });
    await pairWith(page, scriptCode);
    mustHave(await body(page), "This device is paired.", "The pairing screen");
    await page.getByRole("button", { name: "Open ChoiBot" }).click();
    await see(page.locator("body"), "Set up ChoiBot", "The console did not open after the pairing");
  }, { needs: ["a5"] });

  await S.step("a8", "A · The Set-up page is the home, with the step to do now: Log in to Claude", async () => {
    await page.reload({ waitUntil: "load" });
    const said = await see(page.locator("body"), /Step \d of 8 · /, "The Set-up page has no line with the step to do now");
    must((await api(page, "/api/setup/home")).body?.home === true, "The console does not say that the Set-up page is its home.");
    for (const id of ["install", "access", "pair"]) await f.state(id, "done", `The step “${id}” is not done on a new install`);
    mustHave(said, "Step 2 of 8 · Log in to Claude", "The head of the Set-up page");
    await f.state("claude", "turn", "Log in to Claude is not the user's turn");
    // No login yet: the guide cannot answer, and one plain line says so. The list works.
    mustHave(said, /The guide is not available now/, "The Set-up page with no Claude login");
  }, { needs: ["a7"] });

  await S.step("a8l", "A · Log in to Claude on the Set-up page: the sign-in link and the code, no terminal", async () => {
    const r = await f.open("claude");
    await r.getByRole("button", { name: "Log in to Claude", exact: true }).click();
    const card = r.locator("[data-part=claude-login]");
    await card.locator("input").waitFor({ timeout: 20_000 });
    const href = await card.getByRole("link", { name: /Open the sign-in page/ }).getAttribute("href");
    must(typeof href === "string" && href.startsWith("https://claude.com/"), `The sign-in link of the card is “${href}”.`);
    // A wrong code: Claude refuses it, and the card says what to press.
    await card.locator("input").fill("a-wrong-code-0000");
    await r.getByRole("button", { name: "Finish the login" }).click();
    await see(r, "Claude did not accept the code.", "The row does not say that the code was refused");
    await r.getByRole("button", { name: "New link" }).click();
    await card.locator("input").waitFor({ timeout: 20_000 });
    await card.locator("input").fill("good-code-1234#state");
    await r.getByRole("button", { name: "Finish the login" }).click();
    await f.state("claude", "done", "The step Log in to Claude is not done after the login on the page");
    must(A.has("home/.claude/.credentials.json"), "No Claude login is on the server after the login on the page.");
    const log = A.read("state/choibot.log");
    must(!log.includes("good-code-1234") && !log.includes("a-wrong-code-0000"), "The log of the console holds the code of the login.");
    const said = await see(page.locator("body"), "Step 5 of 8 · Connect GitHub", "After the login the step to do now is not Connect GitHub");
    await f.state("github", "turn", "Connect GitHub is not the user's turn");
    mustBePlain(said.split("Set up ChoiBot")[1] ?? said, "The Set-up page after the login");
  }, { needs: ["a8"] });

  await S.step("a9", "A · With the login, the guide welcomes, names the next step, and answers (a fake model)", async () => {
    const guide = page.locator("section[aria-label=Guide]");
    const said = await see(guide, "Welcome. This is your ChoiBot, and I am the guide.", "The guide has no welcome");
    mustHave(said, "Next: Connect GitHub.", "The guide");
    A.set("guide-reply", "A ticket is one decision that an agent needs from you.");
    await guide.getByLabel("Ask the guide").fill("What is a ticket?");
    await guide.getByLabel("Ask the guide").press("Enter");
    await see(guide, "A ticket is one decision that an agent needs from you.", "The answer of the model is not in the thread");
    const asked = readdirSync(join(A.state, "claude-log")).filter((n) => n.startsWith("print.stdin.")).map((n) => A.read(`state/claude-log/${n}`)).join("\n");
    mustHave(asked, "What is a ticket?", "What the model got");
    mustBePlain(await text(guide), "The thread of the guide");
  }, { needs: ["a8l"] });

  await S.step("a10", "A · A secret typed in the guide's chat is stopped in the browser", async () => {
    const guide = page.locator("section[aria-label=Guide]");
    const calls = () => readdirSync(join(A.state, "claude-log")).filter((n) => n.startsWith("print.")).length;
    const n = calls();
    await guide.getByLabel("Ask the guide").fill(`My bot token is ${tg.token}`);
    await guide.getByLabel("Ask the guide").press("Enter");
    const said = await see(guide, /not sent|was stopped|did not leave|never leaves/i, "The guide does not say that the text was stopped");
    must(!said.includes(tg.token), "The thread shows the secret.");
    await sleep(1500);
    must(calls() === n, "The model was called after a secret was typed.");
    const kept = [A.read("state/choibot.log"), A.read("home/.local/share/choibot/guide/thread.jsonl"), ...readdirSync(join(A.state, "claude-log")).map((x) => A.read(`state/claude-log/${x}`))];
    must(!kept.some((t) => t.includes(tg.token)), "The secret is in a file of the server.");
  }, { needs: ["a9"] });

  await S.step("a11", "A · Connect GitHub with a one-time code (the fake GitHub)", () => f.connectGithub(), { needs: ["a8l"] });
  await S.step("a12", "A · The commit name comes from the GitHub account", () => f.commitName(), { needs: ["a11"] });
  await S.step("a13", "A · Pick a repo: it is copied to the server; a repo with no push access is off", () => f.repo(), { needs: ["a12"] });

  await S.step("a14", "A · The first agent makes a real commit and a pull request", async () => {
    A.set("agent-mode", "pr");
    await f.startAgent();
    pr = await f.pullRequest();
    envFile = readdirSync(join(A.state, "claude-log")).filter((n) => /\.env\.\d+$/.test(n) && !n.startsWith("print.")).map((n) => join(A.state, "claude-log", n))[0];
  }, { needs: ["a13"] });

  await S.step("a15", "A · Its ticket shows in the row and in the Queue", async () => {
    await f.ticketInRow();
    await page.locator('button[title="Decisions waiting on you"]').click();
    await see(page.locator("body"), PR_TITLE, "The Queue does not show the ticket");
    await page.getByRole("button", { name: /^Set-up/ }).first().click();
    await see(page.locator("body"), "Set up ChoiBot", "The Set-up page did not come back");
  }, { needs: ["a14"] });

  await S.step("a16", "A · Merge from the row: a real merge on the fake GitHub", () => f.merge(), { needs: ["a15"] });

  await S.step("a17", "A · Right after the merge, the step list says “Merged” (the page reads it at once)", async () => {
    const merge = (await steps(page)).merge;
    must(merge?.state === "done", `The page reads the step list right after its own Merge. The console gave the answer from before the merge: “${merge?.text}”. So the page can stay on the old state until “Check again” or its next slow read (30 s).`);
  }, { needs: ["a16"] });

  await S.step("a18", "A · The done screen: one calm line and the 3 cards for what comes next", async () => {
    // What a person does when the page did not change by itself (step a17): "Check again".
    await until(async () => {
      if (await done.count()) return true;
      await page.getByRole("button", { name: "Check again" }).first().click({ timeout: 3000 }).catch(() => {});
      await sleep(2000);
      return false;
    }, "No done screen after the merge, also not after “Check again”", 40_000, 200);
    const said = await text(done);
    mustHave(said, "ChoiBot is set up", "The done screen");
    for (const part of ["Your first agent opened a pull request, and you merged it.", "Add your phone", "Telegram", "A lead for your repo", "Open the console"]) mustHave(said, part, "The done screen");
    mustBePlain(said, "The done screen");
  }, { needs: ["a16"] });

  await S.step("a19", "A · Add a device: a second browser pairs with the address of the code picture", async () => {
    // One press: the code picture shows with no second button.
    await done.locator("article[data-step=phone]").getByRole("button", { name: "Add your phone" }).click();
    const said = await see(done, /type this code:\s*[0-9A-Z]{4}-[0-9A-Z]{4}/, "One press on “Add your phone” shows no code picture with its code", 15_000);
    await shot(page, "add-your-phone-one-press");
    must((await done.locator("svg title").allTextContents()).includes("Code picture for the new device"), "The card has no code picture.");
    mustHave(said, `${PRIVATE_NAME}/pair`, "The Add a device card");
    const code = CODE_RE.exec(said.split("type this code:")[1])[0];
    phone = await browser.newContext({
      ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    phonePage = await phone.newPage();
    S.pages.set("phone", phonePage);
    await phonePage.goto(`${P}/pair#code=${code}`, { waitUntil: "load" });   // the address in the code picture
    await press(phonePage.getByRole("button", { name: "Pair this device" }), async () => /This device is paired/.test(await body(phonePage)), "The phone did not pair");
    await see(done, "Phone added", "The laptop does not say that the phone was added");
    await until(async () => (await steps(page)).phone?.state === "done", "The step Add your phone is not done");
    must((await api(page, "/api/brain/devices")).body?.length === 2, "The console does not have 2 paired devices.");
    await phonePage.getByRole("button", { name: "Open ChoiBot" }).click();
    await see(phonePage.locator("body"), /Queue/, "The console did not open on the phone");
  }, { needs: ["a18"] });

  await S.step("a20", "A · Telegram: the token form saves, and the console restarts by itself", async () => {
    const pid = A.servicePid();
    await done.locator("article[data-step=telegram]").getByRole("button", { name: "Set up" }).click();
    const form = done.locator("input[type=password]");
    await form.waitFor({ timeout: 15_000 });
    await form.fill(tg.token);
    await done.getByRole("button", { name: "Save and restart" }).click();
    await see(done, "@path_test_bot answers", "After the save the card does not show the bot", 60_000);
    must(A.servicePid() !== pid && A.servicePid() > 0, "The console did not restart after the save.");
    must(!(await body(page)).includes(tg.token), "The page shows the token.");
  }, { needs: ["a18"] });

  await S.step("a21", "A · Telegram: “Connect your chat” with a one-time code; the test message arrives", async () => {
    await done.getByRole("button", { name: "Connect your chat" }).click();
    const said = await see(done, /send \/start [0-9A-Z]{4}-[0-9A-Z]{4} to @path_test_bot/, "The card shows no one-time code");
    tg.say(`/start ${CODE_RE.exec(said.split("send /start")[1])[0]}`);
    await see(done, "Connected as @ada_on_telegram", "The card does not say which account is connected", 40_000);
    await until(() => tg.sent.some((m) => m.method === "sendMessage" && Number(m.chat_id) === TG_USER.id && /test message/.test(m.text ?? "")), "No test message came to the private chat");
    await until(async () => (await steps(page)).telegram?.state === "done", "The step Telegram is not done", 60_000);
  }, { needs: ["a20"] });

  let card = null, ticketId = "";
  await S.step("a22", "A · Telegram: a ticket card arrives in the private chat", async () => {
    writeFileSync(join(A.dir, "tmp/ticket.json"), JSON.stringify({ kind: "choice", title: "Which name for the new page?", body: "Pick one name.", options: [{ key: "A", label: "Start" }, { key: "B", label: "Home" }] }));
    // The first agent asks, with its own identity and the command of its instructions.
    const r = await A.sh(`set -a; . ${envFile}; set +a; PATH=${A.home}/choibot/node/bin:$PATH PORT=${A.port} ${A.home}/choibot/app/node_modules/.bin/tsx ${A.home}/choibot/app/bin/choibot.ts queue add < ${A.dir}/tmp/ticket.json`);
    ticketId = /"id":\s*"([a-z0-9]+)"/.exec(r.out)?.[1] ?? "";
    must(r.code === 0 && ticketId, `The agent could not add a ticket:\n${r.out}`);
    card = await until(() => tg.sent.find((m) => m.method === "sendMessage" && Number(m.chat_id) === TG_USER.id && (m.text ?? "").includes("Which name for the new page?")), "No ticket card came to the private chat");
    must(card.reply_markup?.inline_keyboard?.flat().some((b) => b.text === "Start"), "The card has no answer buttons.");
  }, { needs: ["a21", "a14"] });

  await S.step("a23", "A · Telegram: one tap answers the ticket, and the agent gets the answer", async () => {
    tg.tap(card, card.reply_markup.inline_keyboard.flat().find((b) => b.text === "Start").callback_data);
    const item = await until(async () => { const i = (await api(page, `/api/queue/${ticketId}`)).body; return i?.status === "answered" ? i : false; }, "The ticket is not answered after the tap");
    must(item.answer?.value === "A" && item.answer?.via === "telegram", `The ticket has the answer ${JSON.stringify(item.answer)}.`);
    await until(() => tg.sent.some((m) => m.method === "editMessageText" && (m.text ?? "").includes("✓")), "The card in Telegram does not show the answer");
    const agent = envFile.replace(/\.env\.\d+$/, ".input");
    await until(() => readFileSync(agent, "utf8").includes(`[queue ${ticketId}] choice: A`), "The agent did not get the answer in its session");
  }, { needs: ["a22"] });

  await S.step("a24", "A · A lead for your repo, from the done card", async () => {
    A.set("agent-mode", "stop");
    await done.locator("article[data-step=lead]").getByRole("button", { name: "Make a lead" }).click();
    await page.getByRole("button", { name: "New lead" }).click();
    // The form is filled in: the name from the repo, and the repo picked. The user only presses the button.
    await until(async () => (await page.getByPlaceholder("app").inputValue()) === "hello", "The lead form has no name filled in from the repo", 10_000);
    must((await page.getByRole("button", { name: "hello", exact: true }).getAttribute("aria-pressed")) === "true", "The lead form has no repo picked.");
    await shot(page, "lead-form-filled-in");
    await page.getByRole("button", { name: "Start lead" }).click();
    await until(async () => (await steps(page)).lead?.state === "done", "No lead runs after “Start lead”", 60_000);
    mustBePlain(await body(page), "The Leads section of Settings");
  }, { needs: ["a18"] });

  await S.step("a25", "A · After the set-up the home is the normal console; the steps are in Settings", async () => {
    await page.goto(P, { waitUntil: "load" });
    const said = await see(page.locator("body"), "Select or start an agent.", "The home after the set-up is not the console");
    must(!said.includes("Set up ChoiBot"), "The home is still the Set-up page.");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Set-up", exact: true }).first().click();
    await see(page.locator("body"), "Set-up is done", "Settings does not say that the set-up is done");
    const all = await steps(page);
    const open = Object.values(all).filter((s) => s.state !== "done").map((s) => s.title);
    must(open.length === 0, `These steps are not done at the end of the path: ${open.join(", ")}`);
    must(!/uncaughtException/.test(A.read("state/choibot.log")), "The log of the console has an “uncaughtException” line.");
  }, { needs: ["a18"] });

  await S.step("a26", "A · Settings > Devices says in plain and true words how the console is protected", async () => {
    await page.goto(P, { waitUntil: "load" });
    await press(page.getByRole("button", { name: "Settings", exact: true }), async () => (await page.getByRole("button", { name: "Devices", exact: true }).count()) > 0, "Settings did not open");
    await page.getByRole("button", { name: "Devices", exact: true }).first().click();
    const said = await see(page.locator("body"), "Protection", "The Devices section has no Protection part");
    const part = said.split("Protection")[1] ?? "";
    mustBePlain(part, "Settings > Devices > Protection");
    must(!/system user/i.test(part), `Protection uses the words “system user”:\n${part.trim().slice(0, 400)}`);
    // Telegram is connected in this install (step a21): a tap on a card in the user's own chat answers as the user.
    if (S.ok("a21")) must(!/Devices pair from your server, not from Telegram\. With a fleet master chat connected/.test(part), `Protection names only the fleet master chat, but tickets come to the user's own chat here:\n${part.trim().slice(0, 400)}`);
  }, { needs: ["a7"] });

  await S.step("a27", "A · A command in a person's shell talks to its own console (the port is not the default one)", async () => {
    const log = A.read("state/net.log").length;
    const r = await A.callConsole("brain", "pair", "tablet");
    const tried = A.read("state/net.log").slice(log).trim();
    writeFileSync(join(A.state, "net.log"), A.read("state/net.log").slice(0, log));   // counted here, not in step z2
    must(tried === "", `\`brain pair\` did not call its own console on port ${A.port}. It tried: ${tried.split("\n")[0]}`);
    must(r.code === 0 && r.out.includes(`${P}/#pair=`), `\`brain pair\` gave no link for the private address:\n${r.out.replace(/#pair=\S+/g, "#pair=…").slice(0, 300)}`);
  }, { needs: ["a7"] });

  await S.step("a28", "A · A second run of the install line changes nothing", async () => {
    const unit = join(A.home, ".config/systemd/user/choibot.service"), settings = join(A.home, "choibot/app/.env");
    const was = { unit: sha256(unit), settings: sha256(settings), pid: A.servicePid(), devices: (await api(page, "/api/brain/devices")).body?.length };
    const r = await A.install();
    writeFileSync(join(OUT, "a-install-2.txt"), r.out);
    must(r.code === 0, `The second run ended with exit code ${r.code}.\n${r.out.slice(-1200)}`);
    for (const part of ["No new download.", "The code of ChoiBot is on your server. No new download.", "Claude Code is on your server"]) mustHave(r.out, part, "The output of the second run");
    must(sha256(unit) === was.unit, "The second run changed the service file.");
    must(sha256(settings) === was.settings, "The second run changed the settings of the console.");
    must(A.servicePid() === was.pid, "The second run started the console again.");
    must(!A.has("home/choibot/app/app") && readdirSync(A.home).filter((n) => /choibot/i.test(n)).length === 1, "The second run made a second copy.");
    must(A.read("state/sudo.log").trim() === "", "The second run ran sudo.");
    must(!CODE_RE.test(r.out.split("Done in")[1] ?? ""), "The second run printed a pairing code though a device is paired.");
    await page.goto(P, { waitUntil: "load" });
    must((await api(page, "/api/brain/devices")).body?.length === was.devices, "The paired devices are not the same after the second run.");
  }, { needs: ["a7"] });
}

// ---------------------------------------------------------------- install B

async function pathB() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();
  S.pages.set("laptop B", pg);
  S.logs.set("console B", () => B.logTail());
  const f = flows(B, pg);
  let out = "";
  const failing = "Job for choibot.service failed";

  await S.step("b1", "B · A failed install step: the login is only an offer; with “no” the step prints its fix, no AI", async () => {
    await B.make(S.ok("a1") ? A : undefined);
    B.serviceEnv({ telegramApi: tg.api, ports: [Number(tg.api.split(":").pop())] });
    await B.tool("tailscale", "none");   // no Tailscale on this server: the SSH tunnel is the way in
    B.set("service", "stuck");
    // The person at the terminal presses Enter at the offer of the login: Enter means no.
    const r = await B.install(["ANSWER=Log in to Claude now=>"]);
    out = r.out;
    writeFileSync(join(OUT, "b-install-1.txt"), out);
    S.logs.set("install B", () => out.split("\n").slice(-40).join("\n"));
    must(r.code !== 0, "The install line ended with exit code 0 though a step failed.");
    mustHave(out, "Step 1 of 2 · Set up your server", "The output of the install line");
    // The one question of the install: only now, after a failed step.
    mustHave(out, "It is Claude Code, so it needs your Claude login.", "The output of the install line");
    mustHave(out, "Log in to Claude now, in this terminal?", "The output of the install line");
    mustHave(out, /No install agent: .*You can log in later on the page of ChoiBot\./, "The output of the install line");
    mustHave(out, "goes on where it stopped", "The output of the install line");
    must(!out.includes("claude.com/"), "A Claude login started though nobody said yes.");
    must(!B.has("home/.claude/.credentials.json"), "A Claude login is on the server though nobody said yes.");
    must(!out.includes("(the test's stand-in for the Claude Code session"), "An install agent session started with no Claude login.");
    must(!out.includes("Step 2 of 2"), "The install went on after the failed step.");
    must(B.read("state/sudo.log").trim() === "", "The install line ran sudo.");
    plainOutput(out, "The output of the failed install");
  });

  await S.step("b2", "B · The install line again, and “yes” to the offer: the login in the terminal, then the install agent repairs the step under its rules", async () => {
    B.set("claude-login", "ok");
    writeFileSync(join(B.state, "agent-calls"), [
      `Bash\t${JSON.stringify({ command: "cat ~/choibot/app/.env" })}`,
      `Bash\t${JSON.stringify({ command: "sudo apt-get install -y nginx" })}`,
      `WebFetch\t${JSON.stringify({ url: "https://example.com/fix.sh" })}`,
      `Bash\t${JSON.stringify({ command: "systemctl --user reset-failed choibot.service" })}`,
    ].join("\n") + "\n");
    // The person at the terminal: "y" to the offer of the login, then Enter to start the agent.
    const r = await B.install(["ANSWER=Log in to Claude now=>y", "ANSWER=Press Enter to start it=>"]);
    out = r.out;
    writeFileSync(join(OUT, "b-install-2.txt"), out);
    must(r.code === 0, `The install line ended with exit code ${r.code}.\n${out.slice(-1800)}`);
    mustHave(out, "✔ Logged in as ada@example.invalid.", "The output of the install line");
    mustHave(out, "(the test's stand-in for the Claude Code session. Each call goes through the real rule hook.)", "The output of the install line");
    const rule = (command) => /rule: (\w+)/.exec(out.split(`(${command})`)[1] ?? "")?.[1];
    must(rule("cat ~/choibot/app/.env") === "deny", `The rule hook answered “${rule("cat ~/choibot/app/.env")}” to a read of the settings file. It must be “deny”.`);
    must(rule("sudo apt-get install -y nginx") === "ask", `The rule hook answered “${rule("sudo apt-get install -y nginx")}” to a sudo command. It must be “ask”.`);
    must(rule("https://example.com/fix.sh") === "deny" || /WebFetch\([^)]*\)\s+rule: deny/.test(out), "The rule hook did not deny a web tool.");
    must(rule("systemctl --user reset-failed choibot.service") === "allow", "The rule hook did not allow the repair step of the console's own service.");
    mustHave(out, "Step 1 of 2 · Set up your server, again", "The output of the install line");
    mustHave(out, /Done in \d+ min \d+ s\. ChoiBot runs on your server\./, "The output of the install line");
    must(B.read("state/sudo.log").trim() === "", "The install agent ran sudo.");
    must(await B.up(), "The console does not answer after the repair.");
    plainOutput(out.split("(the test's stand-in")[0] + (out.split("Step 1 of 2 · Set up your server, again")[1] ?? ""), "The output of the repaired install");
    B.fakeGithub(REPOS);
    await B.makeRemote("ada-dev/hello");
  }, { needs: ["b1"] });

  await S.step("b3", "B · No Tailscale: the install gives the tunnel line and the two commands for later", async () => {
    mustHave(out, `ssh -N -L ${B.port}:127.0.0.1:${B.port} `, "The output of the install line");
    mustHave(out, "Tailscale is not on your server.", "The output of the install line");
    mustHave(out, "sudo tailscale up --operator=", "The output of the install line");
  }, { needs: ["b2"] });

  await S.step("b4", "B · A wrong pairing code, and a code that is spent", async () => {
    const scriptCode = CODE_RE.exec(out.split("Pair your first device")[1] ?? "")?.[0];
    must(scriptCode, "The install line printed no code for the first device.");
    // 5 codes that are not the code of the script. (A wrong code made from the real one by a
    // change of its last character can BE the real one: that made this step fail 1 time in 8.)
    const wrongs = ["2A2A-2A2A", "3B3B-3B3B", "4C4C-4C4C", "5D5D-5D5D", "6E6E-6E6E", "7F7F-7F7F"].filter((c) => c !== scriptCode).slice(0, 5);
    await pg.goto(B.base, { waitUntil: "load" });
    await pairWith(pg, wrongs[0]);
    mustHave(await text(pg.locator("main [role=alert]")), "This code is not correct. Check it and try again.", "The pairing screen");
    for (const wrong of wrongs.slice(1)) {
      await pg.locator("main input").first().fill(wrong);   // typing removes the last answer
      await pairWith(pg, wrong);
    }
    mustHave(await text(pg.locator("main [role=alert]")), "Too many wrong codes, so this code stopped.", "The pairing screen");
    await pg.locator("main input").first().fill("");
    await pairWith(pg, scriptCode);
    mustHave(await text(pg.locator("main [role=alert]")), "This code does not work now.", "The pairing screen, with the right code after it was spent");
    must((await (await fetch(`http://127.0.0.1:${B.port}/api/chief/pair/first`)).json()).locked === true, "The console is not locked any more.");
  }, { needs: ["b2"] });

  await S.step("b5", "B · A new code from the server pairs the device at the tunnel address", async () => {
    await pg.goto(B.base, { waitUntil: "load" });
    await pairWith(pg, await newCode(B));
    mustHave(await body(pg), "This device is paired.", "The pairing screen");
    await pg.getByRole("button", { name: "Open ChoiBot" }).click();
    await see(pg.locator("body"), "Set up ChoiBot", "The console did not open after the pairing");
  }, { needs: ["b2"] });

  await S.step("b6", "B · With the SSH tunnel only, the step to do now is Connect GitHub", async () => {
    const said = await see(pg.locator("body"), /Step \d of 8 · /, "The Set-up page has no line with the step to do now");
    const now = /Step \d of 8 · [^\n]+/.exec(said)[0];
    must(now.includes("Connect GitHub"), `The user came in through the SSH tunnel, as the install line said. The page says “${now}” and gives the Tailscale step as the one to do now.`);
  }, { needs: ["b5"] });

  await S.step("b7", "B · No Claude login: one plain line says that the guide is off, and the list works", async () => {
    const r = await B.sh("$HOME/.local/bin/claude auth logout");
    must(r.code === 0, `The fake logout failed:\n${r.out}`);
    await f.recheck("claude", "turn", "The step Log in to Claude is not open after the logout");
    const said = await body(pg);
    must((await pg.locator("section[aria-label=Guide]").count()) === 0 && (await pg.getByLabel("Ask the guide").count()) === 0, "The chat of the guide is on the page with no Claude login.");
    mustHave(said, /guide/i, "The Set-up page with no Claude login");
    mustBePlain(said, "The Set-up page with no Claude login");
  }, { needs: ["b5"] });

  await S.step("b8", "B · The GitHub code runs out: “New code” works (the guide is off)", () => f.expiredCode(), { needs: ["b5"] });
  await S.step("b9", "B · The commit name (the guide is off)", () => f.commitName(), { needs: ["b8"] });
  await S.step("b10", "B · The repo copy fails one time: the row says why, the second press works", () => f.repo({ fail: true }), { needs: ["b9"] });

  await S.step("b11", "B · The plan limit: the guide closes with the time it comes back, and the list works", async () => {
    const r = await B.cli("login");
    must(r.code === 0 && r.out.includes("Logged in as"), `The login did not work:\n${r.out.slice(-400)}`);
    await f.recheck("claude", "done", "The step Log in to Claude is not done after the login");
    const guide = pg.locator("section[aria-label=Guide]");
    await guide.getByLabel("Ask the guide").waitFor({ timeout: 30_000 });   // the guide is back with the login
    B.set("guide-fail", `limit:${Math.floor(Date.now() / 1000) + 2 * 3600}`);
    await guide.getByLabel("Ask the guide").fill("What comes next?");
    await guide.getByLabel("Ask the guide").press("Enter");
    const said = await see(pg.locator("body"), /plan|limit/i, "The page does not say that the Claude plan is at its limit");
    await until(async () => (await pg.getByLabel("Ask the guide").count()) === 0, "The chat of the guide stays open at the plan limit");
    mustBePlain(said, "The Set-up page at the plan limit");
  }, { needs: ["b10"] });

  await S.step("b12", "B · The first agent stops with no pull request: the row says so, “Try again” works", async () => {
    await f.agentStops();
    await f.pullRequest();
  }, { needs: ["b10"] });

  await S.step("b13", "B · The ticket in the row; Merge from the row (the guide is off)", () => f.merge(), { needs: ["b12"] });

  await S.step("b14", "B · With the SSH tunnel only, the set-up ends: the done screen shows", async () => {
    await until(async () => (await steps(pg)).merge?.state === "done", "The step Merge the first PR is not done on the server", 30_000);
    // The done screen comes by itself. "Check again" is what a person presses when it does not.
    if (!(await pg.locator("[data-done]").count())) await pg.getByRole("button", { name: "Check again" }).first().click({ timeout: 2000 }).catch(() => {});
    await see(pg.locator("body"), "ChoiBot is set up", "The first pull request is merged, but the page shows no done screen: a step is still open for a user of the SSH tunnel", 15_000);
  }, { needs: ["b13"] });

  await S.step("b15", "B · Add a device at the tunnel address: the page says what a new device needs", async () => {
    await pg.goto(B.base, { waitUntil: "load" });
    await press(pg.getByRole("button", { name: "Settings", exact: true }), async () => (await pg.getByRole("button", { name: "Devices", exact: true }).count()) > 0, "Settings did not open");
    await pg.getByRole("button", { name: "Devices", exact: true }).first().click();
    await pg.getByRole("button", { name: /Add a device/ }).first().click();
    const said = await see(pg.locator("body"), "cannot open this address", "The page gives a code picture for an address that works on this computer only");
    mustHave(said, "the private address of your server", "The Add a device part");
    mustBePlain(said.split("Paired devices")[1] ?? said, "The Devices section at the tunnel address");
  }, { needs: ["b5"] });

  await S.step("b16", "B · Tailscale comes later: “Add a device” at the tunnel address pairs this browser at the private address, with no command", async () => {
    // The user installs Tailscale and runs the one command that needs root steps: `access`.
    await B.tool("tailscale", "no-address");
    const r = await B.cli("access");
    mustHave(r.out, `✔ The private address is ready: ${P}`, "The output of `access`");
    must(await B.up(), "The console does not answer after it took the private address.");
    // The private address of THIS install, and a browser that finds it. The browser has what
    // the tunnel browser has (the pairing of localhost).
    mkdirSync(join(OUT, "b"), { recursive: true });
    const addressB = await fakePrivateAddress({ name: PRIVATE_NAME, target: B.port, dir: join(OUT, "b") });
    const browserB = await chromium.launch({ headless: true, args: ["--no-sandbox", `--host-resolver-rules=MAP ${PRIVATE_NAME} 127.0.0.1:${addressB.port}`] });
    try {
      const both = await browserB.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, storageState: await ctx.storageState() });
      const local = await both.newPage();
      S.pages.set("laptop B at the tunnel", local);
      // At the private address this browser is not paired yet.
      const priv = await both.newPage();
      S.pages.set("laptop B at the private address", priv);
      await priv.goto(P, { waitUntil: "load" });
      must((await api(priv, "/api/brain/devices")).status === 403, "The browser is paired at the private address before the step.");
      const count = (await api(pg, "/api/brain/devices")).body?.length;
      // At the tunnel address: "Add a device" gives the code for the private address.
      await local.goto(B.base, { waitUntil: "load" });
      await press(local.getByRole("button", { name: "Settings", exact: true }), async () => (await local.getByRole("button", { name: "Devices", exact: true }).count()) > 0, "Settings did not open");
      await local.getByRole("button", { name: "Devices", exact: true }).first().click();
      await local.getByRole("button", { name: /Add a device/ }).first().click();
      const panel = local.locator('[data-add="code"][data-private]');
      const said = await see(panel, "private address of your server", "“Add a device” at the tunnel address gives no code for the private address");
      mustHave(said, PRIVATE_NAME, "The Add a device part");
      mustBePlain(said, "The Add a device part at the tunnel address");
      await shot(local, "add-a-device-at-the-tunnel-address");
      const href = await panel.locator("[data-add-open]").getAttribute("href");
      must(typeof href === "string" && href.startsWith(`${P}/pair#code=`), `The link of the part is “${String(href).replace(/code=.*/, "code=…")}”.`);
      // One press on the page that the link opens: this browser is paired at the private address.
      await priv.goto(href, { waitUntil: "load" });
      await press(priv.getByRole("button", { name: "Pair this device" }), async () => /This device is paired/.test(await body(priv)), "The browser did not pair at the private address");
      await priv.getByRole("button", { name: "Open ChoiBot" }).click();
      await until(async () => (await api(priv, "/api/brain/devices")).status === 200, "The console does not take this browser as paired at the private address", 20_000);
      must((await api(priv, "/api/brain/devices")).body?.length === count + 1, "The console does not have one more paired device.");
      await see(local.locator("body"), /added/i, "The page at the tunnel address does not say that the device was added");
    } finally {
      await browserB.close().catch(() => {});
      await addressB.close();
      S.pages.delete("laptop B at the tunnel");
      S.pages.delete("laptop B at the private address");
    }
  }, { needs: ["b5"] });

  // A hosted console has no terminal: its first device pairs with the claim link of the
  // first-start file (server/chief/claimlink.ts). The test makes the file that an image's
  // first-boot step writes, for this console that has no paired device any more.
  const chiefDir = join(B.home, ".local/share/choibot/chief");
  const secretOf = () => randomBytes(32).toString("base64url");
  const hashOf = (k) => createHash("sha256").update(k, "utf8").digest("hex");
  const firstStart = (k, expiresAt) => writeFileSync(join(chiefDir, "first-start.json"), JSON.stringify({ v: 1, server: "srvtest1", claim: { sha256: hashOf(k), expiresAt } }), { mode: 0o600 });
  // The device that asks was used last (its own call just now): it goes last.
  const revokeAll = async (who) => {
    const list = ((await api(who, "/api/brain/devices")).body ?? []).sort((x, y) => x.lastUsedAt - y.lastUsedAt);
    for (const d of list) await apiPost(who, `/api/brain/devices/${d.label}/revoke`);
    await until(async () => (await (await fetch(`${B.base}/api/chief/pair/first`)).json()).locked === true, "The console is not locked after the last device was revoked");
  };
  let link = "";

  // The owner's phone: a browser of its own, for b17 and b18.
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const op = await owner.newPage();
  S.pages.set("owner B", op);

  await S.step("b17", "B · Hosted: a link that is too old says where a new link comes from; the right link pairs the first device with one press", async () => {
    must(existsSync(join(chiefDir, "user-devices.json")), `The data folder of the console is not at ${chiefDir}.`);
    await revokeAll(pg);
    // A link that is too old: plain words, the dashboard, no code field.
    const old = secretOf();
    firstStart(old, Date.now() - 1000);
    await op.goto(`${B.base}/first-run#k=${old}`, { waitUntil: "load" });
    const said = await see(op.locator("main"), "does not work now", "The pairing screen says nothing about a link that is too old");
    mustHave(said, "Make a new link on your ChoiBot dashboard.", "The pairing screen with a link that is too old");
    must((await op.getByRole("textbox", { name: "Code from your server" }).count()) === 0, "A hosted console shows the code field of a terminal.");
    must(!op.url().includes("#"), `The secret stays in the address bar: ${op.url().replace(/#.*/, "#…")}`);
    mustBePlain(said, "The pairing screen with a link that is too old");
    must(!existsSync(join(chiefDir, "first-start.json")), "The console did not remove the first-start file.");
    // A link that works, and first a wrong one of the same shape.
    link = secretOf();
    firstStart(link, Date.now() + 24 * 3_600_000);
    const wrong = (link[0] === "A" ? "B" : "A") + link.slice(1);
    // The link opened in the same tab: only the part after "#" changes, the page does not load again.
    await op.goto(`${B.base}/first-run#k=${wrong}`, { waitUntil: "load" });
    await op.getByRole("button", { name: "This is my console" }).waitFor({ timeout: 15_000 });
    await press(op.getByRole("button", { name: "This is my console" }), async () => (await op.locator("main [role=alert]").count()) > 0, "The pairing screen gave no answer to a wrong link");
    mustHave(await text(op.locator("main [role=alert]")), "This link is not the link of this console.", "The pairing screen with a wrong link");
    // The link opened as a new page.
    await op.goto("about:blank");
    await op.goto(`${B.base}/first-run#k=${link}`, { waitUntil: "load" });
    const asked = await see(op.locator("main"), "You opened the link of your new console.", "The link of the dashboard does not open the press of the owner");
    mustBePlain(asked, "The pairing screen of the claim link");
    await shot(op, "claim-link");
    await op.getByRole("textbox", { name: "Name of this device" }).fill("mira-phone");
    await press(op.getByRole("button", { name: "This is my console" }), async () => /This device is paired/.test(await body(op)), "The right link did not pair the device");
    await op.getByRole("button", { name: "Open ChoiBot" }).click();
    await until(async () => (await api(op, "/api/brain/devices")).status === 200, "The console does not take the device of the link as paired", 20_000);
    const list = (await api(op, "/api/brain/devices")).body.map((d) => d.label);
    must(list.length === 1 && list[0] === "mira-phone", `The paired devices are ${JSON.stringify(list)}.`);
    // Nothing of the secret on the server: not the secret, not its hash (the link ended).
    const kept = readFileSync(join(chiefDir, "claim-link.json"), "utf8");
    must(!kept.includes(hashOf(link)) && JSON.parse(kept).ended === "used", `The console keeps the claim link after the pairing: ${kept.slice(0, 120)}`);
    must(!B.logTail(400).includes(link) && !B.logTail(400).includes(hashOf(link)), "The log of the console has the secret or its hash.");
  }, { needs: ["b5"] });

  await S.step("b18", "B · Hosted: the link works one time; after the last device is revoked, it does not pair again", async () => {
    await revokeAll(op);
    await op.goto("about:blank");
    await op.goto(`${B.base}/first-run#k=${link}`, { waitUntil: "load" });
    const said = await see(op.locator("main"), "does not work now", "The used link opens the press of the owner again");
    mustHave(said, "Make a new link on your ChoiBot dashboard.", "The pairing screen with a used link");
    must((await op.getByRole("button", { name: "This is my console" }).count()) === 0, "The used link has a button that pairs.");
    const r = await (await fetch(`${B.base}/api/chief/pair/first`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim: link, label: "again" }) })).json().catch(() => null);
    must(r?.token === undefined, "The used link paired a device.");
  }, { needs: ["b17"] });

  await owner.close().catch(() => {});
  S.pages.delete("owner B");
  await ctx.close().catch(() => {});
  S.pages.delete("laptop B");
}

// ------------------------------------------------------------- the end of a run

// Ctrl-C, or a stop from outside: no process and no folder of the test stays behind.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    S.stopped = true;
    S.stopReason = "the run was stopped";
    console.error(`\nStopped (${signal}). Removing the installs of the test…`);
    stopCommands();   // an install that runs now must not write into a folder that goes away
    await sleep(500);
    await browser?.close().catch(() => {});
    await A.down().catch(() => {});
    await B.down().catch(() => {});
    A.remove();
    B.remove();
    process.exit(130);
  });
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; }

await S.step("z1", "Every port of the test listens on 127.0.0.1 only", async () => {
  const l = await listenersOf([...A.pids(), ...B.pids(), process.pid]);
  must(l.open.length === 0, `These ports of the test are open to other machines: ${l.open.join(", ")}`);
});

await S.step("z2", "No process of the test called another console of this machine", async () => {
  const tried = `${A.read("state/net.log")}${B.read("state/net.log")}`.split("\n").filter(Boolean);
  const outside = [...new Set(tried.map((l) => l.split(" ")[0]))];
  if (outside.length) S.note(`The guard stopped these connections (the product tried them): ${outside.join(", ")}`);
  const local = tried.filter((l) => /^(localhost|127\.0\.0\.1|\[?::1\]?):/.test(l));
  must(local.length === 0, `A process of the test tried a port of this machine that is not of the test:\n  ${[...new Set(local)].slice(0, 5).join("\n  ")}`);
});

if (KEEP) {
  console.log(`\n--keep: the test roots stay. A: ${A.dir} (${P} → port ${A.port}), B: ${B.dir} (${B.base}).`);
  console.log(`To stop them: scripts/install-test/run.sh down ${A.dir}; scripts/install-test/run.sh down ${B.dir}`);
} else {
  await browser?.close().catch(() => {});
  await A.down();
  await B.down();
  await address?.close();
  await tg?.close();
  await S.step("z3", "The throwaway folders are gone, and no process of the test is left", async () => {
    A.remove();
    B.remove();
    const left = [...A.pids(), ...B.pids()];
    must(left.length === 0, `Processes of the test are left: ${left.join(", ")}`);
    must(!A.has("") && !B.has(""), "A folder of the test is left.");
  });
  await S.step("z4", "The system of the real user is as before: units, services, data folders, crontab, ports", async () => {
    const after = await snapshot();
    const diff = snapshotDiff(before, after);
    const ports = portDiff(before, after);
    // A port of a process that this test did not start is other work on this machine.
    const ours = ports.filter((p) => p.pid === process.pid);
    if (ports.length) S.note(`Listening ports that other work on this machine changed during the run: ${ports.map((p) => `${p.what} ${p.at} (${p.by})`).join(", ")}`);
    must(diff.length === 0 && ours.length === 0, `The system of the real user changed during the test:\n  ${[...diff, ...ours.map((p) => `port ${p.at}`)].join("\n  ")}`);
  });
}

const table = S.table();
writeFileSync(join(OUT, "result.txt"), `${table}\n`);
console.log(`\n${table}`);
if (crashed) console.error(`\nThe test itself stopped: ${crashed?.stack ?? crashed}`);
if (!S.failed() && !crashed && !KEEP) rmSync(OUT, { recursive: true, force: true });
else console.log(`\nThe output folder: ${OUT} (result.txt, and for each failed step its picture and the last lines of the logs)`);
if (KEEP) { await browser?.close().catch(() => {}); await address?.close(); await tg?.close(); }
process.exit(S.failed() || crashed ? 1 : 0);
