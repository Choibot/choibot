// Per-agent Claude Code hook settings: each event POSTs its JSON stdin payload
// to our token-gated endpoint. Verified payload shape (probed on the box):
//   SessionStart:     { session_id, cwd, hook_event_name, source }
//   UserPromptSubmit: { session_id, cwd, hook_event_name, prompt }
//   Stop:             { session_id, cwd, hook_event_name, last_assistant_message, ... }
function hookCommand(agentId: string, token: string, port: number): string {
  const url = `http://127.0.0.1:${port}/api/agents/${agentId}/hook?token=${token}`;
  // --data-binary @- streams the stdin payload (the hook JSON) as the request body.
  return `curl -s -X POST "${url}" -H "content-type: application/json" --data-binary @- >/dev/null 2>&1 || true`;
}

export function buildHookSettings(opts: { agentId: string; token: string; port: number }) {
  const c = hookCommand(opts.agentId, opts.token, opts.port);
  const entry = [{ hooks: [{ type: "command" as const, command: c }] }];
  // SessionStart only captures the session id (the process launching is not
  // "running"). UserPromptSubmit is what flips us to running — the moment a
  // prompt is actually sent. Stop/Notification bring us back to idle.
  return { hooks: { SessionStart: entry, UserPromptSubmit: entry, Stop: entry, Notification: entry } };
}

// Session ids are used as path segments downstream (transcript lookup in
// recovery.ts, the tasks dir in the /tasks route), so only a plain
// filename-shaped id may be persisted — anything else is dropped here, at
// the single write site.
const SESSION_ID_RE = /^(?!\.+$)[\w.-]+$/; // filename-shaped, and never "." / ".."

// The same check for a reader that builds a path from a stored id (the thread
// reader): a record written before this guard may hold anything.
export function isSessionId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 128 && SESSION_ID_RE.test(v);
}

export function hookToStatus(
  payload: { hook_event_name?: string; session_id?: string; source?: string },
): { status?: "running" | "idle"; sessionId?: string } {
  const raw = payload.session_id;
  const sessionId = raw && SESSION_ID_RE.test(raw) ? raw : undefined;
  switch (payload.hook_event_name) {
    // Fires when the claude process launches, before any prompt — capture the
    // session id but do NOT mark running; the agent stays idle until a prompt lands.
    case "SessionStart": return { ...(sessionId ? { sessionId } : {}) };
    case "UserPromptSubmit": return { status: "running", ...(sessionId ? { sessionId } : {}) };
    case "Stop":
    case "Notification": return { status: "idle", ...(sessionId ? { sessionId } : {}) };
    default: return {};
  }
}
