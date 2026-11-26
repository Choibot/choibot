# ChoiBot — operations runbook

> The names below are those of a new install. An install made before the rename keeps
> `choibot` (unit, data dir) and `.choibot`: see "Upgrading an install that still uses the
> old names" in the README. `pnpm choibot names` prints the names of your install.

The console runs as a **systemd user service** named `choibot`, supervised
(auto-restart on crash, starts on boot — linger is enabled). It serves a
**production** Next.js build via a custom Fastify server.

- Unit file (installed): `~/.config/systemd/user/choibot.service`
- Unit file (repo template): `deploy/choibot.service` (the template carries the old names; a new install gets them replaced)
- Working dir: the console checkout (setup's default: `~/workspace/choibot`)
- Branch served: `main`
- Port: read from `PORT` in `.env` (currently **3100** — 3000 is the production app)
- Env/secrets: loaded by systemd from `.env` (`EnvironmentFile=`)

> All commands are **user-scoped** (`--user`). Don't use `sudo systemctl` here —
> this is not a system service.

> Most commands below are wrapped by the CLI: `pnpm choibot status | logs | restart
> | update`. Fresh installs: see the root README (`pnpm choibot setup`).

## Restart with a fresh build (the common case)

Do this after pulling code, editing the UI, or changing server code. You MUST
rebuild first — the service runs the compiled `.next/` output, not source.

```bash
cd ~/workspace/choibot   # your console checkout
pnpm install            # only if dependencies changed
pnpm build              # MUST succeed before restarting
systemctl --user restart choibot
```

Verify it came back healthy (expect `active` and `HTTP 200` — loopback requests
are auto-trusted, so a local curl is let through without a session; it's remote
unauthenticated requests that the console refuses):

```bash
systemctl --user is-active choibot
PORT=$(grep -E '^PORT=' .env | cut -d= -f2)
curl -s -o /dev/null -w "HTTP %{http_code}\n" "http://localhost:${PORT:-3100}/"
```

## Quick restart (no code change)

```bash
systemctl --user restart choibot
```

## Other operations

```bash
systemctl --user status  choibot        # state, PID, memory
systemctl --user stop    choibot        # stop
systemctl --user start   choibot        # start
journalctl --user -u choibot -f         # tail logs
journalctl --user -u choibot -n 100     # last 100 log lines
```

## Change the port

Edit `PORT` in `.env`, then restart (systemd re-reads `.env` on restart):

```bash
# edit .env -> PORT=<new>
systemctl --user restart choibot
```

## After editing the unit file

If you change `~/.config/systemd/user/choibot.service`:

```bash
systemctl --user daemon-reload
systemctl --user restart choibot
```

## Troubleshooting

- **`status=216/GROUP`** — the unit has a `User=` line; user-scoped units must
  not set `User=`. Remove it.
- **Won't start, log says "Refusing to start: set CONSOLE_COOKIE_SECRET ..."** —
  `.env` has a weak/missing `CONSOLE_COOKIE_SECRET` (the session cookie is
  signed with it). Set a strong, non-default value. (Access is loopback-trust
  only — tailscale serve proxies from loopback; any other non-loopback
  unauthenticated request gets 403.)
- **`EADDRINUSE`** — another process holds `PORT`. Check with
  `ss -ltnp | grep :<port>`; pick a free port in `.env`.
- **UI changes not showing** — you skipped `pnpm build`. The service serves the
  built output, never source.
- **Crash loop, log says "Could not find a production build in the '.next'
  directory"** — a `next dev` ran against this directory and overwrote the
  production `.next` with a dev build (dev builds have no `BUILD_ID`). Do NOT run
  `pnpm dev` or `pnpm server` (the `tsx watch` dev watcher) from this directory
  while the production service runs — they share `.next` and clobber it. To
  recover: kill any stray watchers (`ps aux | grep 'tsx.*watch server/index'`),
  then `rm -rf .next && pnpm build && systemctl --user restart choibot`.
- **Stops on logout / not up after reboot** — linger disabled. Re-enable:
  `loginctl enable-linger "$USER"`.

### A Codex agent never leaves "idle"

Status comes from Codex hooks POSTing to the console. Codex hooks are
**plugin-scoped**: there is no freestanding hooks file, so the console generates a
one-plugin local marketplace inside the agent's `CODEX_HOME` and installs it on
every spawn and resume. Three things have to hold, in this order.

Below, `<home>` is `<worktree>/.choibot/codex-home` for a repo agent, or
`$WORKSPACE_DIR/.choibot-agents/<id>/codex-home` for a workspace agent (no repo).

**1. The hook command exists.** It lives in the plugin, *not* in `config.toml`:

```bash
cat <home>/mp/plugins/choibot-status/hooks.json
```

Each of `SessionStart`, `UserPromptSubmit`, `Stop` and `Notification` must carry a
`curl` command posting to `http://127.0.0.1:<PORT>/api/agents/<id>/hook?token=…`. If the
file is missing, the agent was launched by an older console — stop and resume it to
rebuild the home.

**2. The plugin is registered.** Registration is what the `codex` CLI writes into
`config.toml` in the same home — two tables, alongside the `[mcp_servers.*]` block
the console wrote there itself:

```bash
grep -A2 -e '^\[marketplaces' -e '^\[plugins' <home>/config.toml
CODEX_HOME=<home> codex plugin list      # expect: installed, enabled
```

A failed registration is logged loudly at spawn, and it costs status only — the
agent itself still runs:

```bash
journalctl --user -u choibot | grep 'hook plugin did NOT register'
```

Stop and resume the agent to retry it.

**3. The run passes `--dangerously-bypass-hook-trust`.** Without that flag Codex
skips every hook **silently** — no warning, no error, a run that looks completely
normal — even with the plugin installed and enabled. Trust is a separate gate, and
a non-interactive run cannot satisfy it interactively. The console always passes
the flag; pass it too when you reproduce by hand, or you will "confirm" a bug that
is not there:

```bash
CODEX_HOME=<home> codex exec --dangerously-bypass-hook-trust "say hi"
curl -s "http://localhost:${PORT:-3100}/api/agents/<id>"   # status should have moved
```

That probe posts as the real agent, so it moves that agent's status for real.

## Tailscale access (remote)

The console is reachable from tailnet devices only, at
**https://<machine-name>.<your-tailnet>.ts.net** (`tailscale serve status` prints it) via `tailscale serve` proxying to
loopback: `tailscale serve (:443, tailnet-only) → console (127.0.0.1:$PORT)`.
`:$PORT` binds loopback only; serve connects from loopback, which the console's
auth auto-trusts — there is no public door at all. (The former
cloudflared-tunnel + Telegram-gate chain was removed 2026-08-06.)

```bash
tailscale serve status                       # should show / proxy http://127.0.0.1:$PORT
tailscale status                             # peers that can reach this node
```

- **Re-create the serve config** (it persists inside tailscaled, but after a
  reinstall):
  `sudo tailscale set --operator=$USER` once, then
  `tailscale serve --bg --https=443 3100`.
- **Grant a new device access:** join it to the tailnet (same account) AND
  allow it in the tailnet ACL (admin console → Access Controls) — the rule for
  `tag:vps` lists allowed `src` devices.
- **Revoke a device:** remove it from the tailnet (admin console), or drop it
  from the ACL `src`.
- **Emergency access without Tailscale:**
  `ssh -L 3100:127.0.0.1:3100 <host>` then open http://localhost:3100
  (loopback is auto-trusted).
- On-demand public previews of arbitrary apps are a separate concern — the
  `run-preview` skill (its own cloudflared + auth gate), not this service.

## Strong protection on a new server (`strong-setup`)

Strong protection: the agents run under their own Linux account (`choibot-agent`), so an agent
cannot read the console's device keys, settings or data (`server/chief/hardened.ts`). On a NEW
server, one root command sets it up: the agent account and the group `choibot-shared`, root-owned
copies of Node, Claude Code, gh and dtach in `/usr/local/lib/choibot`, the modes of the console's
folders, `/srv/choibot/agent-homes`, the socket folder `/run/choibot-dtach`, the exec helper with
its config and its sudoers file, and the console's settings. It also makes the second account,
`choibot-chief`, for the fleet master, the leads and the Coordinator (below). At its end it starts
the console again (its user manager) only when this run changed the console's settings or groups,
when the user manager lacks the second account's group, when the console does not run, or when
the settings file is newer than the console's process (an earlier run changed it and then
stopped before its restart); its last step checks the state after. The code (`CHOIBOT_HOME`) and the
workspace must be outside the console user's home, for example `/opt/choibot` and
`/srv/choibot/workspace`: the command refuses other layouts, and an install with the old names.
Root trusts none of the facts the console user gives: each field is checked, and the uid and the
home come from root's own lookup. Every change of a path that the console user can change runs as
that user; root writes only its own paths (`/etc`, `/usr/local`, `/srv`, `/run`, the accounts).
The agents' keys (their id and pass) reach the helper through the sudoers file's `env_keep` line,
never through a `--preserve-env` list on sudo's command line: sudo logs each value of such a list
(`ENV=`, in the journal and in `auth.log`). At its start the console checks that the keys arrive
(the helper's `env-check`); without that line, agent exec is unavailable and the log says why.

```bash
sudo /opt/choibot/bin/choibot strong-setup --user choibot --dry-run   # the plan; changes nothing
sudo /opt/choibot/bin/choibot strong-setup --user choibot             # ends with "✔ Strong protection is set up"
# When it must (see above), it restarts user@<uid of choibot>.service itself: every agent that runs
# stops, and the console starts them again. A second run with nothing changed says "no restart".
# Where the user manager does not run (an image build), the first boot does it.
```

A second run changes nothing. The Claude login is not part of it. In strong protection there is
ONE login, the agents' own, in `~choibot-agent/.claude` (`AGENT_CLAUDE_CONFIG_DIR`): the
person makes it on the Set-up page ("Log in to Claude"). The console runs `claude auth login` there
through the helper (`choibot-agent-exec claude-auth login|status|logout`, as `choibot-agent`), shows the
link of Claude and hands it the pasted code; it never reads the login. "Sign out" in Settings runs
`claude auth logout` there the same way. The helper ends a login after 17 minutes, and a status
read or a sign-out after 15 seconds, by itself (`timeout`). The page refuses a
second login. `choibot login` in a terminal only says who is logged in, or names the page.

The console's own model calls (the guide, "Fill in" of a Recurring task, the words of the clean-up
audit, the nightly Brain review) use the same login: they run as `choibot-agent` through the
helper (`claude-print <model> [<system prompt>]`): `claude -p` with no tool, no settings and no MCP
server, the prompt on stdin, in a new empty folder `/tmp/choibot-print.*` that goes after the call,
ended after 11 minutes at most. What stays: such a call runs under the agents' account, so an
agent can stop it, steer it, read its input while it runs (the set-up state and the guide's
thread, the decisions of the Brain review with secrets removed, the file list of the audit, the
text of a task in "Fill in") and replace its answer. It never reaches the console's files, device
keys or gates, and the console treats each answer as text that it does not trust.

Recurring tasks are agent work (a repo, every tool): in strong protection their runner (a timer of
`choibot`) starts each task as `choibot-agent` on the same login, through the helper
(`claude-task <cwd> <minutes> -- -p <task> [flags]`). The helper takes only the flags the runner
uses, checks the cwd against its roots, and ends the task at its own time + 60 seconds. A task's
named login (an old setting) is not used there. The runner still keeps the run and notifies the
console as before. A task works in the console's own repo, not in a clone of its own, and reads it
only: git as `choibot-agent` in a repo of `choibot` stops with "dubious ownership", so a task can
read the files there but cannot run git (a known limit of this version; no `safe.directory` is set
for it).

**The agents' commit name**: the Set-up step "commit name" gives the same name and e-mail to
`choibot-agent` (`git config --global` as that account, through the helper verb `git-identity`),
and the console does it again at each start. In strong protection the console holds umask 022, so
what it writes is never group- or other-writable by its mode.

Each agent of a repo works in a repo of its OWN: `/srv/choibot/agent-homes/clones/<id>`, made by
the helper as `choibot-agent` (`repo-clone`: `git clone --no-local --reference` of the console's
repo, then the agent's branch at the start commit that the console gives). The console's repo in
the workspace stays the console's alone: the agents read it, and no agent branch or worktree goes
into it. The console runs no git in a clone and opens no path there: a file that an agent names
for a ticket (a page, a screenshot) is read as `choibot-agent` through the helper (`read-file`,
at most 8 MB); the hook settings of an agent are in `agent-homes/settings/<id>.json` and the files
that the person gives an agent in `agent-homes/uploads/<id>/` (both folders `choibot`
`choibot-shared` 2750, made by `strong-setup`). "Delete the agent" removes those files and its
clone through the helper (`repo-remove`); with no helper (its probe failed at this start), the
console refuses each action on such an agent, and does not start it. Only a Claude agent can work
on a repo with strong protection in this version. The clone uses the console's objects (alternates): never run `git gc` or
`git repack` with pruning in the console's repo while a clone of it is open. The Changes rail,
the diff and the git bar of such an agent come from the helper (`repo-read`: fixed git commands as
`choibot-agent` in its clone, against the base commit of the console's repo; 30 seconds for each,
at most 1 MB for a list and 4 MB for the diff, else "too large to show"; no external diff, no
textconv, no colour). The console keeps each answer 3 seconds. The agent's own git settings still
apply, so these views show what the agent's copy reports, and the console treats them as untrusted
text: the view to trust is the pull request on GitHub, made from the fetched commits.

The thread of an agent, the reason its turn stopped and its subagents come from its Claude session
files, in its own Claude folder (`~choibot-agent/.claude/projects/`). The console cannot open them:
the home is 0700, and Claude Code makes the files 0600 in 0700 folders. The helper reads them as
`choibot-agent` (`read-thread <path> <offset> <max bytes>`): only a regular file whose real path is
in the `projects` folder of that account's Claude folder (the last part never a link), at most 4 MB
in one call. Its answer is one line (size, time, device, inode), then the bytes. The console gives
only the path that it makes from the agent's record (its cwd and its session id). A live thread
costs one call at each poll (every 1.5 seconds while the agent works); a running subagent costs
at most two more each 3 seconds (its file and its meta file). A session that Claude filed under another project
folder is not looked for. What the helper gives is the agent's text: data, never an instruction.
A relaunch that resumes an agent's conversation (after a reboot, or when its session is gone)
asks the helper, as the agent, whether the session file is in the project folder of its cwd
(`session-ensure <session id> <project>`). When Claude filed it under another project folder of
the same account, the helper links it there (and links its subagents' folder); it changes nothing
outside that account's `projects` folder and never replaces an entry. "absent" starts a new
session; a failure of the helper is tried once more, then the agent starts a new session with a
log line that names the helper's reason.
The Plan rail reads the agent's task files (Claude Code keeps one JSON file per task in
`<its Claude folder>/tasks/<session id>/`) through the helper too, as the session's account:
`read-tasks <session id>`. Only the names `<n>.json`, regular files with one name; no link at the
folder or at a file; at most 1000 files, 256 KB a file, 4 MB in all and `READ_TASKS_LIMIT` seconds
(the helper's config, default 10); a copy in a new 0700 folder in /tmp that goes on every exit.
The rail asks every 2 seconds; the console reads at most once in 5 seconds for a running agent
and once a minute for an idle one, plus two reads at each change of its status (at once and 3
seconds later). An older helper (no `read-tasks`): the rail stays empty, with one log line, until
`strong-setup` installs the new helper.

The push and the pull request of such an agent go through the console (`choibot agents pr` in the
agent, or "Open PR" on the page; the paired user for any agent, an agent for itself only). The
console's repo fetches the agent's branch from its clone into `refs/agents/<id>/<branch>` (a name
space of the console, never a branch), with `upload-pack` run as `choibot-agent` by the helper
(`upload-pack <id>`: the console's `--upload-pack`; it checks that git's path is that clone) and
`fetch.fsckObjects`, through a `file://` address (for a plain path, git reads a bundle file that
is there itself, with no upload-pack); then it pushes that commit to the GitHub address of its own repo's origin
(never one from the clone), with no force: GitHub refuses a push that is not a fast-forward. `gh pr
create` gets `--repo`, `--head`, `--base` and the body on stdin, and runs in `~/.local/share/choibot/gh-work`
of the console user (in no repo). One pull request for each agent: a later call pushes the new commits to it. Never a merge, a
review or a base change: a merge stays the user's, from the queue ticket. The console never pushes
the base, the repo's default branch, or main, master, develop, trunk, production, staging, gh-pages
and release*. `choibot agents fetch-base` makes the console fetch the base from GitHub into its own
repo (one fetch at a time for each repo, at most one in 30 seconds for each base); then in the clone,
`git fetch console && git merge console/<base>` (the clone's remote `console` maps the console's
`refs/remotes/origin/*`; its own `upload-pack` names the console's repo in `safe.directory` on its
command line, because git refuses a repo of another account, upload-pack too). Known facts: the
console's GitHub login (`gh auth login --web`, no `-s`) has gh's default scopes (repo, read:org,
gist) and no `workflow` scope, so GitHub refuses a push that changes `.github/workflows/`. All agents
share one account: an agent that reads another agent's hook token can call this route as that agent;
the title and the body of a pull request go to GitHub under the user's name. Not in this version:
"Discard" of one file and a local merge (the page says so). A server set up before this version has
no `clones` folder: run `strong-setup` again (agents of a repo do not start until then). A clone made
before this version has no remote settings for `console`: delete that agent and start a new one.

**Who may ask what (a request from 127.0.0.1 proves nothing).** Every process on the server can
open 127.0.0.1, so with strong protection the console decides only by the credential of a request
(`server/chief/access.ts`), never by its address. A route that no list names is refused for every
caller but the user:
- a paired device (`x-choibot-user`): every route;
- the fleet master, a lead, a worker (their own agent token): the list of their level. A worker
  reaches itself and its own queue items and reminders only: no list of agents, no events stream,
  no other agent's thread, screen, terminal or input, no spawn, stop or resume. A lead also reaches
  the workers that it spawned and their queue items (show, recommend); the fleet master reads every
  worker. The lists hold what each level's commands call (a test reads the command line and the
  instruction texts);
- the Coordinator: its own gate (all reads, its four writes);
- the console's own account: the token in `~/.local/share/choibot/chief/console-token` (new at each
  start, 0600, in the 0700 data folder that the agents' account cannot read). It gets only what
  `doctor`, `status`, `access`, the set-up and the install agent ask (`GET /api/setup/steps`), and
  the pairing start of `brain pair`. It is not the user: for the user's rights in a shell of the
  server, run `choibot brain pair <label>`, then `choibot brain claim <url>`;
- no credential: the pages of the app (they hold no data), `/_next/static`, the icons, the pairing
  routes, and the two routes with a token of their own (an agent's hook, the Recurring runner's
  notify). A browser over an SSH tunnel with no paired device sees the pairing screen and must pair.
Every agent's terminal needs the user's token. A merge of a pull request (`POST /api/gh/pr/merge`,
an agent's merge, the queue's Merge button) and the answer of a ticket are the user's alone: no
level's list holds them, and their gates refuse the fleet master too, with "with strong protection
only the user merges: use the Merge button of the Queue". The fleet master recommends an answer;
it never answers a ticket. Basic mode (no strong protection) is as before: there the fleet master
merges on the user's order and gives the auto answer of a brain rule.

**Known limit: one Linux account for all agents.** Each agent can read the token of every other
agent, the fleet master's, a lead's and the Coordinator's too: all agents run as `choibot-agent`, the
console writes each agent's hook settings (with its token) with mode 0644, and each agent's
`CHOIBOT_AGENT_PASS` is in its process environment (`/proc/<pid>/environ` of the same account). So
an agent that takes another agent's token can act as that agent, within that agent's list. A
stolen token gives NO merge and NO answer of a ticket (above: the user's alone). With the fleet
master's token an agent can still spawn a worker; stop, resume or delete any worker (a delete
removes its worktree and its branch); set a reminder for any agent (its text reaches that agent);
give the Coordinator a task; add a candidate rule and a decision line to the brain; recommend an
answer on any worker's ticket; link a ticket to a recurring task's run; and read every worker's
thread, screen and tasks. With a lead's token: spawn in the lead's repos, and stop, resume or close
that lead's workers. With the Coordinator's token: every read and its four writes. A second Linux
account for the fleet master, the leads and the Coordinator (below) closes this once strong-setup
makes it: the workers then cannot read their tokens.

**The second account (strong-setup makes it).** The fleet master, the leads
and the Coordinator run as a second Linux account, `choibot-chief`, that the workers' account
cannot enter.
`strong-setup` makes, for it:
- the account `choibot-chief` (no sudo), with its own group of the same name; its home and its
  Claude folder are its own, 0700;
- it joins `choibot-shared` (it reads the workspace and the widgets, as the workers do), and
  `choibot` joins `choibot-chief` (the console writes its homes and its hook files);
- two checks that fail the step with the reason: `choibot-agent` must not be in `choibot-chief`,
  and `choibot-chief` must not be in the group of `choibot`;
- `/srv/choibot/agent-homes/chief` (root's, group `choibot-chief`, 3770) and
  `/run/choibot-dtach-chief` (`choibot`'s, group `choibot-chief`, 3770): the second one by a
  tmpfiles.d line (`/etc/tmpfiles.d/choibot-dtach-chief.conf`, so it comes back at each boot) and
  made at once;
- the second sudoers line, `choibot ALL=(choibot-chief) NOPASSWD: /usr/local/bin/choibot-agent-exec`;
  the helper's config keys `CHIEF_UID`, `CHIEF_DTACH_DIR` and `AGENT_UID`;
- its git settings: no automatic clean-up, and of `safe.directory` only the agent folders of its
  own homes stay; any other entry (`*`, a worker's clone) is removed. The console names the agent
  folder of each of its homes when it makes the home, one exact path at a time, through the
  helper's `git-safe` (git 2.43 takes no pattern such as `<dir>/*`);
- the console's settings `CHIEF_PERSISTENT_UID`, `AGENT_CHIEF_CLAUDE_CONFIG_DIR` and
  `AGENT_CHIEF_DTACH_DIR`.
Its Claude login is a second sign-in on the Set-up page ("Sign in for your assistant"). Before any
change, `strong-setup` stops on a server where the fleet master, a lead or the Coordinator ran as
the workers' account (a record whose folder is in `agent-homes` but not in `agent-homes/chief`, or
such a home folder of `choibot` there). The dry run shows the same stop. Their move is not built
yet: it never leaves them as the workers' account while the second account is on. The console reads three settings: `CHIEF_PERSISTENT_UID` (its uid),
`AGENT_CHIEF_CLAUDE_CONFIG_DIR` (its own Claude folder: its own sign-in, never a copy of the
workers' login) and `AGENT_CHIEF_DTACH_DIR` (its own session folder: the console's, that account's
group, 3770). Its homes are in `AGENT_HOME_ROOT/chief` (root's, that account's group, 3770; the
console never makes that folder). The helper's config takes `CHIEF_UID` and `CHIEF_DTACH_DIR`: as
that account, the helper takes sockets only in that folder, a start folder only in those homes,
and only the verbs probe, env-check, spawn, attach, kill, kill-clients, pids, alive, claude-auth, read-thread,
session-ensure, read-tasks and git-safe; the helper of another account never starts in those homes. Unset: one account for all agents, as before. Set but broken (or its
helper probe fails): the persistent agents do not start, never as the workers' account, and the
strong check (`doctor --details`) says why. The strong check wants each session of the uid of its
kind, in the folder of its kind.

It closes, for the three tokens: a worker cannot read them (the hook settings are 0640 with that
account's group; `/proc/<pid>/environ` of another uid is closed), cannot attach to those sessions
or type into them (their sockets are in a folder where it can make no entry), cannot signal their
processes, and cannot read their transcripts (another account's Claude folder).

**The test switch of a proof on a test server** (never on a real install): with `CHIEF_TEST=1`
and `CHIEF_TEST_START_UNSIGNED=1` in `.env`, the fleet master, the leads and the Coordinator start
WITHOUT the second sign-in, so their account, hook files, sockets and homes can be probed with no
credentials file (Claude Code stops at its own login screen). The console prints one loud line at
its start, and `doctor --details` says "test switch on". Without `CHIEF_TEST=1` the switch is
ignored (one line). `CHIEF_TEST=1` alone changes one more thing: the clean-up audit of the Server
page looks only at `~choibot/tmp`, not at `/tmp` (server/audit/api.ts). The other test settings
(`CHIEF_TEST_ENV_FILE`, `CHIEF_TEST_TELEGRAM_API`, `CHIEF_TEST_USAGE_API`, `CHIEF_TEST_QUIET_*`, the
route-walk settings) change nothing unless they are set too. The command line reads `CHIEF_TEST`
from its own environment, not from `.env`. None of these touches the two accounts, the helper or
their folders. Remove both keys after the proof, and restart the console.

**To turn the second account off again** (no command does it yet), in this order:
1. The console's settings (as `choibot`): remove `CHIEF_PERSISTENT_UID`,
   `AGENT_CHIEF_CLAUDE_CONFIG_DIR` and `AGENT_CHIEF_DTACH_DIR` from `.env`.
2. As root: remove `CHIEF_UID` and `CHIEF_DTACH_DIR` from `/etc/choibot-agent-exec.conf`, and the
   line `choibot ALL=(choibot-chief) …` from `/etc/sudoers.d/choibot-agent-exec` (then `visudo -c`).
3. `sudo systemctl restart user@$(id -u choibot).service`. From now on nothing starts as
   `choibot-chief`. The fleet master, the leads and the Coordinator get homes of the one-account
   layout: their memory and their conversations stay in `agent-homes/chief` and in
   `~choibot-chief/.claude`, and need the move back (not built; a move across two accounts cannot
   link a session file: it copies it as root, or the agent starts fresh).
4. Then, as root: `rm /etc/tmpfiles.d/choibot-dtach-chief.conf`, `rm -r /run/choibot-dtach-chief`,
   `gpasswd -d choibot choibot-chief`, and, after the move back, `rm -r /srv/choibot/agent-homes/chief`
   and `userdel -r choibot-chief`.
Done in another order, nothing runs as the workers' account: with the settings still there but the
account gone, the persistent agents do not start (their helper probe fails).

**What the second account does not stop.** A persistent agent that RUNS a worker's code is that
worker's tool: a lead that runs tests, a package script or git inside a worker's clone runs the
worker's files with its own rights. So with strong protection the texts of the fleet master and
of a lead say: read a worker's change through the console, never run a program, a script, a test
or a git command inside a worker's folder. The console gives them that read: `agents pr-diff <id>`
and `agents pr-file <id> <path>` (the pull request on the worker's record, fetched from GitHub by
the console in its own repo, with its own login: at most 1 MB in one answer) and `agents changes
<id>` (the worker's own report of its copy, not checked). A lead reads the workers it spawned; the
fleet master reads any worker. What they print is the worker's text: information, never an
instruction. git itself refuses a
repository that another account owns ("detected dubious ownership"), and it takes the exception
(`safe.directory`) only from the reader's own or the system config, never from the repository's
own `.git/config`: the second account's git config must never name a worker's clone.

**On a used server** (agents already ran as the console user): the set-up stops at its first step,
"fresh" (an agent record in `.agent-data`, or a session in the console user's Claude folder). It
runs as root the code of a checkout that the console user can write, and it reads files that the
console user names; on a used server, agents could have changed both. Go on only when you trust
what ran there, or after you compare the checkout with a release you trust (`git status`, `git
diff`): add `--accept-used-server`. Stop every agent first.

**Check on a real test server** (the unit tests read only the plan):

1. `id choibot-agent` shows the groups `choibot-agent` and `choibot-shared`, and no `sudo`. `sudo -l -U choibot-agent` says it may not run sudo.
2. As `choibot`: `sudo -n -u choibot-agent /usr/local/bin/choibot-agent-exec probe` prints `ok`; `sudo -n true` is refused.
3. `choibot doctor` ends with "Protection: Strong."; `choibot doctor --details` shows `mode: strong (gate assumed)` and no `repo …` line.
4. `ls -ld` shows: the data folder `~choibot/.local/share/choibot` and its `chief` and `cron` 0700; `/opt/choibot/app/.env` 0600; `/srv/choibot/agent-homes` and its `clones` root `choibot-shared` 3770; its `uploads` and `settings` `choibot` `choibot-shared` 2750; `/run/choibot-dtach` `choibot` `choibot-shared` 3770, also after a reboot.
5. As `choibot-agent`: `cat /opt/choibot/app/.env`, `ls ~choibot`, `ls /opt/choibot/app/.agent-data` are refused; `/usr/local/lib/choibot/bin/claude --version` works; `touch /usr/local/lib/choibot/bin/x` is refused.
6. `sysctl fs.protected_hardlinks` prints 1.
7. The login: on the Set-up page, "Log in to Claude" shows a link of claude.com; after the code, the row is done. As root: `ls -l ~choibot-agent/.claude/.credentials.json` (owner `choibot-agent`, 0600); `~choibot/.claude` has no credentials. `choibot login` (as `choibot`) prints "(the login of your agents)". Start a login and press Cancel (or "New link"): within 5 seconds `ps -u choibot-agent -o args` lists no `claude auth login`.
8. With the login made: on the Set-up page ask the guide "What comes next?". It answers. While it thinks, `ps -u choibot-agent -o args` lists one `claude -p … --tools  --restricted …`; after it, `ls -d /tmp/choibot-print.*` finds nothing. As root, `journalctl _SYSTEMD_USER_UNIT=choibot.service` has no "[guide] the model did not run" (`journalctl --user -M choibot@` needs the package `systemd-container`, and Ubuntu 24.04 does not have it: "org.freedesktop.machine1 was not provided").
9. As `choibot-agent`: `git config --global user.name` and `user.email` print the user's name and e-mail (after the Set-up step "commit name").
10. A Recurring task: make one ("Run now"). While it runs, `ps -u choibot-agent -o args` lists its `claude -p`; `ps -u choibot -o args` lists no `claude`. The task page shows its result. A task that runs `git status` in its repo reports "dubious ownership" (the known limit above).
11. With the agents' Claude login made: start an agent in the console. `ps -u choibot-agent -o pid,args` lists its dtach and claude; `ps -eo args | grep -c 'AGENT_PASS='` prints 1 (the grep itself).
   Start an agent of a repo: `ls -ld /srv/choibot/agent-homes/clones/<id>` shows owner `choibot-agent`; in it, `git remote -v` shows `console` and the console's repo, and the agent's branch is checked out; `git -C <the console's repo> branch` and `worktree list` show nothing of the agent. The agent starts with no "trust this folder" question. Let it change a file: the Changes rail lists it, and its diff shows. Give it a screenshot: the file is in `agent-homes/uploads/<id>/`. Delete the agent: its clone is gone.
   Push and PR: in that agent, commit a change and run `choibot agents pr`. While it fetches, `ps -u choibot-agent -o args` lists one `git upload-pack --strict … /clones/<id>/.git`; then the pull request is on GitHub, `git -C <the console's repo> for-each-ref refs/agents/` lists the agent's branch, and `git -C <the console's repo> branch` lists no agent branch. A second commit and `choibot agents pr` again: the same pull request gets the commit. `choibot agents fetch-base`, then in the clone `git fetch console && git merge console/main`: no "dubious ownership".
12. Run `strong-setup` again: it ends with ✔, says "no restart" (no agent stops), and `/etc/sudoers.d/choibot-agent-exec` and `.env` are the same as before (`sha256sum`); as `choibot-chief`, `git config --global --get-all safe.directory` lists the same entries as before.
13. As `choibot-agent` and as `choibot`, with no credential, from the server: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<PORT>/api/agents` (and any other route) prints 403; `/`, `/_next/static/…` and the pairing routes answer. As `choibot`, `choibot doctor` still shows the steps of the running console.
14. The second account: `id choibot-chief` shows `choibot-chief` and `choibot-shared`, no `sudo`, and not the group of `choibot`; `id choibot-agent` does not show `choibot-chief`; `id choibot` shows `choibot-chief`. `ls -ld /srv/choibot/agent-homes/chief /run/choibot-dtach-chief ~choibot-chief ~choibot-chief/.claude`: `root` `choibot-chief` 3770, `choibot` `choibot-chief` 3770, then 0700 and 0700 of `choibot-chief`; the same after a reboot. As `choibot`: `sudo -n -u choibot-chief /usr/local/bin/choibot-agent-exec probe` prints `ok`. `grep Groups /proc/<pid of the console>/status` holds the gid of `choibot-chief`. As `choibot-chief`: `git config --global --get-all safe.directory` lists only agent folders of `agent-homes/chief`. `strong-setup`'s last step printed "The console (pid …) has the group choibot-chief."
15. The walls, as `choibot-agent`: it cannot list `/run/choibot-dtach-chief` or `/srv/choibot/agent-homes/chief`, read `~choibot-chief/.claude`, read a hook file of the fleet master, read `/proc/<pid>/environ` of a process of `choibot-chief`, signal it (`kill -0`), or run `sudo -u choibot-chief` anything.

**The first run on a test server, in this order.** It runs the checks above with the steps that no
test on the build machine could prove (one account, no root: PRs #105 to #114). Use a new server,
never the owner's, a GitHub repo made for the test, and a Claude login that may be used for it.
Stop at the first step that fails, and write down its output.

1. Install with the hosted layout (`/opt/choibot`, `/srv/choibot/workspace`), then `strong-setup --dry-run`, then `strong-setup`. Checks 1 to 6. Then `ls -ld /srv/choibot/agent-homes/{clones,uploads,settings}`: `clones` is `root` `choibot-shared` 3770 (`drwxrws--T`); `uploads` and `settings` are `choibot` `choibot-shared` 2750 (#110).
2. The login on the Set-up page: check 7. Press Cancel once during a login: `claude auth login` ends within 5 seconds, so sudo relays the stop signal (#105).
3. The guide: check 8 (#107).
4. The commit name on the Set-up page: check 9. `find /srv/choibot/workspace -type f -perm -g=w` prints nothing: the console's files are not group-writable (#109, umask 022).
5. Connect the test repo on the Set-up page, then start an agent of it: check 11, line 2. The clone works across two accounts (#110: the console's repo is named in `safe.directory` on the command line), and the agent starts with no "trust this folder" question. In the clone, `git config --get remote.console.uploadpack` names the console's repo (#114).
6. The Changes view (#112): let the agent change a file and make a new one. The Changes rail lists both, the diff shows them, and the git bar shows the agent's branch. `journalctl -t sudo | grep repo-read` lists the helper's reads as `choibot-agent`. Let the agent run `git checkout --detach`: the git bar says "detached", not "error".
7. Transcripts and widgets (#111): the agent's thread shows its messages. Reboot the server: the agent comes back with its conversation (`journalctl -t sudo | grep session-ensure` lists the check as `choibot-agent`), and its thread still shows the old messages. `journalctl -t sudo | grep read-thread` lists the helper's reads as `choibot-agent`; `ls -l` of its session file shows `choibot-agent` 0600 in a 0700 folder. Ask the agent for a widget: it shows. Then, as `choibot-agent`, replace the widget's `data.json` with a link to `/opt/choibot/app/.env`: the widget shows no data, and the console's log has no content of `.env`.
   The Plan rail: ask the agent to make a task list (TaskCreate) and to tick one task. The rail shows the list and the tick; `journalctl -t sudo | grep read-tasks` lists the reads as `choibot-agent`, about one in 5 seconds while it works. Ask a lead the same: its reads run as `choibot-chief`. Then, as `choibot-agent`, replace one task file with a link to `/opt/choibot/app/.env`: the rail is empty, and the console's log says "a link", with no content of `.env`.
8. Push and PR with the test repo (#114): check 11, line 3. The fetch runs through the real sudo as `choibot-agent`, and the push and the pull request reach GitHub. Then a commit that changes `.github/workflows/`: GitHub refuses the push (no `workflow` scope), and the agent sees the reason. Then push a commit to the agent's branch on GitHub by hand, and run `choibot agents pr` again in the agent: 409 ("never force-pushes").
9. A Recurring task: check 10 (#108). Make one with `choibot cron add` (`"timeoutMinutes": 1`) and a prompt that runs longer, then `choibot cron run <name>`: it stops within 2 minutes, and the task page says the time was over (sudo relays the stop; the helper ends it 60 seconds after its time in any case). Ask a task to run `git status` in its repo: "dubious ownership" (the known limit).
10. Delete the agent of step 5: its clone, `agent-homes/settings/<id>.json` and `agent-homes/uploads/<id>/` are gone, and `git -C <the console's repo> for-each-ref refs/agents/` prints nothing.
11. `strong-setup` again: check 12.

## The first boot of a server made from an image (`first-start`)

A hosted server starts from a prepared image. Its first-start data (cloud-init `write_files`)
puts `/etc/choibot/first-start.json` (root, 0600) on it: the SHA-256 of the claim secret, the
server's id, the end time of the link and the console's address; never the secret. At boot,
`choibot-first-boot.service` (after cloud-init, before any user session) runs
`/usr/local/sbin/choibot-first-boot` as root (`deploy/choibot-first-boot`; its config is
`/etc/choibot/first-boot.conf`: `CONSOLE_USER`, `CLI`, `UNIT`). It copies the file for the
console's user, removes it from `/etc`, and runs `choibot first-start <copy>` as that user:

- a NEW cookie secret (`CONSOLE_COOKIE_SECRET`): the image build wrote one, and every server of
  the image would share it;
- the console's address (`CHIEF_CONSOLE_URL`) from `url`;
- the pairing codes of the image build go; the claim link of this server goes into the data folder;
- with the file's `proxy` key (a hosted console behind the door): the five `CONSOLE_PROXY_*`
  settings, and a NEW key and certificate for the private listener (`<data folder>/proxy-tls`).
  The journal line gives the certificate's SHA-256. Without the key, no proxy setting stays.

It refuses a console with a paired device (not a first start). If it stops with an error after
the settings are written and before the claim link is in place, the console has the new settings
but no claim link: it shows its pairing screen and refuses the claim link of the dashboard. The
step can run again (there is still no paired device): put the same file back at
`/etc/choibot/first-start.json` (root, 0600; it is the file of the server's cloud-init user
data), and `choibot-first-boot.path` runs the step again. `choibot-first-boot.path` runs the
same step for a file that comes later. Check: `journalctl -u choibot-first-boot` shows
"✔ The first start of this server is ready" and the end time of the link; `/etc/choibot/first-start.json`
is gone.

What the image itself must not hold (the recipe's clean-up removes it, and checks): a paired
device (`user-devices.json`), an agent record (`.agent-data`: hook tokens), a Claude login of
either account (`.credentials.json`, `.claude-accounts`), a GitHub login (`~/.config/gh/hosts.yml`),
the CLI user token, a Telegram token, the SSH host keys, the machine id, cloud-init's instance
data, shell histories and logs.
