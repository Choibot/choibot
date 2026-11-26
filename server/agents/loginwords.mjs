// server/agents/loginwords.mjs — the words of Claude Code for a login that is signed out. One
// list for the console (stopwhy.ts: why an agent stopped) and for the cron runner
// (bin/lib/cron-failure.mjs: why a Recurring task's run failed). Plain JS with no imports: the
// runner starts with a bare node.
//
// The words come from the error reference of Claude Code (code.claude.com/docs/en/errors,
// "Authentication errors"): "Not logged in · Please run /login", "OAuth token revoked · Please run
// /login", "Login expired · Please run /login", "Please run /login · API Error: 401 …",
// "Authentication required · Sign in again to continue". `claude -p` says "Failed to
// authenticate: OAuth token revoked. Please log in again or contact your administrator."
// Only these: an error of the network, of the server or of an API key is not a signed-out login.
export const LOGIN_RE = /please run \/login|OAuth token revoked|please log in again|\bnot logged in\b|\blogin expired\b|sign in again to continue/i;
