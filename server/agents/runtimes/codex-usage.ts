// server/agents/runtimes/codex-usage.ts
//
// ChatGPT subscription limits for the usage meter. The meter is account-wide,
// so these windows are simply appended to the Claude ones — the widget already
// renders whatever windows it is handed, which is how per-model weekly caps
// arrived without a UI change.
//
// Source: the Codex app-server's `account/rateLimits/read` JSON-RPC method,
// spoken over a short-lived `codex app-server --stdio` child. Codex publishes no
// `usage` command and no documented HTTP endpoint; the app-server protocol is
// experimental and can change without notice, so — exactly like server/usage.ts
// — every path here degrades to [] and never throws. A box with no codex, no
// login, or a renamed method just shows the Claude windows.
//
// The observed reply on a Plus account (2026-08, codex-cli 0.144.0):
//   { rateLimits: { limitId: "codex", planType: "plus",
//       primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1787245492 },
//       secondary: null } }
// The same snapshot appears snake_cased (`rate_limits` / `used_percent` /
// `resets_at`) inside session rollout files, so the normalizer reads both
// spellings and both reset encodings (epoch seconds or an ISO string).
import { spawn } from "node:child_process";
import type { UsageWindow } from "../../usage.js";

const RPC_TIMEOUT_MS = 8000;
const MAX_PENDING_LINE = 1_000_000;

function severityOf(pct: number): UsageWindow["severity"] {
  if (pct >= 90) return "critical";
  if (pct >= 75) return "warning";
  return "normal";
}

function num(v: unknown): number | null {
  const n = Number(v);
  return typeof v !== "boolean" && v !== null && v !== "" && Number.isFinite(n) ? n : null;
}

// Epoch seconds (what both the app-server and the rollout emit) or an already
// formatted ISO string (what the console's own fixtures and any future payload
// may carry). Anything else is "unknown", which the widget renders as no reset.
function resetsAt(raw: Record<string, unknown>): string | null {
  const v = raw.resets_at ?? raw.resetsAt;
  if (typeof v === "string") return v;
  const n = num(v);
  if (n === null) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Render the stated window length as itself rather than mapping it onto a name.
// Codex's windows are not a fixed set — 300, 10080 and 43200 minutes have all
// been seen on this box across plans — so any bucket list would eventually put a
// name on a duration that contradicts it. A duration cannot go stale.
function durationLabel(mins: number): string {
  let remaining = Math.round(mins);
  const days = Math.floor(remaining / 1440);
  remaining %= 1440;
  const hours = Math.floor(remaining / 60);
  const minutes = remaining % 60;
  return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
    .filter(Boolean)
    .join(" ") || "0m";
}

// The key stays positional (primary/secondary) so it is stable across plans, but
// the LABEL follows the window actually measured: a Plus account reports a
// 10080-minute window in `primary`, and calling that "Session" would be wrong.
// Only when the payload states no duration does the positional name stand in.
function win(key: string, fallback: "session" | "weekly", raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pct = num(r.used_percent ?? r.usedPercent ?? r.percent);
  if (pct === null) return null;
  const rawMins = num(r.window_minutes ?? r.windowDurationMins);
  const mins = rawMins !== null && rawMins > 0 ? rawMins : null;
  const group = mins === null ? fallback : mins >= 1440 ? "weekly" : "session";
  const named = group === "session" ? "Codex · Session" : "Codex · Week";
  const percent = Math.max(0, Math.min(100, Math.round(pct)));
  return {
    key,
    label: mins === null ? named : `Codex · ${durationLabel(mins)}`,
    group,
    percent,
    severity: severityOf(percent),
    resetsAt: resetsAt(r),
    active: false,
  };
}

export function normalizeCodexLimits(raw: unknown): UsageWindow[] {
  const r = raw as Record<string, any> | null | undefined;
  const lim = r?.rate_limits ?? r?.rateLimits;
  if (!lim || typeof lim !== "object") return [];
  return [
    win("codex:session", "session", lim.primary),
    win("codex:weekly", "weekly", lim.secondary),
  ].filter((w): w is UsageWindow => w !== null);
}

// One request, one child, then gone. The app-server is a long-lived daemon by
// design, but the meter is polled at most every few minutes behind usage.ts's
// cache, so keeping a process resident to serve it would cost more than it saves
// — and a dead short-lived child cannot wedge the console.
export function readRateLimits(bin: string, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const done = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    child.on("error", () => done(null));
    child.on("close", () => done(null));
    // A stream 'error' with no listener is an UNCAUGHT exception, not a rejected
    // promise — it would take the whole console down. The live case is a binary
    // that exits before the handshake is written: the sends below then hit a
    // closed pipe and EPIPE arrives asynchronously, past any try/catch.
    //
    // Swallowed, NOT settled: a child that answered and exited in one breath
    // gives us both an EPIPE on stdin and a valid reply on stdout, and resolving
    // on the write failure would race the read and discard the answer. Whether
    // an answer arrives is stdout's business; 'close' or the timeout ends it.
    child.stdin?.on("error", () => { /* the reader is gone; stdout decides */ });
    child.stdout?.on("error", () => done(null));

    const send = (msg: unknown) => {
      try { child.stdin?.write(JSON.stringify(msg) + "\n"); } catch { /* see above */ }
    };
    // The handshake is mandatory: the server answers nothing else until it has
    // seen `initialize` and the `initialized` notification.
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { clientInfo: { name: "choibot", version: "0.1.0" } },
    });
    send({ jsonrpc: "2.0", method: "initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });

    // Line-delimited JSON, interleaved with unsolicited notifications (config
    // warnings, remote-control status), so match on the request id rather than
    // assuming an ordering.
    let buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 2) { done(msg.result ?? null); return; }
      }
      // Only the UNTERMINATED tail is held, so the cap bounds a single
      // pathological line rather than a long, well-behaved stream.
      if (buf.length > MAX_PENDING_LINE) done(null);
    });
  });
}

// No CODEX_HOME override: the child inherits the console's environment and so
// reads the box's own ~/.codex login — the account these agents actually bill
// against. (buildCodexHome symlinks that same auth.json into every per-agent
// home, so there is exactly one subscription to report on.)
export async function codexUsageWindows(): Promise<UsageWindow[]> {
  const bin = process.env.CODEX_EXECUTABLE ?? "codex";
  try {
    return normalizeCodexLimits(await readRateLimits(bin));
  } catch {
    return [];
  }
}
