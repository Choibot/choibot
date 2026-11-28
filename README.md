# ChoiBot

ChoiBot is a self-hosted web console for running and supervising coding agents —
[Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex) —
over your own repos. Spawn an agent into an isolated git worktree, watch its
terminal live, read the diff it is building, and drive the resulting pull request from
the GitHub tab. The
console binds loopback only and is reached over your [Tailscale](https://tailscale.com)
tailnet via `tailscale serve` — HTTPS from any of your devices, open to nobody else.
There is no public door at all.

ChoiBot is not affiliated with Anthropic or OpenAI.

<!-- TODO screenshot -->

## Agent runtimes

Each agent runs on one of two CLIs, picked in the launcher before you spawn it:

| Runtime | CLI | Auth |
| --- | --- | --- |
| Claude | `claude` | Claude Code subscription login |
| Codex | `codex` | ChatGPT subscription login (`codex login`) |

Claude is the default — an agent created without a runtime is a Claude agent, and
the runtime is fixed for that agent's life. Everything around the agent is shared:
the same worktree, diff, Changes rail, Docs tab and GitHub/PR flow, because those
read git and the filesystem rather than the agent. The usage meter shows your
ChatGPT limit windows next to the Claude ones whenever a Codex login is present.

**Codex agents borrow your Claude setup.** Codex has no `--settings` flag and no
`--append-system-prompt`; everything it knows comes from `CODEX_HOME`. So on every
spawn and resume the console builds a private `CODEX_HOME` for that one agent and
fills it from `~/.claude`:

- **Skills** — every skill folder in `~/.claude/skills`, plus the skills of every
  installed Claude plugin, symlinked in. Codex reads the same `SKILL.md` format, so
  nothing is converted. Your own skills keep their name; a plugin's are namespaced
  `<plugin>-<skill>` so two plugins shipping `review` do not collide. They are
  symlinks, so editing a skill's text reaches a running agent straight away; the
  farm is rebuilt per launch, so adding, removing or renaming one lands on the
  agent's next launch.
- **Instructions** — `~/.claude/CLAUDE.md` is written out as the agent's `AGENTS.md`,
  followed by whatever the console would have appended to Claude's system prompt
  (the docs-sharing rule for a worktree agent, a master's identity for that).
- **MCP servers** — the `.mcp.json` of each installed Claude plugin is translated
  into Codex config: stdio servers (`command`/`args`/`env`) and plain HTTP servers
  addressed by `url`. Codex cannot send custom headers, so a server that needs them
  is skipped rather than emitted half-working, and so is any entry in neither shape;
  the skipped names are printed to the console log at spawn. Only plugin-shipped
  servers are read — servers you added by hand to `~/.claude.json` or to a project's
  `.mcp.json` are not picked up.
- **Auth** — `~/.codex/auth.json` is symlinked, not copied, so a token refresh in
  your real Codex home is picked up by every running agent.

Status reporting needs one more piece. Codex hooks are plugin-scoped — a loose
hooks file in `CODEX_HOME` is silently ignored — so the console also generates a
one-plugin local marketplace inside the agent's home and installs it with
`codex plugin add`. That plugin's hooks POST each `SessionStart`/`UserPromptSubmit`/
`Stop`/`Notification` to the console, which is where the agent tiles get "running"
and "idle" from. Codex is launched with `--dangerously-bypass-hook-trust` for it,
without which hooks are skipped with no warning at all.

Codex agents also run with `--dangerously-bypass-approvals-and-sandbox`, the
counterpart of the `--dangerously-skip-permissions` the Claude agents get: the
console is already the trust boundary, and the inner sandbox would only lock the
agent out of its own worktree.

The generated home lives inside the agent's worktree at `.choibot/codex-home`, which is
git-excluded, so it never shows up in the Changes rail and it dies with the worktree
on merge or discard. A workspace agent (no repo) gets one under
`$WORKSPACE_DIR/.choibot-agents/<id>/`, which the delete route cleans up.

## Several Claude accounts

One box can hold more than one Claude Code login, and each Claude agent is pinned
to one of them. `claude` keeps its login in its config dir (`~/.claude`, or
`$CLAUDE_CONFIG_DIR`), so an extra account is an extra config dir the console owns
under `~/.claude-accounts/<name>` (`CLAUDE_ACCOUNTS_DIR` to move it), and an agent
runs under it by being spawned with `CLAUDE_CONFIG_DIR` set. The box's own
`~/.claude` is the `default` account; an agent with no account uses it, so a
one-login console behaves exactly as before and never shows the account controls.

- **Add one** with *+ Add Claude account* in the launcher. The dir is a *shadow*
  of `~/.claude`: every entry — `settings.json`, `CLAUDE.md`, `plugins/`,
  `skills/`, `projects/` (transcripts and memory), `tasks/` — is a symlink back to
  the real one, and only the login itself (`.credentials.json`, `.claude.json`,
  `statsig/`) is private. So the second account has your whole setup from the
  start, and a transcript is reachable from either account.
- **Log in** on the page: Settings, Claude accounts, "Add a login" (or "Log in" on a login).
  The console shows the sign-in page of Claude and takes its code. No terminal. The launcher
  shows `not logged in` next to an account until then.
- **Switch a running agent** from the *Account* row in the right rail. `claude`
  reads `CLAUDE_CONFIG_DIR` once at start, so the console ends the agent's session
  and relaunches it under the new login with `--resume` — the conversation,
  worktree and plan carry over because they were shared all along. The turn in
  flight would be lost, so the control is disabled while the agent is running;
  switch when it is idle. A dead agent just records the new account and uses it
  on its next Resume.
- **Usage** shows one group of meters per logged-in account, labelled by email.
- **Remove** an account with `POST /api/accounts/<name>/delete` (refused while an
  agent still uses it). Deleting removes links, never the real `~/.claude` entries.

## Requirements

- **Linux with systemd** — the console runs as a systemd *user* service. macOS and WSL
  without a user bus are not supported.
- **Node ≥ 22**.
- **pnpm** — `corepack enable`. This is the one prerequisite setup cannot install for
  you, since setup is launched through pnpm.
- **git**.
- **[Tailscale](https://tailscale.com)** — remote access runs over your tailnet
  (`tailscale serve`). Without it the console is loopback-only (SSH port-forward works
  in a pinch).
- **The `claude` CLI** — [Claude Code](https://claude.com/claude-code), installed and
  logged in.
- **The `codex` CLI** (optional) — [Codex](https://developers.openai.com/codex),
  installed and logged in (`codex login`). Only needed to launch Codex agents; the
  console runs on Claude alone without it. Setup records the resolved path as
  `CODEX_EXECUTABLE` when it finds one.
- **`gh`** (optional) — the GitHub tab needs it. Log in on the page: Settings, GitHub,
  "Connect GitHub" (a code that you type on github.com).
  Everything else works without it.

Setup handles the rest where it can: `dtach` plus the build toolchain
(`build-essential`, `python3` — needed to compile `node-pty`) are installed via
`apt-get` on Debian/Ubuntu hosts with passwordless sudo. Elsewhere setup prints the
exact package command and waits for you.

`pnpm choibot doctor` checks all of the above at any time.

The command is `pnpm choibot <command>`. `pnpm choi <command>` is the short form. The old
name `pnpm choibot <command>` still works.

This README uses the names of a new install: the service `choibot`, the data dir
`~/.local/share/choibot`, the folder `.choibot` in a repo. An install made before the rename
keeps its old names: see [Upgrading an install that still uses the old names](#upgrading-an-install-that-still-uses-the-old-names).

## Install

### One line, on a new server

On a new Linux server, logged in as a normal user (not root):

```bash
CHOIBOT_SOURCE=<git address or archive file> sh install.sh
```

**The public one-line address is not there yet.** It comes with the public release of ChoiBot:
then the line is one `curl … | sh`, and the source has a default. Until then, copy `install.sh`
to the server and give the source yourself: a git address that the server can reach (for a
private repo: with a key of its own), or a `.tar.gz` archive of the code that is on the server.

The script asks no question. It does this, in order:

1. It checks the server: Linux with systemd (Ubuntu 22.04 or newer, Debian 12 or newer; not
   macOS, not WSL), 2 GB of memory or more, 3 GB of free disk, GitHub and Anthropic reachable,
   and a user whose services stay on. When the server cannot work, it stops before it changes
   anything and says what works.
2. It puts ChoiBot into one folder, `~/choibot`: the code, and ChoiBot's **own Node** (one pinned
   version; the SHA-256 of the download is checked against the value in the script). The Node of
   the system is never touched.
   A server with no GitHub tool (`gh`) gets a pinned copy in the same folder, checked the same way.
3. It gets [Claude Code](https://code.claude.com/docs/en/setup) with its official installer. It
   does NOT ask you to log in to Claude: you do that in the browser, on the Set-up page of the
   console (a sign-in link and a code; a paid plan is needed: Pro, Max, Team or Enterprise).
   Only when a step of the install fails, it offers the login in the terminal, because the
   install agent needs it. Enter means no: the step then prints its own fix.
4. It runs `choibot setup --auto` (below): a free port, the settings, the build, the service.
5. It says how to open the console. There is no public door. One SSH tunnel line for your
   laptop works at once, with no account. For your phone too, it shows the commands for a
   private address with [Tailscale](https://tailscale.com).
6. It ends with the code that pairs your first device.

**It never runs `sudo`.** For the few things only root can do, it shows the exact command and
the reason, waits, and goes on when its check passes:

| Command | Why | When |
| --- | --- | --- |
| `sudo apt-get install -y dtach build-essential python3` | ChoiBot keeps agents alive with `dtach` and builds one part of itself. | Only for the tools that are not there. |
| `sudo loginctl enable-linger <user>` | The service starts with the server and stays on after you log out. | Only when the system refuses it without root. |
| `curl -fsSL https://tailscale.com/install.sh \| sh`, `sudo tailscale up --operator=<user>` | The private address for phone and laptop. | Only when you want Tailscale. |

On a server with a root login only, the script stops and shows the commands that make a user
for ChoiBot. It makes no user itself.

**It is safe to run again.** A second run repairs what is missing and makes no second copy: the
Node, the code, the settings and the service of the first run are kept, and a console that runs
is not built or started again.

After the install, the command is `choibot` (short: `choi`), with no `pnpm`:

| Command | What it does |
| --- | --- |
| `choibot doctor` | The set-up steps and their state. |
| `choibot login` | Log in to Claude, then check that a request works. |
| `choibot access` | The SSH tunnel line; and it turns the private address on when Tailscale is signed in. |
| `choibot pair` | A new code for your first device. |
| `choibot repair` | The install agent (below). |
| `choibot port <n>` | Another port, when another program took the port of ChoiBot. Then `choibot restart`. |

#### The install agent

When a step fails and Claude is logged in, the script offers the install agent: a Claude Code
session in your terminal that reads the failed step and its output, explains it in plain words,
repairs it, and runs the check again. Then the script goes on by itself. Later you start it
with `choibot repair`.

Before it starts, it says that it sends the output of the failed step to Claude (the model of
Anthropic), and it waits for Enter.

Its rules are fixed, and the settings of the session hold them (a hook that decides each tool
call, deny rules, the restricted mode of Claude Code), not only its prompt:

| | The install agent |
| --- | --- |
| With no question | reads the state of your server (versions, ports, disk, the log of ChoiBot); runs a check or a step again; gives ChoiBot another port (`choibot port <n>`); installs its parts and builds it again, and removes those; restarts ChoiBot's own service |
| Asks you first, with the exact command | each command with `sudo`; a system package; stopping a program that is not ChoiBot; swap; a firewall rule; a change of a file; every command that is not on its list |
| Never | opens a public port or address; deletes a file that ChoiBot did not make; reads keys or secrets (also not ChoiBot's own settings file); makes a pairing code, changes ChoiBot's data or the code of a check: only a check marks a step done |

One rule is stricter than "it changes files in ChoiBot's own folder": a direct edit of a file
asks first, because a changed file there can run as code in the next check.

What the rules cannot see: a command that hides its target (a variable, a `*`) is not known as
"never". Such a command is never run with no question: you see it and you decide.

With no Claude login, a plan at its limit or no terminal, there is no agent: the step prints its
own fix, and `choibot setup --auto` goes on where it stopped.

What you can give to the script:

| Variable | Meaning | Default |
| --- | --- | --- |
| `CHOIBOT_SOURCE` | A git address, or a `.tar.gz` file on the server. | None until the public release. |
| `CHOIBOT_RELEASE` | A release file that we built (`scripts/release/build.sh`): the full path of its `.tar.gz` on the server. It holds the code, its packages, its build, its Node and gh, so the server downloads and builds nothing. Ubuntu 24.04 on x86-64, into a new folder only. Not with `CHOIBOT_SOURCE`. | None. |
| `CHOIBOT_RELEASE_INDEX` | The release's `index.json`: the file's name, size and SHA-256 are checked against it before anything is unpacked. | None. |
| `CHOIBOT_HOME` | ChoiBot's own folder. | `~/choibot` |
| `CHOIBOT_PORT` | Where the search for a free port starts. | `3100` |

An install from an archive file has no git history: `choibot update` cannot get new code for it.
An install from a release gets a new release the same way (a hosted console: its Update ticket).

`scripts/install-test/run.sh` runs the script for real in a throwaway folder, with fakes for
`systemctl`, `sudo`, `tailscale` and the Claude login.

### By hand, from a clone

```bash
git clone <repo-url> choibot   # the URL of this repo or your fork
cd choibot
pnpm install
pnpm choibot setup
```

`setup` is an interactive installer — run it from a real terminal (it fails fast if stdin
is not a TTY). It runs the environment checks, walks you through `.env` — prompting for
anything still unset — resolves the missing prerequisites, builds the app, installs and
starts the `choibot` systemd user service, then waits until the console answers.
If `tailscale serve` is already configured it prints your tailnet URL; otherwise it
prints the two commands to set it up (`sudo tailscale set --operator=$USER`, then
`tailscale serve --bg --https=443 3100`).

Every step is idempotent, and re-running `setup` is the normal way to resume after a
failed step: completed steps are skipped, keys you have already set in `.env` are left
alone, and only missing keys are prompted for and appended — a fully populated `.env`
comes out of a re-run byte-for-byte unchanged. If a re-run does change `.env` or a unit
file, the affected services are restarted so the new configuration actually takes effect.

### Set-up with no question

```bash
pnpm choibot setup --auto
```

`setup --auto` asks nothing and needs no terminal, so a script can run it. It picks each value
itself: a free port (3100, or the next one that is free), a workspace folder outside the
console's folder, the Queue and the leads on, and agents that get only what they need to run.
It does not ask about Telegram, Tailscale or GitHub: those are later steps. It ends with the
list of set-up steps and their state, the list that `pnpm choibot doctor` prints.

Three optional values: `--port <n>` (where the search for a free port starts),
`--workspace <dir>` and `--url <address>` (the address you open the console at).

A new install has no paired device, so it shows only its pairing screen. `setup --auto` prints
a code for the first device at its end: open the console in the browser of that device and
type the code. The code works one time, for 10 minutes; `pnpm choibot pair` prints a new one. No
Telegram is needed. An install from before (one with the old names on the box) is never
locked and pairs as before.

A person who can reach the console on your network can end a code with 5 wrong tries, before
you type it. They cannot get in. Run `pnpm choibot pair` again for a new code.

It is safe to run again. A value that is in `.env` is never changed, a `.env` from before never
gets the Queue turned on, and a console that runs and is built gets no new build (use
`pnpm choibot update` for new code). When a step fails, it prints the fix in plain words, and the
next run goes on where it stopped.

### Run it locally (development)

For work on the console itself, without the systemd service. Needs Node ≥ 22 and pnpm
(see [Requirements](#requirements)).

```bash
pnpm install
pnpm server      # tsx watch server/index.ts: the API and the pages (Next in dev mode), restarts on change
```

The server does not read `.env` itself (the systemd unit loads it with `EnvironmentFile=`),
so put the keys of [`.env.example`](.env.example) in your shell first. It refuses to start
without a strong `CONSOLE_COOKIE_SECRET`, and listens on `PORT` (3000 when unset).

Other scripts from `package.json`:

| Command | What it does |
| --- | --- |
| `pnpm test` | The unit tests (`vitest run`). |
| `pnpm typecheck` | `tsc --noEmit`. |
| `pnpm build` | `next build`, the production build. |
| `pnpm start` | The production server (`NODE_ENV=production tsx server/index.ts`). |

## Day-2 ops

| Command | What it does |
| --- | --- |
| `pnpm choibot doctor` | The set-up steps and their state, in plain words. `--details` adds the technical checks (environment and config). Exits non-zero if a required technical check fails. |
| `pnpm choibot status` | `systemctl --user status` for the console service. |
| `pnpm choibot logs [console]` | Follow the unit's journal. |
| `pnpm choibot restart [console]` | Restart the console service. |
| `pnpm choibot stop` | Stops the console service. |
| `pnpm choibot update` | `git pull --ff-only`, install, build, refresh the installed unit file, then restart the console. |

Worth knowing:

- **`update` rebuilds before it restarts.** The old console keeps serving throughout the
  pull and build; the cutover is the restart at the end. If a step fails, the update
  aborts there and the running console is untouched. If the pull changed the unit
  template, the installed copy in `~/.config/systemd/user/` is re-rendered and systemd
  reloaded.

For the manual systemd paths behind these commands — and for recovery when something is
wedged — see [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).

## Fleet master and Coordinator

With the chief of staff on (`CHIEF_ENABLED=1`), two persistent agents work for the whole
fleet:

- The **fleet master** is your chat (the Fleet master tab, and the Master topic in Telegram).
  It gets no event line. When you ask how things are, it reads the state at that moment
  (`pnpm choibot fleet`: open tickets, agents, leads and their last reports, cron jobs) and
  answers from that read. It gives orders to leads and it can hand a task to the Coordinator
  (`pnpm choibot coordinator tell`).
- The **Coordinator** works in the background and has no row in the sidebar. The console
  sends it the event digests (a failed or stuck agent, a crashed service, a ticket that a
  rule can match), every cron run and each lead report with a decision or a problem. It
  speaks to you only through the Queue: it adds a ticket, or it recommends on one. It can
  also write to a lead. The console refuses every other action from it: it never answers a
  ticket, merges, pairs a device, or starts, stops or deletes an agent.

Settings, Leads shows one row for the Coordinator: its state, its last activity and
"Open its thread". "Needs you" there means that Claude asks a question in its thread.
The Coordinator runs on a cheaper model: `COORDINATOR_MODEL` in
`server/coordinator/paths.ts` (one line; empty = the default model of the login).

The fleet master's chat hides what the console typed into it (the older event digests)
and its "(quiet)" replies. "Show activity" in the header of the chat shows them.

A console line never goes to an agent while Claude asks a question on its screen (a folder
trust question, a login or a limit menu): you answer in the card of that agent first.

## Cron

Scheduled headless claude runs, on the same box. The fleet master manages the jobs for
you — tell it what you want run and when, and it writes the spec; the **Cron** group of
the Agents list shows each job's schedule, next run and last result, and a click on a job
opens its run history. Every run also reaches the Coordinator (see above): it reads the
result and adds a queue item when the job found something you must act on. The
same jobs are scriptable directly with `pnpm choibot cron` (`list`, `show <name>`, `add`, `edit <name>`,
`rm <name>`, `enable|disable <name>`, `run <name>`); `add` and `edit` take a JSON spec
on stdin, and every job becomes one systemd user timer (`choibot-cron-<name>.timer`).
Specs and run history
live under `CRON_DATA_DIR` (default `~/.local/share/choibot/cron`). Results land in
the Cron group, and — if Telegram notifications are configured — on your phone, even when the
console is down.

Jobs run under the same Claude login as new agents: `CLAUDE_DEFAULT_ACCOUNT` from `.env`
(when that account dir exists). A spec can name its own `account` (`"default"` = the
box's own `~/.claude` login); a job that names a missing account fails instead of
falling back. A `CLAUDE_CONFIG_DIR` set in the job's environment beats
`CLAUDE_DEFAULT_ACCOUNT` but not a spec `account`.

## Optional features

It is offered during `setup` as a `y/N` prompt and skipped by default; you can also
add the keys to `.env` later and restart the console.

- **Telegram notifications** when an agent finishes — `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID` (bot from [@BotFather](https://t.me/BotFather)).

See `.env.example` for the full key list.

### Share outside

A page an agent writes for you stays in its Queue ticket. To give a ticket to another person,
press **Share outside** on the ticket. The console shows what goes out and what your share tool
found that can be private (each hit needs a tick), and sends the page only after your confirm.
You get one link with the password in it. **Stop sharing** takes the page down. Only a paired
device can do this: agents, leads, the fleet master and the Coordinator cannot.

The console knows no share service. It runs one program of yours, the share tool. Set its full
path in Settings, Share outside (kept as `SHARE_TOOL`). With no tool, a ticket can only be
downloaded as one HTML file.

The contract. The console runs the tool with a fixed argument list (no shell), a time limit,
your home folder as its folder and only `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_ALL`,
`LC_CTYPE`, `TZ` and `TMPDIR` from its env:

| Call | The tool does | The console reads |
|---|---|---|
| `scan FILE.html` | looks for private text | each stdout line `BLOCKED <text>` or `warning <text>` is one hit; exit 0, or 1 with at least one hit |
| `add FILE.html [--allow-sensitive]` | puts the page online behind a password (`--allow-sensitive`: the user ticked each hit) | one `link: https://…` line; optional `one-tap: https://…#…` (the same address, the password after `#`) and `password: …`. A tool may exit 1 after the `link:` line when its own check failed: the console then opens the link once itself |
| `remove ID` | takes the page down | exit 0. `ID` is the last part of the link's path |

`FILE.html` is one self-contained page (the console's style and fonts inside, no script, no
outside request), built from the ticket's stored and checked copy. The console keeps the link,
the page id, the time and the device; never the password. No other output of the tool is shown
as a link.

## Upgrading an install that still uses the old names

An install made before the product got the name ChoiBot keeps working with no change. It keeps
its old technical names, and nothing moves by itself:

| | Old install | New install |
| --- | --- | --- |
| systemd unit | `choibot.service` | `choibot.service` |
| cron job units | `choibot-cron-<name>.*` | `choibot-cron-<name>.*` |
| data dir | `~/.local/share/choibot` | `~/.local/share/choibot` |
| user token | `~/.config/choibot/user-token` | `~/.config/choibot/user-token` |
| env keys for agents | `CHOIBOT_AGENT_ID`, … | `CHOIBOT_AGENT_ID`, … |
| folder in a repo | `.choibot`, `.choibot-hooks.json` | `.choibot`, `.choibot-hooks.json` |
| agent sockets | `choibot-<id>.sock` in `choibot-dtach` | `choibot-<id>.sock` in `choibot-dtach` |

The console decides once, when it starts: it uses the old names when it finds the old data
dir, the old unit file, or (in an agent) the key `CHOIBOT_AGENT_ID`. If it finds none of them,
it uses the new names. `pnpm choibot names` prints the names of your install and the reason.
The server log has the same line at start.

On both kinds of install, `pnpm choibot`, `pnpm choi` and `pnpm choibot` are the same command,
and the CLI reads an env key under both spellings (`CHOIBOT_…` first, then `CHOIBOT_…`).

A command that moves an old install to the new names comes later. Do not rename the dirs or
the unit by hand: the console would then see a new install with no data.

## Uninstall

```bash
systemctl --user disable --now choibot
rm ~/.config/systemd/user/choibot.service
systemctl --user daemon-reload
tailscale serve --https=443 off
# optional:
loginctl disable-linger $USER
```

Then delete the clone. Your workspace directory (`WORKSPACE_DIR`) and any agent
worktrees in it are left alone.

An install made by `install.sh`: the folder to delete is `~/choibot` (the code, its own Node
and, when the server had none, its own `gh`), and the links to it in `~/.local/bin`
(`choibot`, `choi`, and `gh` when it points into `~/choibot`).
