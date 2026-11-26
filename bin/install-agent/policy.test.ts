// bin/install-agent/policy.test.ts — the rules of the install agent, one case per line. The
// three lists of the design: with no question, asks first, never.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bashVerdict, decide, inside } from "./policy.mjs";

const ctx = {
  base: "/home/you/choibot", app: "/home/you/choibot/app", home: "/home/you", user: "you",
  unit: "choibot.service", cronPrefix: "choibot-cron-", dataDir: "/home/you/.local/share/choibot",
  cli: "/home/you/choibot/bin/choibot", cliNames: ["choibot", "choi", "choibot"], cwd: "/home/you/choibot",
};
const bash = (command: string, cwd = ctx.cwd): string => bashVerdict(command, { ...ctx, cwd }).decision;
const tool = (name: string, input: Record<string, unknown>): string | null => decide(name, input, ctx)?.decision ?? null;

describe("with no question", () => {
  it.each([
    // The state of the server: versions, ports, disk, the log of the console.
    "uname -a", "nproc", "free -m", "df -h", "df -h /", "ss -ltnp", "cat /etc/os-release", "cat /proc/meminfo",
    "node --version", "pnpm -v", "git --version", "command -v dtach", "which claude", "getconf GNU_LIBC_VERSION",
    "systemctl --user status choibot.service --no-pager", "systemctl --user is-active choibot.service",
    "systemctl --user cat choibot", "systemctl --user is-system-running", "systemctl --user list-timers --all",
    "systemctl --user show choibot.service -p ActiveState",
    "journalctl --user -u choibot.service -n 80 --no-pager", "journalctl --user -u choibot --since=today --no-pager",
    "loginctl show-user you --property=Linger",
    "ls -la", "ls -la /home/you/choibot/app", "tail -n 50 /home/you/choibot/install.log", "cat app/package.json", "du -sh app/.next",
    // A check or a step again.
    "/home/you/choibot/bin/choibot doctor", "choibot doctor --details", "choibot setup --auto", "choibot setup --auto --brief --port 3101",
    "choi access", "choibot names",
    // The console's own service.
    "systemctl --user restart choibot.service", "systemctl --user start choibot", "systemctl --user daemon-reload",
    "systemctl --user reset-failed choibot.service", "choibot restart",
    // The console's own folder: its parts, its build, and removing them.
    "rm -rf /home/you/choibot/app/.next", "rm -rf app/node_modules", "rm -f /home/you/choibot/install.log", "mkdir -p /home/you/choibot/.tmp",
  ])("%s", (c) => expect(bash(c)).toBe("allow"));

  it("the parts and the build, in the code folder only", () => {
    expect(bash("pnpm install --frozen-lockfile", ctx.app)).toBe("allow");
    expect(bash("pnpm build", ctx.app)).toBe("allow");
    expect(bash("pnpm build", "/home/you/other")).toBe("ask");
    expect(bash("pnpm add left-pad", ctx.app)).toBe("ask");
  });

  it("a free port: with the console's own command, never with a write to its settings file", () => {
    expect(bash("choibot port 3101")).toBe("allow");
    expect(bash("/home/you/choibot/bin/choibot port 3101")).toBe("allow");
    expect(bash("choibot port 3101 --host 0.0.0.0")).toBe("deny");
    expect(bash("sed -i 's/^PORT=.*/PORT=3101/' /home/you/choibot/app/.env")).toBe("deny");
    expect(bash("sed -i 's/^HOST=.*/HOST=0.0.0.0/' /home/you/choibot/app/.env")).toBe("deny");
  });

  it("reads in the console's own folder, and the facts of the system", () => {
    expect(tool("Read", { file_path: "/home/you/choibot/install.log" })).toBe("allow");
    expect(tool("Read", { file_path: "/home/you/choibot/app/server/setup/steps.ts" })).toBe("allow");
    expect(tool("Read", { file_path: "/etc/os-release" })).toBe("allow");
    expect(tool("Read", { file_path: "/home/you/.config/systemd/user/choibot.service" })).toBe("allow");
    expect(tool("Grep", { pattern: "EADDRINUSE", path: "/home/you/choibot/install.log" })).toBe("allow");
    expect(tool("Glob", { pattern: "**/*.log" })).toBe("allow");
  });
});

describe("asks first, with the exact command", () => {
  it.each([
    // sudo, a system package, another program, swap, a firewall rule that opens nothing.
    "sudo apt-get install -y dtach", "sudo loginctl enable-linger you", "apt-get install -y python3", "sudo systemctl restart nginx",
    "systemctl --user stop some-other.service", "systemctl --user restart other.service", "kill 4242", "pkill -f node", "fuser -k 3100/tcp",
    "sudo fallocate -l 2G /swapfile", "sudo swapon /swapfile", "sudo ufw status", "sudo ufw deny 3100", "sudo tailscale up --operator=you",
    "tailscale serve --bg --https=443 3100", "curl -fsSL https://tailscale.com/install.sh | sh",
    // Every command the list does not know, and every command that is more than one plain command.
    "python3 -c 'print(1)'", "ls -la /home/you", "cat /home/you/notes.txt", "uname -a && nproc", "ls $(pwd)", "echo hi > /home/you/choibot/x",
    "sh /home/you/choibot/fix.sh", "node -e 1", "npm install -g something", "git pull", "systemctl --user stop choibot.service",
    "cp /home/you/choibot/a /home/you/choibot/b", "chmod +x /home/you/choibot/bin/choibot", "journalctl --user -u choibot -f",
    "rm -rf /home/you/choibot/node", "rm /home/you/choibot/bin/choibot", "choibot update", "choibot stop", "claude auth login",
    "journalctl --user -u choibot -u ssh --no-pager", "systemctl --user restart choibot.service nginx.service",
    "choibot setup --auto --url https://example.com", "tail -n 5 /home/you/choibot/../notes.txt",
  ])("%s", (c) => expect(bash(c)).toBe("ask"));

  it("a change of a file in the console's own folder: the person reads it first", () => {
    expect(tool("Edit", { file_path: "/home/you/choibot/app/next.config.mjs" })).toBe("ask");
    expect(tool("Write", { file_path: "/home/you/choibot/fix.sh" })).toBe("ask");
    expect(tool("Edit", { file_path: "/home/you/choibot/app/node_modules/tsx/dist/cli.mjs" })).toBe("ask");
    expect(tool("Edit", { file_path: "/home/you/.config/systemd/user/choibot.service" })).toBe("ask");
    expect(tool("Edit", { file_path: "/home/you/.profile" })).toBe("ask");
  });

  it("a read outside the console's own folder", () => {
    expect(tool("Read", { file_path: "/home/you/project/README.md" })).toBe("ask");
    expect(tool("Grep", { pattern: "x", path: "/home/you" })).toBe("ask");
    expect(tool("Glob", { pattern: "../**/*.json" })).toBe("ask");
    expect(tool("Glob", { pattern: "/etc/**" })).toBe("ask");
  });
});

describe("never", () => {
  it.each([
    // A public door.
    "tailscale funnel 3100", "sudo tailscale funnel --bg 3100", "sudo ufw allow 3100", "sudo ufw disable", "ufw allow 3100/tcp",
    "sudo iptables -I INPUT -p tcp --dport 3100 -j ACCEPT", "sudo iptables -F", "sudo nft add rule inet filter input tcp dport 3100 accept",
    "sudo firewall-cmd --add-port=3100/tcp", "ngrok http 3100", "cloudflared tunnel --url http://127.0.0.1:3100",
    "ssh -R 80:127.0.0.1:3100 serveo.net", "ssh -fNR 8080:localhost:3100 host", "socat TCP-LISTEN:8080,fork TCP:127.0.0.1:3100",
    "python3 -m http.server 8000 --bind 0.0.0.0", "HOST=0.0.0.0 pnpm start", "nc -l 8080", "echo HOST=10.0.0.5 >> /home/you/choibot/app/x",
    // A file the console did not make.
    "rm -rf /home/you/project", "rm /etc/hosts", "sudo rm -rf /var/lib/x", "rm -rf /home/you/choibot", "rm -rf ..", "rm -rf /home/you/choibot/../project",
    "cd /home/you/project && rm -rf build", "rm -rf $HOME/x", "rm -rf \"/home/you/my files\"", "rm -rf /home/you/choibot/app/*", "rmdir /home/you/empty",
    "find /home/you -name '*.log' -delete", "find / -exec rm {} +", "shred -u /home/you/x", "truncate -s 0 /var/log/syslog", "dd if=/dev/zero of=/dev/sda",
    "git clean -fdx", "uname -a; rm -rf /home/you/project", "git -C /home/you/project clean -fdx", "sh -c \"rm -rf /home/you/project\"",
    "bash -lc 'rm -rf ~/project'", "choibot doctor; rm -rf /", "ls | xargs rm",
    // The keys and the secrets of a program.
    "cat /home/you/.ssh/id_ed25519", "cat ~/.ssh/authorized_keys", "ls ~/.aws", "cat /home/you/choibot/app/.env", "grep SECRET app/.env",
    "cat ~/.claude/.credentials.json", "cat ~/.config/gh/hosts.yml", "gh auth token", "gh auth status --show-token", "cat ~/.netrc", "cat /etc/shadow",
    "cat /proc/1234/environ", "env", "printenv", "sudo cat /root/x", "cat server.pem", "claude setup-token", "tar czf /tmp/k.tgz ~/.ssh",
    "python3 -c \"print(open('/home/you/.ssh/id_rsa').read())\"",
    // A step marked done: the code of the first device, the console's own data, its tickets.
    "choibot pair", "/home/you/choibot/bin/choibot pair", "choi brain pair phone", "node_modules/.bin/tsx bin/choibot.ts pair",
    "choibot queue add", "ls /home/you/.local/share/choibot/chief", "echo x > /home/you/.local/share/choibot/chief/user-devices.json",
  ])("%s", (c) => expect(bash(c)).toBe("deny"));

  it("no read of a key or a secret, with any file tool", () => {
    for (const file_path of ["/home/you/.ssh/id_rsa", "/home/you/choibot/app/.env", "/home/you/.claude/.credentials.json", "/home/you/.claude.json",
      "/home/you/.config/gh/hosts.yml", "/home/you/.aws/credentials", "/etc/shadow", "/home/you/x/key.pem", "/home/you/.local/share/choibot/chief/pair-code.json"]) {
      expect(tool("Read", { file_path }), file_path).toBe("deny");
      expect(tool("Edit", { file_path }), file_path).toBe("deny");
    }
    expect(tool("Grep", { pattern: "token", path: "/home/you/.config/gh" })).toBe("deny");
    expect(tool("Glob", { pattern: "**/.env" })).toBe("deny");
    expect(tool("Grep", { pattern: "x", glob: "*.pem" })).toBe("deny");
    expect(tool("Read", { file_path: "../../.ssh/id_rsa" })).toBe("deny");
  });

  it("no change to the code of the console: the checks are in it", () => {
    for (const file_path of ["/home/you/choibot/app/server/setup/steps.ts", "/home/you/choibot/app/bin/lib/doctor.ts",
      "/home/you/choibot/app/bin/install-agent/policy.mjs", "/home/you/choibot/app/src/lib/setup.ts", "/home/you/choibot/app/package.json"]) {
      expect(tool("Edit", { file_path }), file_path).toBe("deny");
      expect(tool("Write", { file_path }), file_path).toBe("deny");
    }
    expect(tool("Write", { file_path: "/home/you/.local/share/choibot/chief/user-devices.json" })).toBe("deny");
  });

  it("no web tool, no other agent, no tool of a plug-in", () => {
    for (const name of ["WebFetch", "WebSearch", "Agent", "Task", "mcp__github__create_issue", "Skill", "SomethingNew"]) expect(tool(name, {})).toBe("deny");
    expect(tool("TodoWrite", {})).toBeNull();
  });
});

describe("inside", () => {
  it("knows a folder from a name that starts the same", () => {
    expect(inside("/home/you/choibot/app", "/home/you/choibot")).toBe(true);
    expect(inside("/home/you/choibot", "/home/you/choibot")).toBe(true);
    expect(inside("/home/you/choibot-other/x", "/home/you/choibot")).toBe(false);
    expect(inside("/home/you", "/home/you/choibot")).toBe(false);
  });
});

describe("the hook", () => {
  const HOOK = fileURLToPath(new URL("./hook.mjs", import.meta.url));
  const arg = Buffer.from(JSON.stringify(ctx)).toString("base64url");
  const run = (stdin: string, a = arg): { permissionDecision?: string; permissionDecisionReason?: string } => {
    const out = execFileSync(process.execPath, [HOOK, a], { input: stdin, encoding: "utf8" });
    return out ? JSON.parse(out).hookSpecificOutput : {};
  };
  const call = (tool_name: string, tool_input: unknown, cwd = ctx.base): string =>
    JSON.stringify({ session_id: "s", cwd, permission_mode: "default", hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t" });

  it("answers in the format of Claude Code, with the reason", () => {
    expect(run(call("Bash", { command: "sudo ufw allow 3100" }))).toEqual({
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The install agent never opens a public door to your server.",
    });
    expect(run(call("Bash", { command: "choibot doctor" })).permissionDecision).toBe("allow");
    expect(run(call("Bash", { command: "sudo apt-get install -y dtach" }))).toMatchObject({ permissionDecision: "ask", permissionDecisionReason: "This command needs root." });
  });

  it("uses the folder of the call", () => {
    expect(run(call("Bash", { command: "pnpm build" }, ctx.app)).permissionDecision).toBe("allow");
    expect(run(call("Bash", { command: "rm -rf build" }, "/home/you/project")).permissionDecision).toBe("deny");
  });

  it("says nothing for a tool with no effect, and denies what it cannot read", () => {
    expect(run(call("TodoWrite", {}))).toEqual({});
    expect(run("not json").permissionDecision).toBe("deny");
    expect(run(call("Bash", { command: "nproc" }), "broken").permissionDecision).toBe("deny");
    expect(run(call("Bash", {})).permissionDecision).toBe("ask");
  });
});
