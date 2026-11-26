// server/agents/runtimes/codex-home.ts
//
// Codex has no --settings flag and no --append-system-prompt: everything it
// needs comes from CODEX_HOME. So the console builds one per agent, which also
// buys the isolation Claude gets from a per-agent settings file — each agent's
// hook token, session rollouts, and skill set are its own.
//
// Placement mirrors where the Claude hook settings already go: inside the
// worktree for a repo agent (.choibot/ is git-excluded and dies with the worktree),
// and under .choibot-agents/<id>/ for a workspace agent, which the delete route
// already cleans up.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentRecord } from "../store.js";
import { buildSkillFarm } from "./codex-skills.js";
import { DISPLAY_NAME } from "../../brand.js";
import { names } from "../../names.mjs";
import { CLONE_CLAUDE_ONLY, isClone } from "../agentclone.js";

const execFileP = promisify(execFile);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

async function writePrivate(path: string, data: string): Promise<void> {
  await writeFile(path, data, { mode: PRIVATE_FILE_MODE });
  // writeFile preserves an existing file's mode. Repair homes made by older
  // versions, where the process umask could have left secrets world-readable.
  await chmod(path, PRIVATE_FILE_MODE);
}

export type McpServer = {
  name: string;
  command?: string; args?: string[]; env?: Record<string, string>;
  url?: string;
};

export function codexHomeFor(rec: AgentRecord, workspaceDir: string): string {
  // Never inside an agent's own clone (strong protection; spawn refuses a Codex agent there).
  if (isClone(rec)) throw new Error(CLONE_CLAUDE_ONLY);
  return rec.repo
    ? join(rec.worktree, names().repoFolder, "codex-home")
    : join(workspaceDir, names().agentsFolder, rec.id, "codex-home");
}

export function renderAgentsMd(claudeMd: string, docsPrompt: string | null): string {
  const parts = [claudeMd.trim(), docsPrompt?.trim() ?? ""].filter(Boolean);
  return parts.join("\n\n") + "\n";
}

// A TOML basic string must escape backslash, quote, and every control character
// (U+0000–U+0008, U+000A–U+001F, U+007F). A raw newline in an env value or a
// command would otherwise terminate the string mid-line and make the whole
// config.toml unparseable — including the [marketplaces]/[plugins] tables the
// codex CLI appends to the same file, which is what registers our hooks.
const TOML_ESCAPES: Record<string, string> = {
  "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r",
};

// `v` is typed unknown on purpose: these values come from a plugin's .mcp.json,
// where a number or a boolean is perfectly legal JSON. Coercing here is the last
// line of defence behind the coercion readMcpFile already does, so no upstream
// shape can turn a render into a thrown error and a failed launch.
function tomlStr(v: unknown): string {
  const body = String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, (c) =>
      TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${body}"`;
}

export const MARKETPLACE_NAME = "choibot-local";
export const PLUGIN_NAME = "choibot-status";

// Codex hooks are plugin-scoped: a freestanding hooks file in CODEX_HOME is
// silently ignored (verified — see the hooks-findings spec). So the console
// generates a one-plugin local marketplace per agent and registers it. The
// payload Codex posts is byte-identical to Claude Code's, which is why
// hookToStatus is shared rather than duplicated.
export function renderHooksJson(o: { agentId: string; token: string; port: number }): string {
  const url = `http://127.0.0.1:${o.port}/api/agents/${o.agentId}/hook?token=${o.token}`;
  // --data-binary @- streams the hook's stdin payload as the request body, the
  // same contract the Claude hook settings use. `|| true` so a console that is
  // restarting can never fail the agent's turn.
  const command =
    `curl -s -X POST "${url}" -H "content-type: application/json" --data-binary @- >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: "command", command }] }];
  return JSON.stringify(
    { hooks: { SessionStart: entry, UserPromptSubmit: entry, Stop: entry, Notification: entry } },
    null, 2,
  );
}

// The manifest is schema-validated on ingestion — an absent `interface` block
// makes the plugin fail to install rather than install half-working.
export function renderPluginManifest(): string {
  return JSON.stringify({
    name: PLUGIN_NAME,
    version: "0.1.0",
    description: "Reports agent status to the console",
    author: { name: "choibot" },
    hooks: "./hooks.json",
    interface: {
      displayName: `${DISPLAY_NAME} Status`,
      shortDescription: "Reports agent status to the console.",
      longDescription: "Posts Codex hook events to the local console endpoint.",
      developerName: "choibot",
      category: "Productivity",
      capabilities: [],
    },
  }, null, 2);
}

// `source.path` resolves relative to the marketplace ROOT (<home>/mp), not to
// the marketplace file two levels below it.
export function renderMarketplace(): string {
  return JSON.stringify({
    name: MARKETPLACE_NAME,
    interface: { displayName: "ChoiBot Local" },
    plugins: [{
      name: PLUGIN_NAME,
      source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
      policy: { installation: "INSTALLED_BY_DEFAULT", authentication: "ON_USE" },
      category: "Productivity",
    }],
  }, null, 2);
}

// Server names and env keys come from a plugin's .mcp.json, so neither is a
// legal TOML bare key by construction: a dot would silently nest a subtable
// (the server would then not exist under the name the user configured), and a
// space — or anything else outside A-Za-z0-9_- — makes the whole file
// unparseable, which takes the CLI-appended plugin tables down with it. A
// quoted key is always legal and always means exactly the name given. Bare keys
// are kept where they are legal so the common case renders as before.
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k);
}

// Two first-run gates live in CODEX_HOME, and a fresh per-agent home hits both
// on every single launch — the agent parks on a TUI prompt and never starts.
// Both were reproduced against codex-cli 0.144.0 and both are closed here.
//
// 1. Directory trust. Codex asks "Do you trust the contents of this directory?"
//    and records the answer as [projects."<root>"] trust_level. Its own prompt
//    text names the root it will use: for an agent worktree that is the MAIN
//    repository root ("You're in a subdirectory of a Git project. Trusting will
//    apply to the repository root: <repo>"), NOT the worktree — verified by
//    answering the prompt in a scratch home and reading back the key it wrote.
//    For a directory that is not in a git repo at all — the workspace agent's
//    workspace root — the key is that directory itself.
//    --dangerously-bypass-approvals-and-sandbox does NOT suppress this.
// 2. The "Update available!" dialog. A fresh home has no version.json, so the
//    startup check runs, finds a newer published codex, and blocks on a
//    three-way choice before the trust prompt is even reached. Upgrading the
//    CLI is the user's business, not an agent's, so the check is turned off
//    rather than answered.
const TRUST_LEVEL = "trusted";

// The paths that must carry a trust entry, in the form codex keys them by. A
// repo agent contributes its repository root (what codex resolves the worktree
// to) and its own working directory (harmless when codex never asks about it,
// load-bearing if a future cwd is a standalone checkout rather than a linked
// worktree). A workspace agent has no repo and runs at the workspace root, so
// that single directory is the whole answer. Blank entries are dropped and the
// result is deduped, so no path can produce a duplicate TOML table — which
// would make the file unparseable and take the CLI-appended [marketplaces]/
// [plugins] tables down with it.
export function trustedRoots(rec: AgentRecord, workspaceDir: string): string[] {
  const cwd = rec.cwd ?? (rec.repo ? rec.worktree : workspaceDir);
  return [...new Set([rec.repo, cwd].filter((p): p is string => typeof p === "string" && p !== ""))];
}

// Top-level keys must precede every table header, or they land inside whatever
// table was opened last: `check_for_update_on_startup` written after [projects]
// would become projects.check_for_update_on_startup and do nothing.
export function renderConfigToml(o: { mcp: McpServer[]; trust: string[] }): string {
  const lines: string[] = ["check_for_update_on_startup = false", ""];
  for (const path of o.trust) {
    lines.push(`[projects.${tomlKey(path)}]`, `trust_level = ${tomlStr(TRUST_LEVEL)}`, "");
  }
  return lines.join("\n") + renderMcpConfigToml(o.mcp);
}

export function renderMcpConfigToml(mcp: McpServer[]): string {
  const lines: string[] = [];
  for (const s of mcp) {
    lines.push(`[mcp_servers.${tomlKey(s.name)}]`);
    if (s.url) lines.push(`url = ${tomlStr(s.url)}`);
    if (s.command) lines.push(`command = ${tomlStr(s.command)}`);
    if (s.args?.length) lines.push(`args = [${s.args.map((a) => tomlStr(a)).join(", ")}]`);
    if (s.env && Object.keys(s.env).length) {
      const pairs = Object.entries(s.env)
        .map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(", ");
      lines.push(`env = { ${pairs} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// A .mcp.json is JSON, not a string map: a port written as `8080` rather than
// `"8080"` in `args` or `env` is common and perfectly parseable, and must never
// be able to fail a launch. Scalars are coerced the way a shell would see them;
// anything structural (object, array, null) has no shell representation, so it
// is dropped rather than passed on as "[object Object]".
function scalar(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return null;
}

function toEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = scalar(v);
    if (s !== null) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

// A plugin's .mcp.json is written for CLAUDE, which expands `${…}` placeholders
// before it launches the server. Codex expands nothing: whatever we write lands
// in config.toml verbatim, so a placeholder that survives this module becomes an
// MCP server that can never start — silently, because it is reported as usable.
//
// Exactly one of them is ours to resolve: ${CLAUDE_PLUGIN_ROOT} is the plugin's
// own install directory, which discoverMcpServers already knows. (Observed on
// this box in the telegram plugin: `args: ["run", "--cwd",
// "${CLAUDE_PLUGIN_ROOT}", …]`.) Everything else of that shape — a secret from
// Claude's environment, say ${GITHUB_PERSONAL_ACCESS_TOKEN} — we deliberately do
// NOT resolve: those are the user's Claude-side secrets and copying them into a
// world-readable config.toml is worse than not offering the server at all.
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";
const PLACEHOLDER = /\$\{[^}]*\}/;

function expand(v: string, installPath: string): string {
  return v.split(PLUGIN_ROOT).join(installPath);
}

// True when any emitted value still carries an unresolved `${…}`.
function unresolved(s: McpServer): boolean {
  const values = [s.command, s.url, ...(s.args ?? []), ...Object.values(s.env ?? {})];
  return values.some((v) => typeof v === "string" && PLACEHOLDER.test(v));
}

// Two shapes are in the wild: a bare { name: server } map and a wrapped
// { mcpServers: { … } }. Codex supports stdio (command/args/env) and streamable
// HTTP by url; it has no way to send arbitrary headers, so a server that needs
// them is reported as skipped rather than emitted half-working. The same rule
// applies to a placeholder we cannot expand — see above.
function readMcpFile(
  raw: string,
  installPath: string,
): { usable: McpServer[]; skipped: string[] } {
  const usable: McpServer[] = []; const skipped: string[] = [];
  let data: Record<string, any>;
  try { data = JSON.parse(raw); } catch { return { usable, skipped }; }
  const servers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : data;
  for (const [name, def] of Object.entries(servers ?? {})) {
    const d = def as Record<string, any>;
    if (!d || typeof d !== "object") continue;
    let server: McpServer | null = null;
    if (typeof d.command === "string") {
      const env = toEnv(d.env);
      server = {
        name,
        command: expand(d.command, installPath),
        args: Array.isArray(d.args)
          ? d.args.map(scalar)
              .filter((a: string | null): a is string => a !== null)
              .map((a: string) => expand(a, installPath))
          : undefined,
        env: env && Object.fromEntries(
          Object.entries(env).map(([k, v]) => [k, expand(v, installPath)]),
        ),
      };
    } else if (typeof d.url === "string" && !d.headers) {
      server = { name, url: expand(d.url, installPath) };
    }
    if (server && !unresolved(server)) usable.push(server);
    else skipped.push(name);
  }
  return { usable, skipped };
}

export async function discoverMcpServers(
  claudeHome = join(homedir(), ".claude"),
): Promise<{ usable: McpServer[]; skipped: string[] }> {
  // The install path travels with the file: it is the value ${CLAUDE_PLUGIN_ROOT}
  // expands to for the servers declared in that file, and nothing else.
  const files: { path: string; installPath: string }[] = [];
  try {
    const manifest = JSON.parse(
      await readFile(join(claudeHome, "plugins", "installed_plugins.json"), "utf8"),
    ) as { plugins?: Record<string, { installPath?: string }[]> };
    for (const installs of Object.values(manifest.plugins ?? {})) {
      const p = installs?.[0]?.installPath;
      if (p) files.push({ path: join(p, ".mcp.json"), installPath: p });
    }
  } catch { /* no plugins installed */ }

  const usable: McpServer[] = []; const skipped: string[] = [];
  const seen = new Set<string>();
  for (const f of files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    let raw: string;
    try { raw = await readFile(f.path, "utf8"); } catch { continue; }
    const r = readMcpFile(raw, f.installPath);
    for (const s of r.usable) if (!seen.has(s.name)) { seen.add(s.name); usable.push(s); }
    for (const n of r.skipped) if (!seen.has(n)) { seen.add(n); skipped.push(n); }
  }
  return { usable, skipped };
}

// Register the generated marketplace + plugin. Both commands honour CODEX_HOME,
// so this only ever touches the agent's own home — never the user's ~/.codex.
// Called on every spawn and resume; both commands tolerate being re-run, and a
// failure here costs status reporting, not the agent, so it never throws.
async function registerHookPlugin(home: string, root: string): Promise<boolean> {
  const bin = process.env.CODEX_EXECUTABLE ?? "codex";
  const env = { ...process.env, CODEX_HOME: home };
  try {
    await execFileP(bin, ["plugin", "marketplace", "add", root], { env, timeout: 30000 });
    await execFileP(bin, ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], { env, timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export async function buildCodexHome(
  rec: AgentRecord,
  ctx: { port: number; workspaceDir: string; systemPrompt?: string; claudeHome?: string },
): Promise<{ home: string; skills: number; skippedMcp: string[]; hooks: boolean }> {
  const claudeHome = ctx.claudeHome ?? join(homedir(), ".claude");
  const home = codexHomeFor(rec, ctx.workspaceDir);
  await mkdir(home, { recursive: true, mode: PRIVATE_DIR_MODE });
  // mkdir also preserves an existing directory's mode.
  await chmod(home, PRIVATE_DIR_MODE);

  // Subscription auth lives in the real Codex home; link it rather than copy so
  // a token refresh there is picked up here.
  const authLink = join(home, "auth.json");
  await rm(authLink, { force: true });
  try { await symlink(join(homedir(), ".codex", "auth.json"), authLink); }
  catch { /* not logged in yet — codex will say so in the terminal */ }

  let claudeMd = "";
  try { claudeMd = await readFile(join(claudeHome, "CLAUDE.md"), "utf8"); } catch { /* none */ }
  // ctx.systemPrompt is whatever the caller would have given Claude via
  // --append-system-prompt: the docs-sharing rule for a worktree agent, or the
  // cron master's identity. Codex has no such flag, so it lands here. Taking it
  // from the caller rather than rebuilding the branch keeps one source of truth.
  await writePrivate(join(home, "AGENTS.md"), renderAgentsMd(claudeMd, ctx.systemPrompt ?? null));

  // MCP servers, the directory-trust entries and the startup-update switch are
  // ours to write; the marketplace/plugin tables below are written into the
  // same file by the codex CLI, which APPENDS and so preserves what we wrote.
  // This write therefore has to come first, and it does.
  const { usable, skipped } = await discoverMcpServers(claudeHome);
  await writePrivate(
    join(home, "config.toml"),
    renderConfigToml({ mcp: usable, trust: trustedRoots(rec, ctx.workspaceDir) }),
  );

  // The hook-carrying plugin, in its own marketplace root so installing (which
  // copies into <home>/plugins/cache) cannot collide with the source.
  const root = join(home, "mp");
  const plugin = join(root, "plugins", PLUGIN_NAME);
  await mkdir(join(root, ".agents", "plugins"), { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writePrivate(join(root, ".agents", "plugins", "marketplace.json"), renderMarketplace());
  await writePrivate(join(plugin, ".codex-plugin", "plugin.json"), renderPluginManifest());
  await writePrivate(
    join(plugin, "hooks.json"),
    renderHooksJson({ agentId: rec.id, token: rec.hookToken, port: ctx.port }),
  );
  const hooks = await registerHookPlugin(home, root);

  const skills = await buildSkillFarm(home, claudeHome);
  return { home, skills, skippedMcp: skipped, hooks };
}
