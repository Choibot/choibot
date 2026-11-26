# The new-server test

One command runs the whole path of a new user on a clean install: from the install line to the
first merged pull request, then the optional steps. It says pass or fail for each step. It is
the release gate of the onboarding.

```
CHOIBOT_TEST_PLAYWRIGHT=<folder of playwright-core> pnpm test:path
```

- Exit code 0: each step passed. Exit code 1: one step or more failed. Exit code 2: the test
  could not start (no browser, no `openssl`).
- It prints one line for each step while it runs, then a table: the step, pass / fail / skipped
  (with the reason), and the time.
- For a failed step, the output folder holds a picture of each open page (`<step>-<page>.png`)
  and a text file (`<step>.log`) with the reason, the text of each page and the last lines of
  the logs. The test prints the path of the folder. A run with no failure removes the folder.
- Run time on the development server (8 processors): about 5 minutes. Three runs in a row gave
  the same result for each step.

Ctrl-C stops the run and removes its installs.

Options: `--out <folder>` (the output folder), `--shots <folder>` (pictures of some screens of the
path), `--until <step>` (stop after that step), `--only a` or `--only b` (one of the two installs),
`--keep` (leave the two installs running to look at them; the test then prints how to stop them).

## What it needs

- Linux with `bash`, `git`, `python3`, `curl`, `tar`, `openssl`, `ss`, `script`, `dtach` and the build tools
  (`make`, `g++`): the same tools as the install line itself.
- Node 22 or newer for the test itself. The installs use the Node that the install line downloads.
- A headless browser: `playwright-core` with its Chromium. This repo does NOT depend on it (it
  is a large download and only this test uses it). Install it in a folder outside the repo
  (`npm install playwright-core && npx playwright-core install chromium`) and give that folder in
  `CHOIBOT_TEST_PLAYWRIGHT`.
- The internet for the install line: the Node archive and the GitHub tool archive (one download
  each, then they come from `/tmp/choibot-it-cache`), and the packages of the console.

## How it stays away from a console that runs on the same machine

The test is made for a machine that runs a live console under the same Linux user.

- Each install is in a throwaway folder `/tmp/choibot-it-<name>` with its own `HOME`. Its
  commands start with an empty environment and a `PATH` that holds only fakes and links to the
  plain tools of `/usr/bin` (scripts/install-test/run.sh). The real `systemctl`, `loginctl`,
  `sudo`, `tailscale`, `crontab`, `claude`, `gh` and `systemd-run` are not on that `PATH`.
- The fakes: `systemctl` (it starts the console as a plain process), `systemd-run`, `loginctl`,
  `sudo` (it runs nothing and counts the calls), `tailscale`, `curl`, `claude` (the login, the
  model of the guide, the session of the install agent, the first agent), `gh` (the GitHub tool
  and GitHub itself: bare git repos in the test folder), a Telegram Bot API on 127.0.0.1 and the
  private address (a TLS listener on 127.0.0.1).
- A guard in each Node process of the test (the console and the commands) refuses a connection
  that does not go to a port of the test. So the test cannot reach Anthropic, Telegram, GitHub,
  or the port of another console. What the product tried is written down and checked.
- The test proves it: before and after the run it lists `~/.config/systemd/user`,
  `systemctl --user list-unit-files`, the top level of `~/.local/share`, the crontab and the
  listening ports of the real user. It fails when a list differs. Transient units and ports of
  other work on the machine are not counted: they are named in `notes.txt` of the output folder.
- Each port of the test listens on 127.0.0.1 only (step z1). The folders are removed at the end.
- The test reads no settings file and no login file of the real user. Of its own installs it
  compares the settings file by checksum only.

Do not change `scripts/install-test/run.sh` or a fake while a run is in progress.

## The two installs

**A · phone and laptop (the happy path).** Tailscale is on the server and signed in (a fake).
The install line → the Claude login → the console under the new names → both addresses show
only the pairing screen → the first device pairs with the code of the script → the Set-up page
is the home → the guide welcomes and answers → Connect GitHub with a code → the commit name →
pick a repo → the first agent (a real commit, a real push, a pull request and its ticket) → the
ticket in the row and in the Queue → Merge from the row → the done screen → Add a device (a
second browser, phone size) → Telegram (the token form, "Connect your chat", a ticket card, a
tap) → a lead from the done card → the home is the normal console → the install line again.

**B · laptop only, and things go wrong.** No Tailscale: the SSH tunnel address. A failed install
step with no Claude login → the install line again with a login: the install agent (a fake
session, each call through the REAL rule hook) → a wrong pairing code and a spent one → no Claude
login: the guide is off and the rows work → the GitHub code runs out → the repo copy fails → the
plan limit closes the guide → the first agent stops with no pull request, "Try again" → Merge →
the end of the set-up with the tunnel only → Add a device at the tunnel address → Tailscale
comes later: "Add a device" at the tunnel address pairs this browser at the private address →
a hosted console: all devices are revoked and the test writes the first-start file that an image's
first-boot step writes; a link that is too old names the dashboard and shows no code field, a
wrong link is refused, the right link pairs a phone with one press ("This is my console"), the
console keeps nothing of the secret, and the same link does not pair again.

## What this test can NOT prove on one machine, and the check a person does

Each line is a thing that a fake stands for. Do these checks on the first real server.

| Not proven here | The check on the first real server |
|---|---|
| A real Claude login (the link, the code that is pasted back, a wrong code, the wrong account) | In the install, open the link, approve, paste the code. Read the line “Logged in as … Plan: …”: it must name your account and your plan. |
| A real model: the guide, the install agent, the first agent | On the Set-up page, ask the guide “What is a ticket?”. Then start the first agent and wait for its pull request (3 to 6 minutes). The install agent starts only when a step of the install fails: when that occurs on a real server, read what it asks before each command. There is no checked way to make a step fail on purpose. |
| A real service manager: start at boot, restart after a crash, the service after you log out, the restart after a save in Settings | Reboot the server. Wait 1 minute. Open the console: it must answer, and a running agent must be there again. Save the Telegram token in Settings: the page must come back after about 10 seconds. |
| A real Tailscale: its install, the sign-in link, the HTTPS switch of the account, the address on a phone | Run `choibot access`, follow its 2 commands, and open the printed address on the laptop and on the phone (Tailscale on, the same account). |
| A real GitHub: the code on github.com/login/device, an organisation that hides its repos, a repo that needs a review or has checks, a push that a branch rule refuses | Do the step “Connect GitHub” with your account. Pick a real repo. After the first agent, open the pull request on github.com and check that the commit carries your name. Merge from the row. |
| A real Telegram: BotFather, a wrong token, the Start button, the card on a phone | Make a bot with @BotFather, paste its token, press “Connect your chat”, press Start in Telegram. The test message must arrive. Add a ticket (ask an agent a question) and tap an answer on the phone. |
| sudo: the commands that only root can run (the tools, “stay on after logout”, Tailscale) | Use a server where `dtach` is not installed. The install line must show the one `sudo apt-get install` command, wait, and go on by itself after you run it in a second terminal. |
| A server with little memory (2 GB) and a slow disk | Install on a 2 GB server. The step “Building” must end. Note the time of the whole install. |
| A root login, and a shell that came in with `su` | Paste the install line as root: it must stop at once and show the commands that make the user. Then log in as that user and paste it again. |
| A phone browser (Safari on iOS, Chrome on Android): the camera, the code picture, the page inside another app | Press “Add a device”, scan the code picture with the camera of the phone, and pair. Open the link one time inside a chat app: the page must say to open it in Safari or Chrome. |
| A real claim link from a hosted dashboard (the first-start file of a real cloud server) | On the first real hosted server: open the link of the dashboard on a phone, press “This is my console”, then open the same link again: it must say that it does not work now. Then read the console's log: it must name the end time of the link and hold no part of the link. |
| The public download (the install line with no source) | When the repo is public: paste the public install line on a new server with nothing else. |
| A second person on the same network before the first pairing | From a second computer on the Tailscale network, open the address before you pair: it must show only the pairing screen. |

The test also uses 2 test switches of the console that a real install does not have: the address
of the fake Telegram, and (inside the console's Node process) the answer to “do I run in my own
service?” (scripts/path-test/fakes/preload.mjs). The second one makes the save in Settings
possible under the fake service manager.
