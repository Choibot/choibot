# Screen fixtures

Real screens of Claude Code 2.1.322 in a 120×30 PTY, captured on 2026-11-10
with node-pty and `@xterm/headless` (the path `server/agents/screen.ts` uses).
One row per line, right-trimmed. `prompt.test.ts` and `screen.test.ts` read them.

| File | How it was made |
| --- | --- |
| `trust-2.1.322.txt`, `.raw` | `claude` in an untrusted temp folder. Not answered. `.raw` holds the PTY bytes. |
| `theme-2.1.322.txt`, `theme-moved-…` | `claude` with an empty `CLAUDE_CONFIG_DIR` (first run). Second file: after Down. |
| `login-2.1.322.txt`, `login-second-…` | Same run, after Enter on the theme. Second file: after Down. No login was started. |
| `idle-input-…`, `typed-list-in-input-…`, `slash-menu-…`, `model-picker-…` | `claude` in a trusted folder: the empty input box, `1. first` / `2. second` typed and not sent, `/model` typed, the `/model` dialog (closed with Esc). |
| `running-…`, `permission-…`, `permission-moved-…`, `idle-after-turn-…` | One Haiku turn in manual permission mode (`touch hello.txt`): the spinner, the Bash permission dialog, the dialog after Down, the screen after Esc. |

To add a screen of a newer Claude Code version: capture it the same way and
add a case to `prompt.test.ts`. A dialog that the detector does not know must
come out as `unknown` or `null`, never as a wrong card.
