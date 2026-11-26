import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexHomeFor, renderAgentsMd, renderMcpConfigToml, renderConfigToml, trustedRoots,
  renderHooksJson, renderPluginManifest, renderMarketplace, discoverMcpServers, buildCodexHome,
} from "./codex-home.js";
import type { McpServer } from "./codex-home.js";
import type { AgentRecord } from "../store.js";

// ---------------------------------------------------------------------------
// A deliberately strict parser for the TOML subset this module emits: table
// headers, `key = value` lines, inline arrays and inline tables of basic
// strings. It throws on anything outside that subset — an illegal bare key, an
// unterminated or control-character-bearing basic string, a stray token — so
// asserting on its output proves the rendered config.toml actually parses,
// rather than merely that it contains some substring. That matters because the
// codex CLI appends its own [marketplaces]/[plugins] tables to this same file:
// one unparseable line we write takes the hook registration down with it.
// ---------------------------------------------------------------------------
type TomlTable = Record<string, any>;

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\",
};

function parseBasicString(s: string, start: number): { value: string; next: number } {
  if (s[start] !== '"') throw new Error(`expected a string at ${start} in ${JSON.stringify(s)}`);
  let i = start + 1;
  let out = "";
  for (;;) {
    if (i >= s.length) throw new Error(`unterminated basic string in ${JSON.stringify(s)}`);
    const c = s[i];
    if (c === '"') return { value: out, next: i + 1 };
    if (c === "\\") {
      const e = s[i + 1];
      if (e !== undefined && e in SIMPLE_ESCAPES) { out += SIMPLE_ESCAPES[e]; i += 2; continue; }
      if (e === "u" || e === "U") {
        const len = e === "u" ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) {
          throw new Error(`bad unicode escape in ${JSON.stringify(s)}`);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 2 + len;
        continue;
      }
      throw new Error(`bad escape \\${e} in ${JSON.stringify(s)}`);
    }
    const code = c.codePointAt(0)!;
    if (code <= 0x08 || (code >= 0x0a && code <= 0x1f) || code === 0x7f) {
      throw new Error(`raw control character U+${code.toString(16)} in a basic string`);
    }
    out += c;
    i++;
  }
}

const skipWs = (s: string, i: number): number => {
  while (s[i] === " " || s[i] === "\t") i++;
  return i;
};

// A key is one or more dot-separated segments, each a bare key or a quoted
// basic string. `a.b = 1` is two segments; `"a.b" = 1` is one.
function parseKey(s: string, start: number): { path: string[]; next: number } {
  const path: string[] = [];
  let i = start;
  for (;;) {
    i = skipWs(s, i);
    if (s[i] === '"') {
      const r = parseBasicString(s, i);
      path.push(r.value);
      i = r.next;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) throw new Error(`illegal bare key at ${i} in ${JSON.stringify(s)}`);
      path.push(m[0]);
      i += m[0].length;
    }
    i = skipWs(s, i);
    if (s[i] === ".") { i++; continue; }
    return { path, next: i };
  }
}

function parseValue(s: string, start: number): { value: any; next: number } {
  let i = skipWs(s, start);
  if (s[i] === '"') return parseBasicString(s, i);
  if (s.startsWith("true", i)) return { value: true, next: i + 4 };
  if (s.startsWith("false", i)) return { value: false, next: i + 5 };
  if (s[i] === "[") {
    const arr: any[] = [];
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === "]") return { value: arr, next: i + 1 };
      const r = parseValue(s, i);
      arr.push(r.value);
      i = skipWs(s, r.next);
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") return { value: arr, next: i + 1 };
      throw new Error(`bad array at ${i} in ${JSON.stringify(s)}`);
    }
  }
  if (s[i] === "{") {
    const obj: TomlTable = {};
    i++;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === "}") return { value: obj, next: i + 1 };
      const k = parseKey(s, i);
      if (s[k.next] !== "=") throw new Error(`missing '=' in inline table ${JSON.stringify(s)}`);
      const v = parseValue(s, k.next + 1);
      descend(obj, k.path.slice(0, -1))[k.path[k.path.length - 1]] = v.value;
      i = skipWs(s, v.next);
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") return { value: obj, next: i + 1 };
      throw new Error(`bad inline table at ${i} in ${JSON.stringify(s)}`);
    }
  }
  throw new Error(`unsupported value at ${i} in ${JSON.stringify(s)}`);
}

function descend(root: TomlTable, path: string[]): TomlTable {
  let t = root;
  for (const seg of path) {
    if (t[seg] === undefined) t[seg] = {};
    if (typeof t[seg] !== "object" || Array.isArray(t[seg])) {
      throw new Error(`key ${seg} is not a table`);
    }
    t = t[seg];
  }
  return t;
}

function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) throw new Error(`bad table header: ${line}`);
      const inner = line.slice(1, -1);
      const { path, next } = parseKey(inner, 0);
      if (inner.slice(next).trim() !== "") throw new Error(`bad table header: ${line}`);
      table = descend(root, path);
      continue;
    }
    const k = parseKey(line, 0);
    if (line[k.next] !== "=") throw new Error(`missing '=' in: ${line}`);
    const v = parseValue(line, k.next + 1);
    if (line.slice(v.next).trim() !== "") throw new Error(`trailing content in: ${line}`);
    descend(table, k.path.slice(0, -1))[k.path[k.path.length - 1]] = v.value;
  }
  return root;
}

describe("the test's own TOML parser", () => {
  it("reads tables, quoted keys, arrays and inline tables", () => {
    const t = parseToml('[a."b.c"]\nx = "1"\narr = ["p", "q"]\ninl = { k = "v" }\n');
    expect(t.a["b.c"]).toEqual({ x: "1", arr: ["p", "q"], inl: { k: "v" } });
  });
  it("rejects an illegal bare key, a raw control character and an unterminated string", () => {
    expect(() => parseToml("[mcp_servers.my server]")).toThrow();
    expect(() => parseToml('k = "a\u0007b"')).toThrow();
    expect(() => parseToml('k = "oops')).toThrow();
  });
});

const rec = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "id-1", label: "l", repo: "/r", worktree: "/w", branch: "b", baseBranch: "m",
  sessionId: null, hookToken: "tok", status: "idle", createdAt: 1, runtime: "codex", ...over,
});

describe("codexHomeFor", () => {
  it("puts a worktree agent's home inside the git-excluded .choibot dir", () => {
    expect(codexHomeFor(rec({ worktree: "/w" }), "/ws")).toBe("/w/.choibot/codex-home");
  });
  it("gives a workspace agent a private per-id home", () => {
    expect(codexHomeFor(rec({ repo: "", worktree: "/ws" }), "/ws"))
      .toBe("/ws/.choibot-agents/id-1/codex-home");
  });
});

describe("renderAgentsMd", () => {
  it("carries the claude instructions through verbatim", () => {
    expect(renderAgentsMd("# Rules\nBe brief.", null)).toContain("Be brief.");
  });
  it("appends the docs-sharing prompt when one is given", () => {
    const out = renderAgentsMd("# Rules", "SHARE DOCS HERE");
    expect(out).toContain("# Rules");
    expect(out).toContain("SHARE DOCS HERE");
    expect(out.indexOf("# Rules")).toBeLessThan(out.indexOf("SHARE DOCS HERE"));
  });
  it("still produces instructions when there is no CLAUDE.md", () => {
    expect(renderAgentsMd("", "DOCS")).toContain("DOCS");
  });
});

describe("renderHooksJson", () => {
  it("points every event at the token-gated console endpoint", () => {
    const o = JSON.parse(renderHooksJson({ agentId: "a1", token: "t9", port: 3100 }));
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "Notification"]) {
      const cmd = o.hooks[ev][0].hooks[0];
      expect(cmd.type).toBe("command");
      expect(cmd.command).toContain("http://127.0.0.1:3100/api/agents/a1/hook?token=t9");
      expect(cmd.command).toContain("--data-binary @-");
    }
  });
  it("never fails the agent when the console is unreachable", () => {
    const o = JSON.parse(renderHooksJson({ agentId: "a", token: "t", port: 1 }));
    expect(o.hooks.Stop[0].hooks[0].command).toMatch(/\|\| true$/);
  });
});

describe("renderPluginManifest", () => {
  it("declares the hooks file and a schema-valid interface block", () => {
    const m = JSON.parse(renderPluginManifest());
    expect(m.name).toBe("choibot-status");
    expect(m.hooks).toBe("./hooks.json");
    // The manifest is schema-validated on ingestion; an absent interface block
    // makes the plugin fail to install rather than install half-working.
    expect(m.interface.displayName).toBeTruthy();
    expect(m.interface.category).toBeTruthy();
    expect(Array.isArray(m.interface.capabilities)).toBe(true);
  });
});

describe("renderMarketplace", () => {
  it("points at the plugin by a root-relative local path", () => {
    const mp = JSON.parse(renderMarketplace());
    expect(mp.name).toBe("choibot-local");
    const entry = mp.plugins[0];
    expect(entry.name).toBe("choibot-status");
    expect(entry.source).toEqual({ source: "local", path: "./plugins/choibot-status" });
    expect(entry.policy.installation).toBe("INSTALLED_BY_DEFAULT");
    expect(entry.category).toBeTruthy();
  });
});

describe("renderMcpConfigToml", () => {
  it("emits a stdio mcp server with command and args", () => {
    const out = renderMcpConfigToml([{ name: "playwright", command: "npx", args: ["@playwright/mcp@latest"] }]);
    expect(out).toContain("[mcp_servers.playwright]");
    expect(out).toContain('command = "npx"');
    expect(out).toContain('args = ["@playwright/mcp@latest"]');
  });
  it("emits an http mcp server by url", () => {
    const out = renderMcpConfigToml([{ name: "remote", url: "https://mcp.example.com/mcp" }]);
    expect(out).toContain("[mcp_servers.remote]");
    expect(out).toContain('url = "https://mcp.example.com/mcp"');
  });
  it("escapes quotes and backslashes in emitted strings", () => {
    const out = renderMcpConfigToml([{ name: "odd", command: 'say "hi"\\now' }]);
    expect(out).toContain('command = "say \\"hi\\"\\\\now"');
  });
  it("is empty when there is nothing to emit", () => {
    expect(renderMcpConfigToml([]).trim()).toBe("");
  });

  // A dotted name under a bare key silently becomes a nested subtable, so the
  // server the user configured is not the server codex sees.
  it("keeps a dotted server name whole instead of nesting a subtable", () => {
    const t = parseToml(renderMcpConfigToml([{ name: "a.b", command: "npx" }]));
    expect(Object.keys(t.mcp_servers)).toEqual(["a.b"]);
    expect(t.mcp_servers["a.b"].command).toBe("npx");
  });

  // A space is illegal in a bare key: the whole file stops parsing, which takes
  // the CLI-appended [marketplaces]/[plugins] tables down with it.
  it("renders a parseable file for a server name containing a space", () => {
    const out = renderMcpConfigToml([{ name: "my server", command: "npx" }]);
    expect(() => parseToml(out)).not.toThrow();
    expect(parseToml(out).mcp_servers["my server"].command).toBe("npx");
  });

  it("keeps every server reachable when one name is odd", () => {
    const t = parseToml(renderMcpConfigToml([
      { name: "my server", command: "a" },
      { name: "plain", command: "b" },
    ]));
    expect(t.mcp_servers["my server"].command).toBe("a");
    expect(t.mcp_servers.plain.command).toBe("b");
  });

  // A raw newline terminates a TOML basic string; the rest of the file is
  // garbage from there on.
  it("escapes control characters so a newline or tab in a value stays parseable", () => {
    const out = renderMcpConfigToml([{
      name: "nl",
      command: "line1\nline2",
      args: ["a\tb", "c\rd"],
      env: { TEXT: "x\u0000y" },
    }]);
    expect(() => parseToml(out)).not.toThrow();
    const s = parseToml(out).mcp_servers.nl;
    expect(s.command).toBe("line1\nline2");
    expect(s.args).toEqual(["a\tb", "c\rd"]);
    expect(s.env.TEXT).toBe("x\u0000y");
  });

  it("renders non-string env values rather than throwing", () => {
    const server = { name: "s", command: "npx", env: { PORT: 8080, DEBUG: true } };
    const out = renderMcpConfigToml([server as unknown as McpServer]);
    expect(() => parseToml(out)).not.toThrow();
    expect(parseToml(out).mcp_servers.s.env).toEqual({ PORT: "8080", DEBUG: "true" });
  });

  it("renders non-string args elements rather than throwing", () => {
    const server = { name: "s", command: "npx", args: ["--port", 8080] };
    const out = renderMcpConfigToml([server as unknown as McpServer]);
    expect(() => parseToml(out)).not.toThrow();
    expect(parseToml(out).mcp_servers.s.args).toEqual(["--port", "8080"]);
  });

  it("keeps an env key whole when it is not a legal bare key", () => {
    const out = renderMcpConfigToml([{ name: "s", command: "npx", env: { "MY.KEY": "v" } }]);
    expect(parseToml(out).mcp_servers.s.env).toEqual({ "MY.KEY": "v" });
  });
});

// Codex parks on a TUI prompt for every one of these on a fresh CODEX_HOME, and
// the console builds a fresh one per agent — so an agent that is missing any of
// them never starts work at all. The key codex uses was read back off a real
// answered prompt: the MAIN repo root for a worktree, the directory itself when
// it is not in a git repo.
describe("trustedRoots", () => {
  it("trusts the repository root, which is what codex keys a worktree by", () => {
    expect(trustedRoots(rec({ repo: "/r", worktree: "/wt/a" }), "/ws")).toContain("/r");
  });
  it("also trusts the agent's own working directory", () => {
    expect(trustedRoots(rec({ repo: "/r", worktree: "/wt/a" }), "/ws")).toEqual(["/r", "/wt/a"]);
  });
  it("honours an explicit cwd over the worktree", () => {
    expect(trustedRoots(rec({ repo: "/r", worktree: "/wt/a", cwd: "/elsewhere" }), "/ws"))
      .toEqual(["/r", "/elsewhere"]);
  });
  // A workspace agent has no repo and no worktree of its own; it runs at the
  // workspace root, and needs that root trusted just as much.
  it("trusts the workspace root for a workspace agent", () => {
    expect(trustedRoots(rec({ repo: "", worktree: "/ws", cwd: "/ws" }), "/ws")).toEqual(["/ws"]);
  });
  it("falls back to the workspace dir when a workspace agent has no cwd", () => {
    expect(trustedRoots(rec({ repo: "", worktree: "" }), "/ws")).toEqual(["/ws"]);
  });
  // Two identical keys are two identical TOML tables, which is a redefinition
  // error: the file stops parsing and the CLI-appended plugin tables die with it.
  it("never emits the same root twice", () => {
    expect(trustedRoots(rec({ repo: "/r", worktree: "/r" }), "/ws")).toEqual(["/r"]);
  });
});

describe("renderConfigToml", () => {
  it("marks every root trusted so no agent stops at the trust prompt", () => {
    const t = parseToml(renderConfigToml({ mcp: [], trust: ["/home/dev/workspace/repo"] }));
    expect(t.projects["/home/dev/workspace/repo"]).toEqual({ trust_level: "trusted" });
  });

  // A fresh home has no version.json, so codex runs its startup update check and
  // blocks on an "Update available!" three-way choice before it even reaches the
  // trust prompt. Upgrading the CLI is not an agent's business.
  it("turns off the startup update check, as a top-level key before any table", () => {
    const src = renderConfigToml({ mcp: [{ name: "p", command: "npx" }], trust: ["/r"] });
    expect(parseToml(src).check_for_update_on_startup).toBe(false);
    // After a table header the key would be read as projects.check_… instead.
    expect(src.indexOf("check_for_update_on_startup")).toBeLessThan(src.indexOf("["));
  });

  it("still renders the mcp servers alongside the trust entries", () => {
    const t = parseToml(renderConfigToml({
      mcp: [{ name: "playwright", command: "npx", args: ["@playwright/mcp@latest"] },
            { name: "remote", url: "https://mcp.example.com/mcp" }],
      trust: ["/r", "/r/.agent-worktrees/a"],
    }));
    expect(t.mcp_servers.playwright).toEqual({ command: "npx", args: ["@playwright/mcp@latest"] });
    expect(t.mcp_servers.remote.url).toBe("https://mcp.example.com/mcp");
    expect(Object.keys(t.projects)).toEqual(["/r", "/r/.agent-worktrees/a"]);
  });

  // The path is interpolated straight into a table key, so it goes through the
  // same hardened quoting as everything else: a dot in a bare key would nest a
  // subtable (trusting the wrong thing), and a space or a quote would make the
  // whole file unparseable.
  it("quotes a path so dots never nest a subtable", () => {
    const t = parseToml(renderConfigToml({ mcp: [], trust: ["/home/u/my.repo"] }));
    expect(Object.keys(t.projects)).toEqual(["/home/u/my.repo"]);
  });
  it("renders a parseable file for a path with a space, a quote or a backslash", () => {
    const paths = ['/home/u/my repo', '/home/u/we"ird', "/home/u/back\\slash"];
    const src = renderConfigToml({ mcp: [{ name: "p", command: "npx" }], trust: paths });
    expect(() => parseToml(src)).not.toThrow();
    const t = parseToml(src);
    expect(Object.keys(t.projects)).toEqual(paths);
    expect(t.mcp_servers.p.command).toBe("npx");   // the rest of the file survives
  });
  it("renders a parseable file for a path carrying a control character", () => {
    const src = renderConfigToml({ mcp: [], trust: ["/home/u/nl\nrepo"] });
    expect(() => parseToml(src)).not.toThrow();
    expect(parseToml(src).projects["/home/u/nl\nrepo"].trust_level).toBe("trusted");
  });

  it("is parseable with nothing to trust and nothing to serve", () => {
    expect(() => parseToml(renderConfigToml({ mcp: [], trust: [] }))).not.toThrow();
  });
});

describe("discoverMcpServers", () => {
  it("takes stdio servers and reports header-only http ones as skipped", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-"));
    const inst = join(home, "plugins", "cache", "p1");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, ".mcp.json"), JSON.stringify({
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    }));
    const inst2 = join(home, "plugins", "cache", "p2");
    await mkdir(inst2, { recursive: true });
    await writeFile(join(inst2, ".mcp.json"), JSON.stringify({
      mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp", headers: { "x-k": "v" } } },
    }));
    await mkdir(join(home, "plugins"), { recursive: true });
    await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "p1@m": [{ installPath: inst }], "p2@m": [{ installPath: inst2 }] },
    }));

    const { usable, skipped } = await discoverMcpServers(home);
    expect(usable.map((s) => s.name)).toEqual(["playwright"]);
    expect(skipped).toEqual(["posthog"]);
    await rm(home, { recursive: true, force: true });
  });

  // JSON has no string requirement: a port in `env` or `args` is written as a
  // number often enough that it must not be able to fail a launch.
  it("coerces non-string env values and args from a plugin's .mcp.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-num-"));
    const inst = join(home, "plugins", "cache", "p1");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, ".mcp.json"), JSON.stringify({
      numeric: { command: "srv", args: ["--port", 8080], env: { PORT: 123, TAG: { a: 1 } } },
    }));
    await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "p1@m": [{ installPath: inst }] },
    }));

    const { usable } = await discoverMcpServers(home);
    expect(usable[0].args).toEqual(["--port", "8080"]);
    expect(usable[0].env).toEqual({ PORT: "123" });   // the structural value is dropped
    const t = parseToml(renderMcpConfigToml(usable));
    expect(t.mcp_servers.numeric.env).toEqual({ PORT: "123" });
    await rm(home, { recursive: true, force: true });
  });

  it("returns empty when nothing is configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-none-"));
    await expect(discoverMcpServers(home)).resolves.toEqual({ usable: [], skipped: [] });
    await rm(home, { recursive: true, force: true });
  });

  // ${CLAUDE_PLUGIN_ROOT} is a CLAUDE-side placeholder; codex expands nothing,
  // so left alone it reaches config.toml verbatim and the server never starts —
  // while still being reported as usable. This is the shape the telegram plugin
  // ships on this box.
  it("expands ${CLAUDE_PLUGIN_ROOT} to the plugin's install path", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-root-"));
    const inst = join(home, "plugins", "cache", "telegram");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, ".mcp.json"), JSON.stringify({
      mcpServers: {
        telegram: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/tg",
          args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--silent", "start"],
          env: { TG_HOME: "${CLAUDE_PLUGIN_ROOT}/state" },
        },
      },
    }));
    await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "telegram@m": [{ installPath: inst }] },
    }));

    const { usable, skipped } = await discoverMcpServers(home);
    expect(skipped).toEqual([]);
    expect(usable).toEqual([{
      name: "telegram",
      command: `${inst}/bin/tg`,
      args: ["run", "--cwd", inst, "--silent", "start"],
      env: { TG_HOME: `${inst}/state` },
    }]);
    // And it survives the render, which is what codex actually reads.
    const t = parseToml(renderMcpConfigToml(usable));
    expect(t.mcp_servers.telegram.args).toContain(inst);
    await rm(home, { recursive: true, force: true });
  });

  // Anything else of that shape is a value from Claude's own environment (a
  // token, typically). Emitting it verbatim yields a server that cannot start;
  // resolving it would copy the user's secret into config.toml. Skip instead.
  it("skips a server whose placeholder cannot be resolved rather than emitting it", async () => {
    const home = await mkdtemp(join(tmpdir(), "mcp-ph-"));
    const inst = join(home, "plugins", "cache", "p1");
    await mkdir(inst, { recursive: true });
    await writeFile(join(inst, ".mcp.json"), JSON.stringify({
      terraform: { command: "docker", args: ["run", "-e", "TFE_TOKEN=${TFE_TOKEN}", "img"] },
      hosted: { url: "https://${TENANT}.example.com/mcp" },
      fine: { command: "npx", args: ["ok"] },
    }));
    await writeFile(join(home, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "p1@m": [{ installPath: inst }] },
    }));

    const { usable, skipped } = await discoverMcpServers(home);
    expect(usable.map((s) => s.name)).toEqual(["fine"]);
    expect(skipped.sort()).toEqual(["hosted", "terraform"]);
    await rm(home, { recursive: true, force: true });
  });
});

describe("buildCodexHome", () => {
  it("makes generated homes and secret-bearing files private", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-private-"));
    const claudeHome = join(base, "claude");
    const wt = join(base, "wt");
    await mkdir(claudeHome, { recursive: true });
    await mkdir(join(wt, ".choibot", "codex-home"), { recursive: true });
    await chmod(join(wt, ".choibot", "codex-home"), 0o755);
    const out = await buildCodexHome(rec({ worktree: wt }), {
      port: 3100, workspaceDir: base, claudeHome,
    });
    const hooks = join(out.home, "mp", "plugins", "choibot-status", "hooks.json");
    expect((await stat(out.home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(out.home, "config.toml"))).mode & 0o777).toBe(0o600);
    expect((await stat(hooks)).mode & 0o777).toBe(0o600);
    await rm(base, { recursive: true, force: true });
  });

  it("writes the plugin, marketplace, AGENTS.md and the skills farm", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-"));
    const claudeHome = join(base, "claude");
    await mkdir(join(claudeHome, "skills", "s1"), { recursive: true });
    await writeFile(join(claudeHome, "skills", "s1", "SKILL.md"), "---\nname: s1\n---\n");
    await writeFile(join(claudeHome, "CLAUDE.md"), "# Global rules");

    const wt = join(base, "wt");
    await mkdir(wt, { recursive: true });
    const out = await buildCodexHome(rec({ worktree: wt }), {
      port: 3100, workspaceDir: base, claudeHome,
    });

    expect(out.home).toBe(join(wt, ".choibot", "codex-home"));
    expect(out.skills).toBe(1);
    const plug = join(out.home, "mp", "plugins", "choibot-status");
    expect(await readFile(join(plug, "hooks.json"), "utf8")).toContain("id-1/hook?token=tok");
    expect(await readFile(join(plug, ".codex-plugin", "plugin.json"), "utf8")).toContain('"./hooks.json"');
    expect(await readFile(join(out.home, "mp", ".agents", "plugins", "marketplace.json"), "utf8"))
      .toContain("choibot-status");
    expect(await readFile(join(out.home, "AGENTS.md"), "utf8")).toContain("# Global rules");
    await rm(base, { recursive: true, force: true });
  });

  // The console writes config.toml and the codex CLI then APPENDS its
  // [marketplaces]/[plugins] tables to the same file, so the trust entry has to
  // be in the console's own write — and still be there after registration.
  it("writes the repo's trust entry into the config.toml codex will read", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-trust-"));
    const claudeHome = join(base, "claude");
    await mkdir(claudeHome, { recursive: true });
    const repo = join(base, "repo");
    const wt = join(base, "wt");
    await mkdir(wt, { recursive: true });
    const out = await buildCodexHome(rec({ repo, worktree: wt, cwd: wt }), {
      port: 3100, workspaceDir: base, claudeHome,
    });
    const t = parseToml(await readFile(join(out.home, "config.toml"), "utf8"));
    expect(t.projects[repo]).toEqual({ trust_level: "trusted" });
    expect(t.projects[wt]).toEqual({ trust_level: "trusted" });
    expect(t.check_for_update_on_startup).toBe(false);
    await rm(base, { recursive: true, force: true });
  });

  it("trusts the workspace root for a workspace agent, which has no repo", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-trust-ws-"));
    const claudeHome = join(base, "claude");
    await mkdir(claudeHome, { recursive: true });
    const out = await buildCodexHome(rec({ repo: "", worktree: base, cwd: base }), {
      port: 3100, workspaceDir: base, claudeHome,
    });
    const t = parseToml(await readFile(join(out.home, "config.toml"), "utf8"));
    expect(Object.keys(t.projects)).toEqual([base]);
    await rm(base, { recursive: true, force: true });
  });

  it("is idempotent — a rebuild over an existing home still yields a registered plugin", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-again-"));
    const claudeHome = join(base, "claude");
    await mkdir(claudeHome, { recursive: true });
    const wt = join(base, "wt");
    await mkdir(wt, { recursive: true });
    const ctx = { port: 3100, workspaceDir: base, claudeHome };
    const first = await buildCodexHome(rec({ worktree: wt }), ctx);
    const second = await buildCodexHome(rec({ worktree: wt }), ctx);
    expect(second.home).toBe(first.home);
    expect(second.hooks).toBe(first.hooks);
    await rm(base, { recursive: true, force: true });
  });

  it("writes whatever system prompt the caller supplies into AGENTS.md", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-sp-"));
    const claudeHome = join(base, "claude");
    await mkdir(claudeHome, { recursive: true });
    const wt = join(base, "wt"); await mkdir(wt, { recursive: true });
    const out = await buildCodexHome(rec({ worktree: wt }), {
      port: 3100, workspaceDir: base, claudeHome, systemPrompt: "YOU ARE THE CRON MASTER",
    });
    expect(await readFile(join(out.home, "AGENTS.md"), "utf8")).toContain("YOU ARE THE CRON MASTER");
    await rm(base, { recursive: true, force: true });
  });

  it("omits the prompt section when the caller supplies none", async () => {
    const base = await mkdtemp(join(tmpdir(), "build-ws-"));
    const claudeHome = join(base, "claude");
    await mkdir(claudeHome, { recursive: true });
    const out = await buildCodexHome(rec({ repo: "", worktree: base }), {
      port: 3100, workspaceDir: base, claudeHome,
    });
    const agents = await readFile(join(out.home, "AGENTS.md"), "utf8");
    expect(agents).not.toContain("Console docs sharing");
    await rm(base, { recursive: true, force: true });
  });
});
