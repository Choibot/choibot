// bin/install-agent/hook.mjs — the PreToolUse hook of the install agent (bin/lib/repair.ts puts
// it into the settings of the session). Claude Code gives each tool call as JSON on stdin
// (https://code.claude.com/docs/en/hooks: tool_name, tool_input, cwd); the answer is the
// decision of policy.mjs: allow, ask or deny, with the reason the person and the model read.
//   node hook.mjs <the context of the install, as base64url JSON>
// A call this file cannot read does not run: every failure here is a "deny".
import { decide } from "./policy.mjs";

const answer = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  }));
};

try {
  const ctx = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const call = JSON.parse(raw);
  const verdict = decide(String(call.tool_name), call.tool_input ?? {}, { ...ctx, cwd: typeof call.cwd === "string" && call.cwd ? call.cwd : ctx.base });
  if (verdict) answer(verdict.decision, verdict.reason);
} catch {
  answer("deny", "The rule check of the install agent failed, so this call does not run.");
}
