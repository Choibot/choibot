// The claude argv builder moved into the runtime adapter (runtimes/claude.ts);
// re-exported here so existing imports keep working.
export { buildClaudeArgs } from "./runtimes/claude.js";
import { NO_MERGE_RULE, brainPrompt } from "../chief/brain/prompt.js";
import { queueAgentPrompt } from "../chief/queue/prompt.js";
import { remindAgentPrompt } from "../chief/remind/prompt.js";
import { join } from "node:path";
import { envKey, names } from "../names.mjs";

// Standing instruction appended to every worktree (repo) agent's system
// prompt: how to surface docs/artifacts in the console's Docs view. Workspace
// agents and the fleet master have no worktree, hence no Docs view — skip them.
// Shared by every runtime, so it lives outside the adapters.
export const SHARED_DOCS_PROMPT =
  `Console docs sharing: to show the user a document or UI, list it in \`${names().repoFolder}/docs.json\` at the repo root — ` +
  'a JSON array of entries like {"path":"docs/plan.md","title":"Plan"} (path repo-relative, title optional). ' +
  "Markdown (.md) renders as a doc; .html renders as a live sandboxed artifact — it must be a single " +
  "self-contained file (inline CSS/JS, no build step, no external/CDN references). Shared files render live " +
  `from disk, so keep editing them in place; copy files from outside the repo into \`${names().repoFolder}/docs/\` first. ` +
  "Share a spec/plan/report this way whenever the user asks to see one, or when a visual would help.";

// Appended after SHARED_DOCS_PROMPT for agents started from an issue
// (kind "issue"). Their text replies are relayed to the user's phone, so a
// question must be plain text that ends the turn — AskUserQuestion draws a
// TUI menu nobody on Telegram can answer.
export const ISSUE_AGENT_PROMPT =
  "If the issue is unclear, ask one short question in plain text and end your turn. " +
  "Never use the AskUserQuestion tool. Your text replies are relayed to the user over Telegram.";

// The system prompt of a repo (worktree) agent. A constant chosen by kind, so
// nothing is stored on the record and create + resume always agree.
export function repoAgentPrompt(kind?: string): string {
  return kind === "issue" ? `${SHARED_DOCS_PROMPT}\n\n${ISSUE_AGENT_PROMPT}` : SHARED_DOCS_PROMPT;
}

// Standing instruction for every non-master agent: how to put live widgets in
// the strip above its terminal (spec 2026-10-22-agent-widgets-design.md). It
// names the agent's own absolute widget folder, so it is built per agent.
export function widgetsPrompt(dir: string): string {
  return [
    "Console widgets: you can show the user small live UIs in a strip above your terminal. Your widget folder is " +
      dir + "/ — one subfolder per widget, named like `rate-x` (lowercase letters, digits, - and _, starting with a letter or digit, max 48 chars; the same rule fits action names).",
    "Files in a widget folder:",
    "- widget.html (required, max 1 MB): free HTML/CSS/JS; CDN scripts are fine. It runs in a sandboxed iframe with no access to the console. The frame is sandboxed: localStorage and popups do not work; use choibot.setState for state.",
    '- meta.json (optional): {"title":"…","width":260 (px 160-1200, or "wide"),"height":180 (px 80-800),"chrome":true (false = no console header; draw your own),"autoRefresh":60 (seconds, min 30, only with a refresh script),"order":1,"historyMax":500}.',
    `- refresh (optional, executable: chmod +x): prints the fresh data as JSON on stdout (exit 0; stdout must be only the JSON, max 256 KB for refresh, 1 MB for actions; log to stderr). On failure the old data stays and the box shows a red dot. The console runs it when the user refreshes and writes data.json and history.jsonl. It gets the widget's args as JSON on stdin, runs in your cwd, has 30 s, and gets a minimal env (PATH, HOME, USER, LANG, TZ, ${envKey("WIDGET_DIR")}, ${envKey("AGENT_ID")}): read keys from files, not from env.`,
    "- actions/<name> (optional, executable): same contract; its JSON goes back to the calling widget only.",
    "- data.json: the latest data (max 256 KB). Do not write history.jsonl, state.json, ui.json or status.json: the console owns them.",
    'In widget.html use the global `choibot`: choibot.data, choibot.history ([{at,data}]), choibot.state, choibot.theme ("light"|"dark"), choibot.size ("box"|"large"), choibot.widgetId; choibot.refresh(args?), choibot.action(name, args?), choibot.ask(text), choibot.setState(obj), choibot.resize({width, height}) and choibot.setAutoRefresh(seconds|null; min 30) return Promises. choibot.data is null until the first window event "choibot:data" (detail {data, history}): render on that event. "choibot:theme" fires when the theme changes.',
    "choibot:data fires on every new data.json (script-written or agent-written), and the console appends each one to choibot.history as {at: epoch ms, data}. Draw time series from choibot.history; write only the current value to data.json.",
    'choibot.refresh(args?) resolves {mode, data?}. With no refresh script it resolves {mode:"agent"} with no data; the fresh data arrives later as a choibot:data event. choibot.ask(text) and an agent-mode choibot.refresh() first show the user a confirm bar; on Cancel the promise rejects with "cancelled". For agent-mode widgets prefer the console\'s ⟳ button over an in-widget refresh button.',
    "Prefer a refresh script when the data can be fetched by CLI or HTTP API. When the data needs an MCP tool, leave out the script and answer `[widget <id>] Refresh` messages by writing data.json.",
    "Make a widget when the user asks to watch or track a number or a state over time.",
  ].join("\n");
}

// The whole system prompt of a non-master agent. spawn.ts (create) and
// recovery.ts (relaunch) both call it, so they always agree. Repo agents keep
// the Docs text (plus the issue text for kind "issue") in front of it.
export type ChiefPromptOpts = { brain: string; cli: string };

// An agent with its own copy of the repo (strong protection, design B): no GitHub login there.
export function clonePushPrompt(cli: string, base: string): string {
  return `Your repo folder is your own copy of the repo. It has no GitHub login: \`git push\` and \`gh\` do not work here. ` +
    `Commit your work, then run \`${cli} agents pr\` to push your branch and open its pull request (JSON on stdin, optional: ` +
    `{"title":"…","body":"…","draft":true}); run it again later to push new commits to the same pull request. ` +
    `For the newest ${base} from GitHub: \`${cli} agents fetch-base\`, then \`git fetch console && git merge console/${base}\`.`;
}

export function agentPrompt(
  rec: { kind?: string; repo?: string; id: string; clone?: boolean; baseBranch?: string },
  widgetsRoot: string,
  chief?: ChiefPromptOpts,
): string {
  const widgets = widgetsPrompt(join(widgetsRoot, rec.id));
  const docs = rec.repo ? repoAgentPrompt(chief && rec.kind === "issue" ? undefined : rec.kind) : "";
  const withDocs = rec.repo ? `${docs}\n\n${widgets}` : widgets;
  const base = rec.repo && rec.clone === true && chief ? `${withDocs}\n\n${clonePushPrompt(chief.cli, rec.baseBranch || "main")}` : withDocs;
  // Chief of staff: base -> merge rule -> queue paragraph -> brain. The queue
  // paragraph replaces ISSUE_AGENT_PROMPT for issue agents.
  if (!chief) return base;
  const withQueue = `${base}\n\n${NO_MERGE_RULE}\n\n${queueAgentPrompt(chief.cli)}\n\n${remindAgentPrompt(chief.cli)}`;
  return chief.brain !== "" ? `${withQueue}\n\n${brainPrompt(chief.brain)}` : withQueue;
}
