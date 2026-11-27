// Note: these tests spawn real `bash -lc` PTYs via node-pty (a native addon).
// If node-pty fails to load under vitest's default worker pool, run with:
//   pnpm exec vitest run --pool=forks server/agents/terminal.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TerminalManager, PASTE_READY_BOUND_MS, SUDO_ENV_KEEP, agentSessionName, dtachClientPids, helperAgentEnv, helperArgv,
  helperEnv, helperSpawnCommand, liveConsoleDtach, persistCommand, pkillPattern, probeAgentExec, probedAgentExec,
  scrollbackDirFor, sessionTreePids,
} from "./terminal.js";
import type { AgentExec, Attachment } from "./terminal.js";
import { resumeAgent, switchAccount, type RecoveryCtx } from "./recovery.js";
import type { AgentRecord } from "./store.js";
import { ChiefWait } from "../chief/chiefwait.js";

import * as pty from "node-pty";

// Poll an async producer until it yields a non-null value (or time out). Used
// for reattach, which has to shell out (dtach socket check).
async function waitValue<T>(produce: () => Promise<T | null>, ms = 6000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await produce();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

// A wait for a real child process (node in a pty) when the whole set runs and the machine is busy.
const SLOW = 15_000;

function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error("timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("TerminalManager", () => {
  it("spawns a PTY, buffers output, and replays it on attach", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "a1", cwd: process.cwd(), command: "bash", args: ["-lc", "echo HELLO_PTY; sleep 0.2"] });
    await waitFor(() => (mgr.attach("a1")?.snapshot ?? "").includes("HELLO_PTY"));
    expect(mgr.attach("a1")!.snapshot).toContain("HELLO_PTY");
  });

  it("resumes from an offset in the same epoch and replays in full otherwise", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "resume1", cwd: process.cwd(), command: "bash", args: ["-lc", "echo FIRST_PART; sleep 0.5; echo SECOND_PART; sleep 0.2"] });
    await waitFor(() => (mgr.attach("resume1")?.snapshot ?? "").includes("FIRST_PART"));
    const first = mgr.attach("resume1")!;
    expect(first.resumed).toBe(false);
    expect(first.offset).toBe(0);
    const point = { epoch: first.epoch, offset: first.offset + first.snapshot.length };
    await waitFor(() => (mgr.attach("resume1")?.snapshot ?? "").includes("SECOND_PART"));
    const delta = mgr.attach("resume1", point)!;
    expect(delta.resumed).toBe(true);
    expect(delta.offset).toBe(point.offset);
    expect(delta.snapshot).toContain("SECOND_PART");
    expect(delta.snapshot).not.toContain("FIRST_PART");
    const other = mgr.attach("resume1", { epoch: "another-epoch", offset: point.offset })!;
    expect(other.resumed).toBe(false);
    expect(other.snapshot).toContain("FIRST_PART");
  });

  it("a fresh spawn takes input only once its TUI turns on bracketed paste", async () => {
    const mgr = new TerminalManager();
    // The marker is split over two writes, as a PTY may deliver it.
    mgr.spawn({ id: "paste1", cwd: process.cwd(), command: "bash", args: ["-lc", "echo BOOTING; sleep 0.3; printf '\\033[?20'; sleep 0.2; printf '04hREADY'; sleep 0.5"] });
    await waitFor(() => (mgr.attach("paste1")?.snapshot ?? "").includes("BOOTING"));
    expect(mgr.inputReady("paste1")).toBe(false);
    await waitFor(() => (mgr.attach("paste1")?.snapshot ?? "").includes("READY"));
    expect(mgr.inputReady("paste1")).toBe(true);
    expect(mgr.inputReady("nope")).toBe(false);
  });

  it("a spawn that never turns on bracketed paste is ready after the bound", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "paste2", cwd: process.cwd(), command: "bash", args: ["-lc", "sleep 0.5"] });
    expect(mgr.inputReady("paste2")).toBe(false);
    expect(mgr.inputReady("paste2", Date.now() + PASTE_READY_BOUND_MS)).toBe(true);
  });

  it("tells attached clients when the terminal ends", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "ends1", cwd: process.cwd(), command: "bash", args: ["-lc", "sleep 0.1"] });
    let ended = 0;
    mgr.attach("ends1")!.onEnd(() => { ended++; });
    await waitFor(() => ended === 1);
  });

  it("strips inherited tmux context so agents don't route copy to a phantom tmux", async () => {
    // Simulate the server being launched from inside tmux.
    const prev = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, TERM_PROGRAM: process.env.TERM_PROGRAM };
    process.env.TMUX = "/tmp/tmux-1000/choibot,118466,0";
    process.env.TMUX_PANE = "%0";
    process.env.TERM_PROGRAM = "tmux";
    try {
      const mgr = new TerminalManager();
      mgr.spawn({ id: "tmuxenv", cwd: process.cwd(), command: "bash", args: ["-lc", "echo TMUX=[$TMUX] PANE=[$TMUX_PANE] PROG=[$TERM_PROGRAM]; sleep 0.2"] });
      await waitFor(() => (mgr.attach("tmuxenv")?.snapshot ?? "").includes("TMUX=["));
      const snap = mgr.attach("tmuxenv")!.snapshot;
      expect(snap).toContain("TMUX=[]");        // stripped
      expect(snap).toContain("PANE=[]");        // stripped
      expect(snap).toContain("PROG=[]");        // stripped (was "tmux")
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  it("streams live output to a subscriber", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "a2", cwd: process.cwd(), command: "bash", args: ["-lc", "sleep 0.1; echo LIVE_OUT; sleep 0.2"] });
    let seen = "";
    const att = mgr.attach("a2")!;
    att.subscribe((c) => { seen += c; });
    await waitFor(() => seen.includes("LIVE_OUT"));
    expect(seen).toContain("LIVE_OUT");
  });

  it("calls onExit and forgets the terminal when the child exits", async () => {
    let exited: { id: string; code: number } | null = null;
    const mgr = new TerminalManager({ onExit: (id, code) => { exited = { id, code }; } });
    mgr.spawn({ id: "a3", cwd: process.cwd(), command: "bash", args: ["-lc", "exit 0"] });
    await waitFor(() => exited !== null);
    expect(exited!.id).toBe("a3");
    expect(mgr.has("a3")).toBe(false);
  });

  it("kill terminates a running terminal", async () => {
    const mgr = new TerminalManager();
    mgr.spawn({ id: "a4", cwd: process.cwd(), command: "bash", args: ["-lc", "sleep 5"] });
    await waitFor(() => mgr.has("a4"));
    mgr.kill("a4");
    await waitFor(() => !mgr.has("a4"));
    expect(mgr.has("a4")).toBe(false);
  });

  it("reports killed=true when stopped intentionally, killed=false on natural exit", async () => {
    let exited: { id: string; code: number; killed: boolean } | null = null;
    const mgr = new TerminalManager({ onExit: (id, code, killed) => { exited = { id, code, killed }; } });

    // Intentional kill of a long-running PTY → killed === true.
    mgr.spawn({ id: "a5", cwd: process.cwd(), command: "bash", args: ["-lc", "sleep 5"] });
    await waitFor(() => mgr.has("a5"));
    mgr.kill("a5");
    await waitFor(() => exited !== null);
    expect(exited!.id).toBe("a5");
    expect(exited!.killed).toBe(true);

    // Natural exit → killed === false.
    exited = null;
    mgr.spawn({ id: "a6", cwd: process.cwd(), command: "bash", args: ["-lc", "exit 0"] });
    await waitFor(() => exited !== null);
    expect(exited!.id).toBe("a6");
    expect(exited!.killed).toBe(false);
  });
});

describe("persistCommand", () => {
  const deps = { dtach: "/bin/dtach", systemdRun: "/usr/bin/systemd-run" };

  it("scope-wraps the dtach master so it escapes the service cgroup", () => {
    const { command, args } = persistCommand(deps, "/tmp/s.sock", "claude", ["--flag", "a prompt"]);
    expect(command).toBe("/usr/bin/systemd-run");
    // transient user scope, GC'd on exit, then dtach's argv verbatim
    expect(args.slice(0, 5)).toEqual(["--user", "--scope", "--quiet", "--collect", "--"]);
    expect(args.slice(5)).toEqual(["/bin/dtach", "-A", "/tmp/s.sock", "-E", "-z", "-r", "winch", "claude", "--flag", "a prompt"]);
  });

  it("falls back to bare dtach when no scope runner is available", () => {
    const { command, args } = persistCommand({ ...deps, systemdRun: null }, "/tmp/s.sock", "cat", []);
    expect(command).toBe("/bin/dtach");
    expect(args).toEqual(["-A", "/tmp/s.sock", "-E", "-z", "-r", "winch", "cat"]);
  });
});

describe("dtachClientPids", () => {
  // A fake /proc: pid dirs with an argv (NUL-separated) and a stdin link.
  function fakeProc(procs: Record<string, { argv: string[]; stdin: string }>): string {
    const root = mkdtempSync(join(tmpdir(), "choibot-fakeproc-"));
    for (const [pid, p] of Object.entries(procs)) {
      mkdirSync(join(root, pid, "fd"), { recursive: true });
      writeFileSync(join(root, pid, "cmdline"), p.argv.join("\0") + "\0");
      symlinkSync(p.stdin, join(root, pid, "fd", "0"));
    }
    return root;
  }

  it("finds the clients on a socket and never the master, which daemonizes onto /dev/null", () => {
    const sock = "/tmp/d/choibot-x.sock";
    const root = fakeProc({
      "100": { argv: ["/bin/dtach", "-A", sock, "-E", "claude"], stdin: "/dev/pts/5" }, // first client
      "101": { argv: ["/bin/dtach", "-A", sock, "-E", "claude"], stdin: "/dev/null" }, // master
      "102": { argv: ["/bin/dtach", "-a", sock, "-E"], stdin: "/dev/pts/9" }, // reattach client
      "103": { argv: ["/bin/dtach", "-a", "/tmp/d/choibot-other.sock"], stdin: "/dev/pts/7" }, // other agent
      "104": { argv: ["grep", sock], stdin: "/dev/pts/3" }, // not dtach
    });
    expect(dtachClientPids(sock, root).sort()).toEqual([100, 102]);
  });

  it("returns nothing when /proc is unreadable", () => {
    expect(dtachClientPids("/tmp/x.sock", "/nonexistent-proc")).toEqual([]);
  });
});

describe("TerminalManager persistence (dtach)", () => {
  it("derives a session-safe name (no ':' or '.')", () => {
    const name = agentSessionName("11.22:33-44ff");
    expect(name).not.toMatch(/[.:]/);
    expect(name).toContain("44ff"); // still traceable to the id
  });

  it("hosts a persisted spawn under dtach (socket appears)", async () => {
    const id = `dtach-${Date.now()}`;
    const mgr = new TerminalManager();
    mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => mgr.hasSession(id).then((ok) => (ok ? true : null)));
    // the host is dtach, not tmux — a dtach socket is present for this agent
    const dir = process.env.AGENT_DTACH_DIR ?? join(tmpdir(), "choibot-dtach");
    expect(existsSync(join(dir, `${agentSessionName(id)}.sock`))).toBe(true);
    mgr.kill(id);
  });

  it("a direct spawn runs its own command: the launcher for the helper route is ignored", async () => {
    const id = `direct-launch-${Date.now()}`;
    const mgr = new TerminalManager();
    mgr.spawn({
      id, cwd: process.cwd(), command: "bash", args: ["-lc", "printf 'DIRECT_RUN\\n'; sleep 30"], persist: true,
      helperLaunch: { command: "bash", args: ["-lc", "printf 'HELPER_RUN\\n'; sleep 30"] },
    });
    await waitFor(() => (mgr.attach(id)?.snapshot ?? "").includes("DIRECT_RUN"), SLOW);
    expect(mgr.attach(id)!.snapshot).not.toContain("HELPER_RUN");
    mgr.kill(id);
  }, 30_000);

  it("a fresh manager reattaches to a persisted session it never spawned, and can drive it", async () => {
    const id = `persist-${Date.now()}-a`;
    // Manager #1 spawns the session (cat echoes stdin and stays alive).
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));

    // Manager #2 = the "restarted server": empty in-memory state, same socket.
    const b = new TerminalManager();
    const att: Attachment = await waitValue(() => b.reattach(id));
    let seen = "";
    att.subscribe((c) => { seen += c; });
    b.write(id, "PING_REATTACH\n");
    await waitFor(() => seen.includes("PING_REATTACH"));
    expect(seen).toContain("PING_REATTACH");

    b.kill(id); // ends the dtach session (and thus a's lingering client)
    await waitFor(() => false, 200).catch(() => {});
  });

  it("a reattach gives the observer the session's history, so an idle agent's screen is there at once", async () => {
    const id = `observer-history-${Date.now()}`;
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-lc", "printf 'OBSERVER_HISTORY_MARK\\n> '; sleep 30"], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
    await waitFor(() => (a.attach(id)?.snapshot ?? "").includes("OBSERVER_HISTORY_MARK"));

    // The restarted server, with the prompt watcher on its observer hook.
    const { PromptWatcher } = await import("./prompt-watch.js");
    const watcher = new PromptWatcher({ emit: () => {} });
    const b = new TerminalManager({ observer: watcher });
    await waitValue(() => b.reattach(id));
    expect(watcher.has(id)).toBe(true);
    const screen = await watcher.screen(id);
    expect(screen?.lines.join("\n")).toContain("OBSERVER_HISTORY_MARK");

    b.kill(id);
    await waitFor(() => !watcher.has(id));
    watcher.dispose();
  });

  it("replays an IDLE agent's history on reattach after a 'restart', without dtach's clear wiping it", async () => {
    const id = `idle-history-${Date.now()}`;
    // Manager #1 = the original server: print some history, then sit idle
    // (no further output — exactly the case dtach's winch redraw can't restore).
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-lc", "printf 'IDLE_HISTORY_MARK\\n> '; sleep 30"], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
    // Let the history land in the on-disk transcript before "restarting".
    await waitFor(() => (a.attach(id)?.snapshot ?? "").includes("IDLE_HISTORY_MARK"));

    // Manager #2 = the restarted server: empty memory, same dtach socket + transcript.
    const b = new TerminalManager();
    const att: Attachment = await waitValue(() => b.reattach(id));
    // The replayed snapshot carries the idle agent's history…
    expect(att.snapshot).toContain("IDLE_HISTORY_MARK");
    // …and dtach's attach-time screen-clear is stripped from the live stream, so
    // it can't blank the history we just replayed.
    let live = "";
    att.subscribe((c) => { live += c; });
    await waitFor(() => false, 400).catch(() => {});
    expect(live).not.toContain("[H[J");

    b.kill(id);
    await waitFor(() => false, 200).catch(() => {});
  });

  // Claude draws again only on a real size change (claude 2.1.332): dtach's own attach redraw is a
  // SIGWINCH at the same size. This program does the same (node's "resize" event).
  const SIZE_PRINTER = [
    "-e",
    "process.stdout.write('RESIZE_READY\\n');" +
      "process.stdout.on('resize', () => process.stdout.write('SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'));" +
      "setInterval(() => {}, 1e6);",
  ];
  const sizes = (s: string): string[] => [...s.matchAll(/SIZE (\d+x\d+)/g)].map((m) => m[1]);

  // A session left by a console that stopped, at the console's 120x30, and a new console's
  // reattach of it, with the agent's output from then on.
  async function reattached(name: string) {
    const id = `${name}-${Date.now()}`;
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: process.execPath, args: SIZE_PRINTER, persist: true });
    await waitFor(() => (a.attach(id)?.snapshot ?? "").includes("RESIZE_READY"), SLOW);
    a.shutdown(); // the console stops; the session stays
    const b = new TerminalManager();
    const att: Attachment = await waitValue(() => b.reattach(id), SLOW);
    const out = { live: "" };
    att.subscribe((c) => { out.live += c; });
    const end = async () => { b.kill(id); await waitFor(() => false, 200).catch(() => {}); };
    return { id, b, out, end };
  }
  const pause = (ms: number) => waitFor(() => false, ms).catch(() => {});

  // Boot recovery and the services reattach with no client: no size change for them.
  it("a reattach alone does not change the size of the agent", async () => {
    const r = await reattached("redraw-none");
    await pause(900);
    expect(sizes(r.out.live)).toEqual([]);
    await r.end();
  }, 30_000);

  it("a client with no size of its own (redrawSoon) → one row less, then the size back; one time only", async () => {
    const r = await reattached("redraw-nudge");
    r.b.redrawSoon(r.id);
    await waitFor(() => sizes(r.out.live).includes("120x30"), SLOW);
    r.b.redrawSoon(r.id);
    await pause(900);
    expect(sizes(r.out.live)).toEqual(["120x29", "120x30"]);
    await r.end();
  }, 30_000);

  it("a client that sends a new size within the wait → only that size, no nudge", async () => {
    const r = await reattached("redraw-browser");
    r.b.redrawSoon(r.id);
    r.b.resize(r.id, 150, 40);
    await waitFor(() => sizes(r.out.live).includes("150x40"), SLOW);
    await pause(900);
    expect(sizes(r.out.live)).toEqual(["150x40"]);
    await r.end();
  }, 30_000);

  // The kernel sends no SIGWINCH for a size that does not change: it draws nothing.
  it("a client that sends the same size (120x30) → the nudge still comes", async () => {
    const r = await reattached("redraw-same");
    r.b.redrawSoon(r.id);
    r.b.resize(r.id, 120, 30);
    await waitFor(() => sizes(r.out.live).includes("120x30"), SLOW);
    expect(sizes(r.out.live)).toEqual(["120x29", "120x30"]);
    await r.end();
  }, 30_000);

  it("a spawned agent drew for this console: redrawSoon does nothing", async () => {
    const id = `redraw-spawned-${Date.now()}`;
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: process.execPath, args: SIZE_PRINTER, persist: true });
    await waitFor(() => (a.attach(id)?.snapshot ?? "").includes("RESIZE_READY"), SLOW);
    a.redrawSoon(id);
    await pause(900);
    expect(sizes(a.attach(id)!.snapshot)).toEqual([]);
    a.kill(id);
    await pause(200);
  }, 30_000);

  it("reattach drops a crashed server's leftover client, so it cannot stall the session", async () => {
    const id = `stale-client-${Date.now()}`;
    const sock = join(process.env.AGENT_DTACH_DIR ?? join(tmpdir(), "choibot-dtach"), `${agentSessionName(id)}.sock`);
    // Server A spawns, then "crashes": no shutdown, so its client stays attached.
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
    expect(dtachClientPids(sock)).toHaveLength(1);

    const b = new TerminalManager();
    await waitValue(() => b.reattach(id));
    await waitFor(() => !a.has(id)); // A's client was killed
    expect(dtachClientPids(sock)).toHaveLength(1); // only B's own client

    b.kill(id);
    await waitFor(() => false, 200).catch(() => {});
  });

  it("reattach returns null when no session exists", async () => {
    const mgr = new TerminalManager();
    expect(await mgr.reattach(`ghost-${Date.now()}`)).toBeNull();
  });

  it("shutdown detaches local clients but leaves the dtach master alive, so the agent survives", async () => {
    const id = `shutdown-${Date.now()}`;
    // Server A spawns a persisted session (cat echoes stdin and stays alive).
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));

    // Graceful shutdown detaches A's client; the master keeps the session alive.
    a.shutdown();
    expect(a.has(id)).toBe(false);
    expect(await a.hasSession(id)).toBe(true); // socket (master) still present

    // A "restarted" server reattaches to the surviving session and can drive it.
    const b = new TerminalManager();
    const att: Attachment = await waitValue(() => b.reattach(id));
    let seen = "";
    att.subscribe((c) => { seen += c; });
    b.write(id, "ALIVE_AFTER_SHUTDOWN\n");
    await waitFor(() => seen.includes("ALIVE_AFTER_SHUTDOWN"));
    expect(seen).toContain("ALIVE_AFTER_SHUTDOWN");

    b.kill(id);
    await waitFor(() => false, 200).catch(() => {});
  });

  it("shutdown does not report a detached client as an agent exit", async () => {
    let exits = 0;
    const id = `shutdown-noexit-${Date.now()}`;
    const a = new TerminalManager({ onExit: () => { exits++; } });
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));

    a.shutdown();
    // Give the client PTY's exit a chance to (wrongly) fire onExit.
    await waitFor(() => false, 300).catch(() => {});
    expect(exits).toBe(0);

    // Clean up the still-alive master.
    const b = new TerminalManager();
    await waitValue(() => b.reattach(id));
    b.kill(id);
    await waitFor(() => false, 200).catch(() => {});
  });

  it("kill ends the session so a later reattach finds nothing", async () => {
    const id = `persist-${Date.now()}-k`;
    const mgr = new TerminalManager();
    mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => mgr.hasSession(id).then((ok) => (ok ? true : null)));
    mgr.kill(id);
    // give the kill a moment to land, then confirm it's gone
    await waitFor(() => false, 300).catch(() => {});
    expect(await mgr.hasSession(id)).toBe(false);
    expect(await mgr.reattach(id)).toBeNull();
  });
});

describe("sessionTreePids", () => {
  // A fake /proc and cgroup fs: pid dirs with argv, stat (ppid, start time) and
  // a cgroup line; scope dirs with cgroup.procs.
  type P = { argv: string[]; ppid: number; cgroup?: string };
  function fake(procs: Record<string, P>, scopes: Record<string, number[]> = {}) {
    const procRoot = mkdtempSync(join(tmpdir(), "choibot-fakeproc-"));
    const cgroupRoot = mkdtempSync(join(tmpdir(), "choibot-fakecg-"));
    for (const [pid, p] of Object.entries(procs)) {
      mkdirSync(join(procRoot, pid), { recursive: true });
      writeFileSync(join(procRoot, pid, "cmdline"), p.argv.join("\0") + "\0");
      // pid (comm with space) state ppid ... field 22 = start time
      const rest = ["S", String(p.ppid), ...Array.from({ length: 17 }, () => "0"), `77${pid}`];
      writeFileSync(join(procRoot, pid, "stat"), `${pid} (${p.argv[0]} x) ${rest.join(" ")}\n`);
      writeFileSync(join(procRoot, pid, "cgroup"), `0::${p.cgroup ?? "/user.slice/other"}\n`);
    }
    for (const [path, pids] of Object.entries(scopes)) {
      mkdirSync(join(cgroupRoot, path), { recursive: true });
      writeFileSync(join(cgroupRoot, path, "cgroup.procs"), pids.join("\n") + "\n");
    }
    return { procRoot, cgroupRoot };
  }
  const sock = "/tmp/d/choibot-a.sock";
  const scope = "/user.slice/app.slice/run-r1.scope";

  it("collects the dtach master, claude and everything it started, plus the scope", () => {
    const roots = fake({
      "1": { argv: ["systemd"], ppid: 0 },
      "500": { argv: ["node"], ppid: 1, cgroup: "/user.slice/choibot.service" }, // this server
      "510": { argv: ["/bin/dtach", "-a", sock], ppid: 500, cgroup: "/user.slice/choibot.service" }, // our client
      "600": { argv: ["/bin/dtach", "-A", sock, "claude"], ppid: 1, cgroup: scope }, // master
      "601": { argv: ["claude"], ppid: 600, cgroup: scope },
      "602": { argv: ["next-server"], ppid: 601, cgroup: scope }, // dev server
      "603": { argv: ["chrome"], ppid: 602, cgroup: scope }, // browser under it
      "700": { argv: ["vite"], ppid: 1, cgroup: scope }, // double-forked away, still in the scope
      "800": { argv: ["/bin/dtach", "-A", "/tmp/d/choibot-b.sock", "claude"], ppid: 1, cgroup: "/user.slice/app.slice/run-r2.scope" },
      "801": { argv: ["claude"], ppid: 800 }, // another agent
    }, { [scope]: [600, 601, 602, 603, 700] });
    const pids = sessionTreePids(sock, { ...roots, selfPid: 500 }).map((p) => p.pid).sort((a, b) => a - b);
    expect(pids).toEqual([510, 600, 601, 602, 603, 700]);
  });

  it("never uses a cgroup that holds this server (AGENT_SCOPE=0)", () => {
    const svc = "/user.slice/app.slice/run-svc.scope";
    const roots = fake({
      "500": { argv: ["node"], ppid: 1, cgroup: svc },
      "600": { argv: ["/bin/dtach", "-A", sock, "claude"], ppid: 1, cgroup: svc },
      "601": { argv: ["claude"], ppid: 600, cgroup: svc },
      "650": { argv: ["postgres"], ppid: 1, cgroup: svc },
    }, { [svc]: [500, 600, 601, 650] });
    const pids = sessionTreePids(sock, { ...roots, selfPid: 500 }).map((p) => p.pid).sort((a, b) => a - b);
    expect(pids).toEqual([600, 601]);
  });

  it("finds nothing when no dtach holds the socket", () => {
    const roots = fake({ "601": { argv: ["claude"], ppid: 1 } });
    expect(sessionTreePids(sock, { ...roots, selfPid: 1 })).toEqual([]);
    expect(sessionTreePids(sock, { procRoot: "/nonexistent-proc" })).toEqual([]);
  });
});

describe("kill stops the whole session tree", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("ends the session and the processes it started, also one in a new session", async () => {
    const id = `tree-${Date.now()}`;
    const dir = mkdtempSync(join(tmpdir(), "choibot-tree-"));
    const pidfile = join(dir, "pids");
    const mgr = new TerminalManager();
    // A child in the tree, and one that left the tty session with setsid (a
    // dev server or browser does that). Both ignore SIGHUP, so only the tree
    // kill ends them.
    mgr.spawn({
      id, cwd: dir, command: "bash", persist: true,
      args: ["-c", `trap '' HUP; nohup sleep 3001 >/dev/null 2>&1 & echo $! >> ${pidfile}; setsid nohup sleep 3002 >/dev/null 2>&1 & echo $! >> ${pidfile}; sleep 3000`],
    });
    await waitFor(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim().split("\n").length === 2, 8000);
    const pids = readFileSync(pidfile, "utf8").trim().split("\n").map(Number);
    expect(pids.every(alive)).toBe(true);
    mgr.kill(id);
    await waitFor(() => !pids.some(alive), 10_000);
    await waitFor(() => !mgr.has(id), 4000);
    expect(await mgr.hasSession(id)).toBe(false);
  }, 20_000);
});

describe("TerminalManager token strip and io times", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function envOutput(mgr: TerminalManager, id: string): Promise<string> {
    mgr.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-c", "/usr/bin/env; sleep 1"] }); // sleep keeps the term attachable
    await waitFor(() => (mgr.attach(id)?.snapshot ?? "").includes("COLORTERM"));
    return mgr.attach(id)!.snapshot;
  }

  it("dropUserToken removes CHOIBOT_USER_TOKEN from the child env", async () => {
    vi.stubEnv("CHOIBOT_USER_TOKEN", "u-secret-1");
    const out = await envOutput(new TerminalManager({ dropUserToken: true }), "tok-drop");
    expect(out).not.toContain("CHOIBOT_USER_TOKEN");
  });

  it("a service PTY keeps CHOIBOT_USER_TOKEN without the option (console uid by design)", async () => {
    vi.stubEnv("CHOIBOT_USER_TOKEN", "u-secret-2");
    const out = await envOutput(new TerminalManager(), "svc:tok-keep");
    expect(out).toContain("CHOIBOT_USER_TOKEN=u-secret-2");
  });

  it("an agent never gets a console secret, with AGENT_ENV_PASS unset and without the option", async () => {
    vi.stubEnv("CHOIBOT_USER_TOKEN", "u-secret-3");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-secret-3");
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-secret-3");
    vi.stubEnv("MY_APP_KEY", "app-3");
    const out = await envOutput(new TerminalManager(), "agent-secrets");
    for (const s of ["u-secret-3", "tg-secret-3", "cookie-secret-3"]) expect(out).not.toContain(s);
    expect(out).toContain("MY_APP_KEY=app-3"); // unset: every other key, as before
  });

  it("an agent gets the allowlist and the AGENT_ENV_PASS keys only, plus its own spawn env", async () => {
    vi.stubEnv("AGENT_ENV_PASS", "MY_APP_KEY");
    vi.stubEnv("MY_APP_KEY", "app-4");
    vi.stubEnv("OTHER_APP_KEY", "other-4");
    vi.stubEnv("TELEGRAM_CHAT_ID", "chat-4");
    const mgr = new TerminalManager();
    mgr.spawn({ id: "agent-allow", cwd: process.cwd(), command: "bash", args: ["-c", "/usr/bin/env; sleep 1"], env: { CHOIBOT_AGENT_ID: "agent-allow", SPAWN_ONLY: "s-4" } });
    await waitFor(() => (mgr.attach("agent-allow")?.snapshot ?? "").includes("COLORTERM"));
    const out = mgr.attach("agent-allow")!.snapshot;
    expect(out).toContain("MY_APP_KEY=app-4");
    expect(out).toContain("CHOIBOT_AGENT_ID=agent-allow");
    expect(out).toContain("SPAWN_ONLY=s-4");
    expect(out).toContain(`PATH=${process.env.PATH}`);
    expect(out).not.toContain("other-4");
    expect(out).not.toContain("chat-4");
  });

  it("a service PTY keeps the console env with AGENT_ENV_PASS set", async () => {
    vi.stubEnv("AGENT_ENV_PASS", "");
    vi.stubEnv("OTHER_APP_KEY", "other-5");
    const out = await envOutput(new TerminalManager(), "svc:allow-keep");
    expect(out).toContain("OTHER_APP_KEY=other-5");
  });

  it("write sets lastInputAt from the injected clock; unknown id is undefined", async () => {
    const mgr = new TerminalManager({ now: () => 4242 });
    mgr.spawn({ id: "io-in", cwd: process.cwd(), command: "/bin/cat", args: [] });
    expect(mgr.lastInputAt("io-in")).toBeUndefined();
    mgr.write("io-in", "a");
    expect(mgr.lastInputAt("io-in")).toBe(4242);
    expect(mgr.lastInputAt("nope")).toBeUndefined();
    expect(mgr.lastOutputAt("nope")).toBeUndefined();
    mgr.kill("io-in");
  });

  it("output sets lastOutputAt", async () => {
    let t = 100;
    const mgr = new TerminalManager({ now: () => t });
    mgr.spawn({ id: "io-out", cwd: process.cwd(), command: "/bin/cat", args: [] });
    expect(mgr.lastOutputAt("io-out")).toBeUndefined();
    t = 555;
    mgr.write("io-out", "hello\n");
    await waitFor(() => mgr.lastOutputAt("io-out") !== undefined);
    expect(mgr.lastOutputAt("io-out")).toBe(555);
    mgr.kill("io-out");
  });

  it("reattach sets lastOutputAt to now before any output", async () => {
    const id = `io-re-${Date.now()}`;
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
    const b = new TerminalManager({ now: () => 9001 });
    await waitValue(() => b.reattach(id));
    expect(b.lastOutputAt(id)).toBe(9001);
    b.kill(id);
    await waitFor(() => false, 200).catch(() => {});
  });
});

// kill() runs `pkill -f <pattern>`, and pkill reads the pattern as a POSIX
// ERE. The socket path carries the id, so its metacharacters are escaped: a
// real path still matches its dtach command line, and `x|` is literal. No
// pkill here: JS RegExp and `grep -E` (the same ERE dialect) check it.
describe("pkillPattern", () => {
  const sock = "/tmp/hct-abc/choibot-2f1c0e1a-1b2c-4d5e-8f90-123456789abc.sock";
  const real = `dtach -A ${sock} -E -z -r winch claude --resume s1`;
  const other = "dtach -A /tmp/hct-abc/choibot-svc-old-pusher.sock -E -z -r winch node pusher.js";
  const ere = (pattern: string, line: string): boolean =>
    spawnSync("grep", ["-E", "-q", "--", pattern], { input: line }).status === 0;

  it("still matches the real dtach command line of a normal id", () => {
    const p = pkillPattern(sock);
    expect(new RegExp(p).test(real)).toBe(true);
    expect(ere(p, real)).toBe(true);
    expect(ere(p, other)).toBe(false);
    // "." is literal now: a name that differs in that byte no longer matches.
    expect(ere(p, real.replace(".sock", "Xsock"))).toBe(false);
  });

  it("makes every metacharacter literal (x| no longer matches every session)", () => {
    for (const id of ["svc-x|", "\\S+", ".*", "a(b)?", "[^/]*", "x{1,3}$", "^y", "a+b"]) {
      const evil = `/tmp/hct-abc/choibot-${id}.sock`;
      const p = pkillPattern(evil);
      for (const line of [real, other]) {
        expect(new RegExp(p).test(line), `${id} vs ${line}`).toBe(false);
        expect(ere(p, line), `${id} vs ${line} (ERE)`).toBe(false);
      }
      expect(ere(p, `dtach -A ${evil} -E`), `${id} literal`).toBe(true);
    }
  });
});

// ---- Phase 2c: agent sessions through choibot-agent-exec (spec Appendix B step 3)
// No test runs the real sudo (rule 7). `sudo` is a fake script: it logs each
// call (its argv, and the env it got, from /proc/<pid>/environ) and then runs
// the command as `sudo -n -u #<uid> --preserve-env=<list>` would, as the
// current user: a fresh env with only the listed keys. `helper` is either a
// stand-in (spawn and attach run cat, probe prints ok, every other verb exits
// 0) or the real deploy/choibot-agent-exec with a temp conf.

const DTACH_BIN = process.env.AGENT_DTACH_BIN ?? spawnSync("/bin/sh", ["-c", "command -v dtach"], { encoding: "utf8" }).stdout.trim();
const HELPER = fileURLToPath(new URL("../../deploy/choibot-agent-exec", import.meta.url));
const SUDOERS = fileURLToPath(new URL("../../deploy/choibot-agent-exec.sudoers.example", import.meta.url));
// The env_keep list of the Global Constraints (plan 2c), verbatim.
const ENV_KEEP = [
  "CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "TERM", "LANG",
  "CHOIBOT_WIDGET_DIR", "CHOIBOT_CRON_SPOOL", "CRON_DATA_DIR", "TZ",
];

function testDtachDir(): string {
  const dir = process.env.AGENT_DTACH_DIR ?? "";
  // Never the live dtach dir: vitest.setup.ts points it at a fresh /tmp/hct- dir.
  if (!dir.startsWith("/tmp/hct-")) throw new Error(`unexpected AGENT_DTACH_DIR ${dir}`);
  return dir;
}
const sockOf = (id: string): string => join(testDtachDir(), `${agentSessionName(id)}.sock`);

const procArgv = (pid: number): string[] => readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
const procEnv = (pid: number): Record<string, string> => parseEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"));
function parseEnviron(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of raw.split("\0")) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

// The dtach master of a socket: a dtach process whose argv names it and whose
// stdin is /dev/null (it daemonized).
function masterPid(sock: string): number | null {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = procArgv(Number(d));
      if (!argv[0]?.endsWith("dtach") || !argv.includes(sock)) continue;
      if (readlinkSync(`/proc/${d}/fd/0`) === "/dev/null") return Number(d);
    } catch { /* gone */ }
  }
  return null;
}

// End whatever a test left on a socket (by pid, never by pattern).
function killSocketTree(sock: string): void {
  for (const p of sessionTreePids(sock, { cgroupRoot: "/nonexistent" })) {
    try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

type Call = { argv: string[]; env: Record<string, string> };
type Fixture = { root: string; sudo: string; stub: string; slowStub: string; calls: () => Call[]; verbs: () => string[] };

function script(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

// The env_keep keys of the sudoers line (deploy/choibot-agent-exec.sudoers.example; strong-setup
// writes the same).
const SUDOERS_KEEP: readonly string[] = (/env_keep \+= "([^"]+)"/.exec(readFileSync(SUDOERS, "utf8"))?.[1] ?? "").split(" ").filter(Boolean);

function fakeSudo(logDir: string, conf: string, keep: readonly string[] = SUDOERS_KEEP): string {
  return `#!/bin/bash
# Test stand-in for sudo: never changes uid. Logs the call, then runs the command as the real sudo
# does with our sudoers line: "sudo -n -u #<uid> [--preserve-env=<list>] <cmd>" (the list: an
# older console). env_reset, then the env_keep keys that the caller has (env.c env_should_keep);
# a --preserve-env key that env_keep does not allow refuses the whole call (sudoers.c
# validate_env_vars).
f=${logDir}/$(/bin/date +%s%N)-$$
/bin/cat /proc/$$/environ > "$f.env"
printf '%s\\0' "$@" > "$f.tmp" && /bin/mv "$f.tmp" "$f.argv"
if [[ $1 != -n || $2 != -u || $3 != '#'* ]]; then echo "fake sudo: bad argv" >&2; exit 64; fi
shift 3
keep=(${keep.join(" ")})
if [[ $1 == --preserve-env=* ]]; then
  IFS=, read -ra asked <<< "\${1#--preserve-env=}"
  for k in "\${asked[@]}"; do
    ok=0; for e in "\${keep[@]}"; do [[ $k == "$e" ]] && ok=1; done
    (( ok )) || { echo "sudo: sorry, you are not allowed to set the following environment variables: $k" >&2; exit 1; }
  done
  shift
fi
kept=()
for k in "\${keep[@]}"; do if [[ -n \${!k+x} ]]; then kept+=("$k=\${!k}"); fi; done
exec /usr/bin/env -i CHOIBOT_AGENT_EXEC_CONF=${conf} "\${kept[@]}" "$@"
`;
}

const STUB_HELPER = `#!/bin/bash
# Test stand-in for choibot-agent-exec.
case $1 in spawn|attach) exec /bin/cat ;; probe) echo ok ;; env-check) compgen -e ;; *) exit 0 ;; esac
`;

function helperFixture(o: { keep?: readonly string[] } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "choibot-exec-"));
  const logDir = join(root, "log");
  mkdirSync(logDir);
  for (const d of ["wt", "ws", "homes"]) mkdirSync(join(root, d));
  const conf = join(root, "exec.conf");
  writeFileSync(conf, [
    `DTACH_DIR=${testDtachDir()}`, `DTACH_BIN=${DTACH_BIN}`, `WORKTREE_ROOT=${root}/wt`,
    `WORKSPACE_DIR=${root}/ws`, `AGENT_HOME_ROOT=${root}/homes`, "",
  ].join("\n"));
  const calls = (): Call[] => readdirSync(logDir).filter((n) => n.endsWith(".argv")).sort().map((n) => ({
    argv: readFileSync(join(logDir, n), "utf8").split("\0").slice(0, -1),
    env: parseEnviron(readFileSync(join(logDir, n.replace(/\.argv$/, ".env")), "utf8")),
  }));
  return {
    root, calls,
    sudo: script(join(root, "sudo"), fakeSudo(logDir, conf, o.keep)),
    stub: script(join(root, "helper-stub"), STUB_HELPER),
    // The same, but kill-clients takes 1 s.
    slowStub: script(join(root, "helper-slow"), STUB_HELPER.replace("case $1 in", "case $1 in kill-clients) /bin/sleep 1 ;;")),
    // The helper verb of each call: sudo -n -u #uid <helper> <verb> (an older console: with
    // --preserve-env=… before the helper)
    verbs: () => calls().map((c) => c.argv[c.argv[3]?.startsWith("--preserve-env=") ? 5 : 4]),
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("helper argv and env (Phase 2c)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const x: AgentExec = { sudo: "/usr/bin/sudo", helper: "/usr/local/bin/choibot-agent-exec", uid: 1001 };

  it("SUDO_ENV_KEEP is the list", () => {
    expect([...SUDO_ENV_KEEP]).toEqual(ENV_KEEP);
  });

  it("the sudoers example and the helper keep that list", () => {
    const both = [...ENV_KEEP];
    const sudoers = /env_keep \+= "([^"]+)"/.exec(readFileSync(SUDOERS, "utf8"));
    expect(sudoers?.[1].split(" ")).toEqual(both);
    const helper = /^readonly ENV_KEEP=\(([^)]+)\)$/m.exec(readFileSync(HELPER, "utf8"));
    expect(helper?.[1].split(" ")).toEqual(both);
  });

  it("helperArgv: sudo -n -u #<uid> <helper> <verb>, no --preserve-env (sudo logs its values) and no env value", () => {
    vi.stubEnv("CHOIBOT_AGENT_PASS", "pass-on-argv?");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-on-argv?");
    const argv = helperArgv(x, "kill", ["/tmp/d/choibot-a.sock"]);
    expect(argv).toEqual(["/usr/bin/sudo", "-n", "-u", "#1001", "/usr/local/bin/choibot-agent-exec", "kill", "/tmp/d/choibot-a.sock"]);
    expect(argv.join("\0")).not.toContain("pass-on-argv?");
    expect(argv.join("\0")).not.toContain("tg-on-argv?");
    expect(helperArgv(x, "probe", [])).toEqual(argv.slice(0, 5).concat("probe"));
  });

  it("no code of the console or of bin/ gives sudo a --preserve-env list (sudo logs each of its values: ENV=)", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const out = spawnSync("git", ["-C", root, "grep", "-n", "--", "--preserve-env", "--", "server", "bin", ":!*.test.ts", ":!*.test.mjs"], { encoding: "utf8" });
    // Only comments that say why it is not used may name it.
    const lines = out.stdout.split("\n").filter(Boolean);
    for (const l of lines) expect(l).toMatch(/:\s*(\/\/|\*|#)/);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("helperSpawnCommand wraps the sudo argv in the user scope, like persistCommand; bare sudo without a scope runner", () => {
    const sudoArgv = helperArgv(x, "spawn", ["/tmp/d/choibot-a.sock", "/wt/a", "--", "claude", "--flag", "a prompt"]);
    const scoped = helperSpawnCommand(x, { systemdRun: "/usr/bin/systemd-run" }, "/tmp/d/choibot-a.sock", "/wt/a", "claude", ["--flag", "a prompt"]);
    expect(scoped.command).toBe("/usr/bin/systemd-run");
    expect(scoped.args).toEqual(["--user", "--scope", "--quiet", "--collect", "--", ...sudoArgv]);
    const bare = helperSpawnCommand(x, { systemdRun: null }, "/tmp/d/choibot-a.sock", "/wt/a", "claude", ["--flag", "a prompt"]);
    expect(bare).toEqual({ command: "/usr/bin/sudo", args: sudoArgv.slice(1) });
  });

  it("helperEnv keeps the env_keep keys and the user-manager keys, nothing else", () => {
    const env = helperEnv({
      TELEGRAM_BOT_TOKEN: "tg", CONSOLE_COOKIE_SECRET: "cookie", PATH: "/usr/bin", HOME: "/home/dev",
      ANTHROPIC_API_KEY: "ak", CHOIBOT_USER_TOKEN: "ut", COLORTERM: "truecolor",
      XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1", PORT: "3100", TERM: "xterm-256color",
      CHOIBOT_CRON_SPOOL: "/h/cron-spool", CRON_DATA_DIR: "/c",
    });
    expect(env).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      CHOIBOT_AGENT_ID: "a1", CHOIBOT_AGENT_PASS: "p1", PORT: "3100", TERM: "xterm-256color",
      CHOIBOT_CRON_SPOOL: "/h/cron-spool", CRON_DATA_DIR: "/c",
    });
    expect(helperEnv({})).toEqual({});
  });

  it("helperAgentEnv: the cron spool under AGENT_HOME_ROOT and the console's absolute CRON_DATA_DIR", () => {
    expect(helperAgentEnv("/srv/homes", "/data/cron")).toEqual({ CHOIBOT_CRON_SPOOL: "/srv/homes/cron-spool", CRON_DATA_DIR: "/data/cron" });
    expect(helperAgentEnv(null, "/data/cron")).toEqual({ CRON_DATA_DIR: "/data/cron" });
    expect(helperAgentEnv(null, "rel/cron")).toEqual({ CRON_DATA_DIR: join(process.cwd(), "rel/cron") });
  });
});

describe("probeAgentExec (Phase 2c)", () => {
  let fx: Fixture;
  beforeEach(() => { fx = helperFixture(); });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("CHIEF_AGENT_UID set but sudo -n refused: the probe returns sudo's line, one log line, no agentExec (Review Focus 1)", async () => {
    const sudo = script(join(fx.root, "sudo-nopass"), "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n");
    const x: AgentExec = { sudo, helper: "/usr/local/bin/choibot-agent-exec", uid: 4242 };
    expect(await probeAgentExec(x)).toBe("sudo: a password is required");
    const log = vi.fn();
    const agentExec = await probedAgentExec(x, { log });
    expect(agentExec).toBeUndefined();
    expect(log.mock.calls).toEqual([["[chief] agent exec unavailable: sudo: a password is required"]]);

    // The manager built without it spawns with direct dtach: today's argv, a
    // console-owned socket, no sudo.
    vi.stubEnv("AGENT_SCOPE", "0");
    const mgr = new TerminalManager({ agentExec });
    const id = `nopass-${Date.now()}`;
    const sock = sockOf(id);
    mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitFor(() => existsSync(sock));
      await settle(150);
      expect(lstatSync(sock).uid).toBe(process.getuid!());
      const clients = dtachClientPids(sock);
      expect(clients).toHaveLength(1);
      const p = persistCommand({ dtach: DTACH_BIN, systemdRun: null }, sock, "cat", []);
      expect(procArgv(clients[0])).toEqual([p.command, ...p.args]);
    } finally {
      mgr.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
  });

  it("runs the probe verb through sudo with the helper env and reads ok", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-probe");
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-probe");
    const x: AgentExec = { sudo: fx.sudo, helper: fx.stub, uid: 4242 };
    expect(await probeAgentExec(x)).toBeNull();
    const [c] = fx.calls();
    expect(c.argv).toEqual(helperArgv(x, "probe", []).slice(1));
    for (const k of ["TELEGRAM_BOT_TOKEN", "CONSOLE_COOKIE_SECRET", "PATH", "HOME"]) expect(c.env).not.toHaveProperty(k);
    const log = vi.fn();
    expect(await probedAgentExec(x, { log })).toBe(x);
    expect(log).not.toHaveBeenCalled();
  });

  it("reports the first non-empty error line, else the exit code", async () => {
    const x: AgentExec = { sudo: "/s", helper: "/h", uid: 4242 };
    const ran: string[][] = [];
    const run = (r: { code: number; stdout: string; stderr: string }) => async (cmd: string, args: string[]) => {
      ran.push([cmd, ...args]);
      return r;
    };
    expect(await probeAgentExec(x, run({ code: 2, stdout: "", stderr: "\n choibot-agent-exec: config not readable: /etc/choibot-agent-exec.conf \nmore\n" })))
      .toBe("choibot-agent-exec: config not readable: /etc/choibot-agent-exec.conf");
    expect(ran[0]).toEqual(helperArgv(x, "probe", []));
    // probe "ok", then env-check names the agent id key.
    const both = async (cmd: string, args: string[]) => (args.includes("env-check") ? { code: 0, stdout: "PORT\nCHOIBOT_AGENT_ID\n", stderr: "" } : { code: 0, stdout: " ok \n", stderr: "" });
    expect(await probeAgentExec(x, both)).toBeNull();
    expect(await probeAgentExec(x, run({ code: 0, stdout: "nope\n", stderr: "" }))).toBe("nope");
    expect(await probeAgentExec(x, run({ code: 3, stdout: "", stderr: "" }))).toBe("exit 3");
    expect(await probeAgentExec(x, async () => { throw new Error("boom"); })).toBe("boom");
  });

  it("a missing sudo binary is an error line, not a throw", async () => {
    const r = await probeAgentExec({ sudo: join(fx.root, "no-such-sudo"), helper: "/h", uid: 4242 });
    expect(r).toMatch(/ENOENT/);
  });

  it("a probe that never ends times out after 10 s", async () => {
    vi.useFakeTimers();
    const p = probeAgentExec({ sudo: "/s", helper: "/h", uid: 4242 }, () => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBe("probe timed out after 10 s");
  });
});

// Tests that make a real dtach session get 20 s, so their finally cleanup
// still runs when a 6 s waitValue fails.
describe("TerminalManager through the helper (Phase 2c)", () => {
  let fx: Fixture;
  let x: AgentExec;
  beforeEach(() => {
    fx = helperFixture();
    x = { sudo: fx.sudo, helper: fx.stub, uid: 4242 };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("without agentExec a persisted spawn is today's direct dtach, argv and env (rollback, Review Focus 4)", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    // agentEnv alone changes nothing: it is for helper spawns only.
    const mgr = new TerminalManager({ agentEnv: helperAgentEnv("/srv/homes", "/data/cron") });
    const id = `direct-${Date.now()}`;
    const sock = sockOf(id);
    mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitFor(() => existsSync(sock));
      await settle(150);
      const clients = dtachClientPids(sock);
      expect(clients).toHaveLength(1);
      const p = persistCommand({ dtach: DTACH_BIN, systemdRun: null }, sock, "cat", []);
      expect(procArgv(clients[0])).toEqual([p.command, ...p.args]);
      const env = procEnv(clients[0]);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.COLORTERM).toBe("truecolor");
      expect(env).not.toHaveProperty("CHOIBOT_CRON_SPOOL");
      expect(env).not.toHaveProperty("CRON_DATA_DIR");
      expect(fx.calls()).toEqual([]);
    } finally {
      mgr.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
    expect(fx.calls()).toEqual([]);
  }, 20_000);

  it("a svc: spawn keeps direct dtach with agentExec set (service PTYs stay console uid)", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    const mgr = new TerminalManager({ agentExec: x });
    const id = `svc:web-${Date.now()}`;
    const sock = sockOf(id);
    mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitFor(() => existsSync(sock));
      await settle(150);
      const clients = dtachClientPids(sock);
      expect(clients).toHaveLength(1);
      const p = persistCommand({ dtach: DTACH_BIN, systemdRun: null }, sock, "cat", []);
      expect(procArgv(clients[0])).toEqual([p.command, ...p.args]);
      mgr.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
    }
    expect(fx.calls()).toEqual([]);
  }, 20_000);

  it("a spawn through the helper runs the runtime's launcher (it marks the agent's config, then execs the CLI)", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    const mgr = new TerminalManager({ agentExec: x });
    const id = `helper-launch-${Date.now()}`;
    const launch = { command: "/bin/sh", args: ["-c", "node -e \"$0\"; exec \"$@\"", "/* js */", "claude-bin", "--flag", "a prompt"] };
    mgr.spawn({ id, cwd: process.cwd(), command: "claude-bin", args: ["--flag", "a prompt"], persist: true, helperLaunch: launch });
    await waitFor(() => fx.calls().length === 1);
    const want = helperSpawnCommand(x, { systemdRun: null }, sockOf(id), process.cwd(), "/bin/sh", launch.args);
    expect(fx.calls()[0].argv).toEqual(want.args);
    mgr.kill(id);
    await waitFor(() => !mgr.has(id));
  });

  it("a persisted agent spawn goes through the helper, with the agent env and no console secret", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-secret-spawn");
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-secret-spawn");
    vi.stubEnv("ANTHROPIC_API_KEY", "ak-spawn");
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/test");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/test/bus");
    let exits = 0;
    const mgr = new TerminalManager({
      agentExec: x, agentEnv: helperAgentEnv("/srv/homes", "/data/cron"), onExit: () => { exits++; },
    });
    const id = `helper-spawn-${Date.now()}`;
    const sock = sockOf(id);
    mgr.spawn({
      id, cwd: process.cwd(), command: "claude-bin", args: ["--flag", "a prompt"], persist: true,
      env: { CHOIBOT_AGENT_ID: id, CHOIBOT_AGENT_PASS: "pass-spawn", PORT: "4999" },
    });
    await waitFor(() => fx.calls().length === 1);
    const [c] = fx.calls();
    const want = helperSpawnCommand(x, { systemdRun: null }, sock, process.cwd(), "claude-bin", ["--flag", "a prompt"]);
    expect(want.command).toBe(fx.sudo);
    expect(c.argv).toEqual(want.args);
    expect(c.argv.join("\0")).not.toContain("pass-spawn");
    // node-pty adds PWD (and TERM); sudo's env_reset drops PWD.
    const allowed = new Set([...SUDO_ENV_KEEP, "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "PWD"]);
    expect(Object.keys(c.env).filter((k) => !allowed.has(k))).toEqual([]);
    expect(c.env).toMatchObject({
      CHOIBOT_AGENT_ID: id, CHOIBOT_AGENT_PASS: "pass-spawn", PORT: "4999", TERM: "xterm-256color",
      CHOIBOT_CRON_SPOOL: "/srv/homes/cron-spool", CRON_DATA_DIR: "/data/cron",
      XDG_RUNTIME_DIR: "/run/user/test", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/test/bus",
    });
    expect(mgr.has(id)).toBe(true);

    // Kill goes to the helper too (the console uid cannot signal agent-uid
    // processes); the local client ends as before.
    mgr.kill(id);
    await waitFor(() => fx.calls().length === 2);
    expect(fx.calls()[1].argv).toEqual(helperArgv(x, "kill", [sock]).slice(1));
    await waitFor(() => !mgr.has(id));
    expect(exits).toBe(1);
  });

  it("an ephemeral shell keeps direct spawn and kill with agentExec set", async () => {
    const mgr = new TerminalManager({ agentExec: x });
    const id = `shell-${Date.now()}`;
    mgr.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-lc", "echo SHELL_DIRECT; sleep 5"] });
    await waitFor(() => (mgr.attach(id)?.snapshot ?? "").includes("SHELL_DIRECT"));
    mgr.kill(id);
    await waitFor(() => !mgr.has(id));
    await settle(100);
    expect(fx.calls()).toEqual([]);
  });

  it("a socket still owned by the console uid (a session from before C6) reattaches with direct dtach -a", async () => {
    const id = `pre-c6-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const b = new TerminalManager({ agentExec: x, ownerOf: () => process.getuid!() });
      const att: Attachment = await waitValue(() => b.reattach(id));
      let seen = "";
      att.subscribe((chunk) => { seen += chunk; });
      b.write(id, "PING_PRE_C6\n");
      await waitFor(() => seen.includes("PING_PRE_C6"));
      await waitFor(() => !a.has(id)); // the stale client went the direct way
      const clients = dtachClientPids(sock);
      expect(clients).toHaveLength(1);
      expect(procArgv(clients[0])).toEqual([DTACH_BIN, "-a", sock, "-E", "-z", "-r", "winch"]);
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
    }
    expect(fx.calls()).toEqual([]);
  }, 20_000);

  it("a kill while kill-clients runs cancels the reattach: null, and no attach", async () => {
    const id = `cancel-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const slow: AgentExec = { ...x, helper: fx.slowStub };
      const b = new TerminalManager({ agentExec: slow, ownerOf: (p) => (p === sock ? slow.uid : null) });
      const pending = b.reattach(id);
      await waitFor(() => fx.calls().length === 2); // alive ran, kill-clients is running
      b.kill(id);
      expect(await pending).toBeNull();
      await waitFor(() => fx.calls().length === 3);
      await settle(200);
      expect(fx.verbs()).toEqual(["alive", "kill-clients", "kill"]);
      expect(b.has(id)).toBe(false);
    } finally {
      a.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
  }, 20_000);

  it("a kill while the alive check runs cancels the reattach too: null, no kill-clients, no attach", async () => {
    const id = `cancel-alive-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const slow: AgentExec = { ...x, helper: script(join(fx.root, "helper-slow-alive"), STUB_HELPER.replace("case $1 in", "case $1 in alive) /bin/sleep 1; echo live ;;")) };
      const b = new TerminalManager({ agentExec: slow, ownerOf: (p) => (p === sock ? slow.uid : null) });
      const pending = b.reattach(id);
      await waitFor(() => fx.calls().length === 1); // alive is running
      b.kill(id);
      expect(await pending).toBeNull();
      await waitFor(() => fx.calls().length === 2);
      await settle(200);
      expect(fx.verbs()).toEqual(["alive", "kill"]);
      expect(b.has(id)).toBe(false);
    } finally {
      a.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
  }, 20_000);

  it("a helper call that execFile refuses at once never rejects: one log line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on("unhandledRejection", onRejection);
    try {
      // A NUL byte in an argument: execFile throws ERR_INVALID_ARG_VALUE
      // synchronously, inside the promise executor.
      const bad: AgentExec = { ...x, helper: `${fx.stub}\0bad` };
      const mgr = new TerminalManager({ agentExec: bad });
      const id = `nul-${Date.now()}`;
      mgr.kill(id); // fire and forget
      await waitFor(() => warn.mock.calls.length > 0);
      await settle(100);
      expect(rejections).toEqual([]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`^\\[terminal\\] helper kill ${sockOf(id)} failed: .*null bytes`));
      expect(fx.calls()).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      warn.mockRestore();
    }
  });

  it("a service socket another uid owns is refused: no attach, no spawn, one log line each (ruling 2c-2-a)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const id = `svc:planted-${Date.now()}`;
      const sock = sockOf(id);
      const exits: [string, number, boolean][] = [];
      // An agent made choibot-svc-<id>.sock (the agent uid can write the dtach dir).
      const mgr = new TerminalManager({
        agentExec: x, ownerOf: (p) => (p === sock ? x.uid : null), onExit: (i, c, k) => { exits.push([i, c, k]); },
      });
      const refused = `[chief] service socket ${basename(sock)} is not console-owned; refused`;
      expect(await mgr.reattach(id)).toBeNull();
      expect(warn.mock.calls).toEqual([[refused]]);
      // A spawn fails like a service whose command exits at once: onExit
      // with code 1 (the ServiceManager's crash path), never a throw.
      mgr.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
      expect(mgr.has(id)).toBe(false);
      await waitFor(() => exits.length === 1);
      expect(exits).toEqual([[id, 1, false]]);
      expect(warn.mock.calls).toEqual([[refused], [refused]]);
      await settle(150);
      expect(existsSync(sock)).toBe(false); // no dtach ran
      expect(fx.calls()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a service socket the console uid owns reattaches with direct dtach -a, as today", async () => {
    const warn = vi.spyOn(console, "warn");
    const id = `svc:own-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const b = new TerminalManager({ agentExec: x, ownerOf: () => process.getuid!() });
      const att: Attachment = await waitValue(() => b.reattach(id));
      await waitFor(() => !a.has(id));
      await waitFor(() => dtachClientPids(sock).length === 1);
      expect(procArgv(dtachClientPids(sock)[0])).toEqual([DTACH_BIN, "-a", sock, "-E", "-z", "-r", "winch"]);
      let seen = "";
      att.subscribe((chunk) => { seen += chunk; });
      b.write(id, "PING_SVC\n");
      await waitFor(() => seen.split("PING_SVC").length - 1 >= 2);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("service socket"))).toEqual([]);
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      warn.mockRestore();
      killSocketTree(sock);
    }
    expect(fx.calls()).toEqual([]);
  }, 20_000);

  it("a socket owned by the agent uid reattaches through the helper: kill-clients, then attach", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-secret-attach");
    const id = `agent-owned-${Date.now()}`;
    const sock = sockOf(id);
    // A real session makes the socket exist; the owner function says agent uid.
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const b = new TerminalManager({ agentExec: x, ownerOf: (p) => (p === sock ? x.uid : null) });
      // Two at once (a WebSocket and the boot reconcile) make one helper run.
      const [r1, r2] = await Promise.all([b.reattach(id), b.reattach(id)]);
      expect(r1).not.toBeNull();
      expect(r2?.epoch).toBe(r1?.epoch);
      await waitFor(() => fx.calls().length >= 3); // the attach PTY logs once it runs
      await settle(100);
      expect(fx.calls().map((c) => c.argv)).toEqual([
        helperArgv(x, "alive", [sock]).slice(1),
        helperArgv(x, "kill-clients", [sock]).slice(1),
        helperArgv(x, "attach", [sock]).slice(1),
      ]);
      expect(fx.calls()[2].env).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
      expect(fx.calls()[2].env).not.toHaveProperty("PATH");
      // The attach PTY is the helper's (here a cat): input reaches it (the
      // tty echo plus cat's copy; the echo alone would be one).
      let seen = "";
      r1!.subscribe((chunk) => { seen += chunk; });
      b.write(id, "PING_HELPER\n");
      await waitFor(() => seen.split("PING_HELPER").length - 1 >= 2);

      b.kill(id);
      await waitFor(() => fx.calls().length === 4);
      expect(fx.verbs()).toEqual(["alive", "kill-clients", "attach", "kill"]);
      expect(fx.calls()[3].argv).toEqual(helperArgv(x, "kill", [sock]).slice(1));
      await waitFor(() => !b.has(id));

      // No socket: no session, and no helper call.
      expect(await b.reattach(`ghost-${Date.now()}`)).toBeNull();
      expect(fx.calls()).toHaveLength(4);
    } finally {
      a.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
  }, 20_000);
});

describe("agent sessions through the real helper, sudo faked (Phase 2c)", () => {
  let fx: Fixture;
  beforeEach(() => { fx = helperFixture(); });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("spawn, restart reattach and kill run the session as the helper's user, with only the allowlisted env", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-secret-e2e");
    vi.stubEnv("CONSOLE_COOKIE_SECRET", "cookie-secret-e2e");
    const x: AgentExec = { sudo: fx.sudo, helper: HELPER, uid: process.getuid!() };
    const agentEnv = helperAgentEnv(join(fx.root, "homes"), join(fx.root, "cron"));
    const id = `e2e-${Date.now()}`;
    const sock = sockOf(id);
    const cwd = join(fx.root, "wt");
    const shell = "tr '\\0' '\\n' < /proc/$$/environ; exec cat";
    const a = new TerminalManager({ agentExec: x, agentEnv });
    try {
      a.spawn({
        id, cwd, command: "/bin/sh", args: ["-c", shell], persist: true,
        env: { CHOIBOT_AGENT_ID: id, CHOIBOT_AGENT_PASS: "pass-e2e" },
      });
      await waitFor(() => (a.attach(id)?.snapshot ?? "").includes("CRON_DATA_DIR="), 8000);
      const out = a.attach(id)!.snapshot;
      expect(out).toContain(`CHOIBOT_CRON_SPOOL=${join(fx.root, "homes", "cron-spool")}`);
      expect(out).toContain(`CRON_DATA_DIR=${join(fx.root, "cron")}`);
      expect(out).toContain("CHOIBOT_AGENT_PASS=pass-e2e");
      expect(out).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
      expect(out).not.toContain("tg-secret-e2e");
      expect(out).not.toContain("cookie-secret-e2e");
      // The master keeps today's argv (the hardened check matches on it).
      const master = masterPid(sock);
      expect(master).not.toBeNull();
      expect(procArgv(master!)).toEqual([DTACH_BIN, "-A", sock, "-E", "-z", "-r", "winch", "/bin/sh", "-c", shell]);
      // With a user manager the spawn is scope-wrapped (helperEnv keeps what
      // systemd-run needs): the master lives in its own run-*.scope, outside
      // this process's cgroup, so it survives a console restart.
      const rt = process.env.XDG_RUNTIME_DIR;
      const scoped = process.env.AGENT_SCOPE !== "0" && !!rt && existsSync(join(rt, "systemd"))
        && existsSync(process.env.AGENT_SYSTEMD_RUN_BIN ?? "/usr/bin/systemd-run");
      if (scoped) {
        const cgroupOf = (pid: number) => readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").find((l) => l.startsWith("0::"));
        expect(cgroupOf(master!)).toMatch(/\/run-[^/]+\.scope$/);
        expect(cgroupOf(master!)).not.toBe(cgroupOf(process.pid));
        expect(fx.calls()[0].env.XDG_RUNTIME_DIR).toBe(rt);
      }

      // A restarted console: kill-clients drops the old client, attach drives it.
      const b = new TerminalManager({ agentExec: x, agentEnv });
      const att: Attachment = await waitValue(() => b.reattach(id));
      await waitFor(() => !a.has(id), 6000);
      // The new client: dtach -a as the helper's user, on B's terminal.
      await waitFor(() => dtachClientPids(sock).length === 1);
      expect(procArgv(dtachClientPids(sock)[0])).toEqual([DTACH_BIN, "-a", sock, "-E", "-z", "-r", "winch"]);
      // Input goes through the session: the session tty's echo plus cat's copy
      // (B's own tty echo, before dtach went raw, would be one).
      let seen = "";
      att.subscribe((chunk) => { seen += chunk; });
      b.write(id, "PING_E2E\n");
      await waitFor(() => seen.split("PING_E2E").length - 1 >= 2);

      b.kill(id);
      await waitFor(() => !b.has(id), 8000);
      await waitFor(() => !existsSync(sock), 2000);
      expect(masterPid(sock)).toBeNull();
      expect(fx.verbs()).toEqual(["spawn", "alive", "kill-clients", "attach", "kill"]);
    } finally {
      killSocketTree(sock);
    }
  }, 30_000);
});

// Ruling F2: AGENT_DTACH_DIR is group-writable, so an agent can plant
// choibot-<id>.scrollback there as a symlink to a console file. In a hardened
// deployment every transcript (agents and services) lives in the console-only
// <chief data dir>/scrollback; not hardened, today's path.
describe("scrollback dir (ruling F2)", () => {
  const HARDENED = {
    CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999", CHIEF_AGENT_UID: "1001",
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("scrollbackDirFor: <chief data dir>/scrollback when hardened, else none (today's dtach dir)", () => {
    expect(scrollbackDirFor({ ...HARDENED, CHIEF_DATA_DIR: "/data/chief" })).toBe("/data/chief/scrollback");
    expect(scrollbackDirFor({ CHIEF_DATA_DIR: "/data/chief", CHIEF_AGENT_UID: "1001" })).toBeUndefined();
    expect(scrollbackDirFor({ ...HARDENED, CHIEF_DATA_DIR: "/data/chief", CHIEF_AGENT_UID: "" })).toBeUndefined();
    expect(scrollbackDirFor({})).toBeUndefined();
  });

  it("with a scrollback dir: the transcript is made there (0700), a planted symlink in the dtach dir is never written", async () => {
    const root = mkdtempSync(join(tmpdir(), "scrollback-"));
    const chief = join(root, "chief");
    mkdirSync(chief, { mode: 0o700 });
    const scrollback = join(chief, "scrollback");
    const victim = join(root, "bashrc");
    writeFileSync(victim, "# rc\n");
    const id = `sb-${Date.now()}`;
    const sock = sockOf(id);
    const planted = join(testDtachDir(), `${agentSessionName(id)}.scrollback`);
    symlinkSync(victim, planted);
    const mgr = new TerminalManager({ scrollbackDir: scrollback });
    try {
      mgr.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-lc", "printf 'SB_MARK\\n'; sleep 30"], persist: true });
      const file = join(scrollback, `${agentSessionName(id)}.scrollback`);
      await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("SB_MARK"), 6000);
      expect(lstatSync(scrollback).mode & 0o777).toBe(0o700);
      expect(readFileSync(victim, "utf8")).toBe("# rc\n");
      expect(lstatSync(planted).isSymbolicLink()).toBe(true);
      // A restarted console replays from the same console-only file.
      const b = new TerminalManager({ scrollbackDir: scrollback });
      const att: Attachment = await waitValue(() => b.reattach(id));
      expect(att.snapshot).toContain("SB_MARK");
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
      expect(readFileSync(victim, "utf8")).toBe("# rc\n");
    } finally {
      killSocketTree(sock);
      rmSync(planted, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("not hardened (no scrollback dir): the transcript is in the dtach dir, as today", async () => {
    const id = `sb-off-${Date.now()}`;
    const sock = sockOf(id);
    const mgr = new TerminalManager();
    try {
      mgr.spawn({ id, cwd: process.cwd(), command: "bash", args: ["-lc", "printf 'SB_OFF\\n'; sleep 30"], persist: true });
      const file = join(testDtachDir(), `${agentSessionName(id)}.scrollback`);
      await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("SB_OFF"), 6000);
      mgr.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
    }
  }, 20_000);
});

// Ruling F5: with agentExec set, a console-owned agent socket is driven by
// direct dtach only while a live console-uid dtach process names it. A stale
// one (no such process) is unlinked and the helper is used: a direct
// `dtach -A` on a dead socket would start a console-uid agent with the full
// console env.
describe("console-owned agent sockets with agentExec (ruling F5)", () => {
  let fx: Fixture;
  let x: AgentExec;
  beforeEach(() => {
    fx = helperFixture();
    x = { sudo: fx.sudo, helper: fx.stub, uid: 4242 };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it("live: a spawn on a console-uid socket that a live console dtach names attaches with direct dtach -A", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    const id = `live-c6-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitValue(() => a.hasSession(id).then((ok) => (ok ? true : null)));
      const b = new TerminalManager({ agentExec: x, ownerOf: () => process.getuid!() });
      b.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
      await waitFor(() => dtachClientPids(sock).length === 2);
      const p = persistCommand({ dtach: DTACH_BIN, systemdRun: null }, sock, "cat", []);
      expect(dtachClientPids(sock).map((pid) => procArgv(pid))).toContainEqual([p.command, ...p.args]);
      expect(existsSync(sock)).toBe(true);
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
    }
    expect(fx.calls()).toEqual([]);
  }, 20_000);

  it("stale: a console-uid socket no live dtach names is unlinked; the spawn goes through the helper", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AGENT_SCOPE", "0");
    const id = `stale-c6-${Date.now()}`;
    const sock = sockOf(id);
    writeFileSync(sock, ""); // a dead session's socket entry, console-owned
    const owner = (p: string) => (p === sock && existsSync(sock) ? process.getuid!() : null);
    const mgr = new TerminalManager({ agentExec: x, ownerOf: owner });
    try {
      mgr.spawn({ id, cwd: process.cwd(), command: "claude-bin", args: [], persist: true });
      await waitFor(() => fx.calls().length === 1);
      expect(fx.verbs()).toEqual(["spawn"]);
      expect(existsSync(sock)).toBe(false);
      expect(dtachClientPids(sock)).toEqual([]);
      expect(warn.mock.calls).toEqual([[`[chief] stale console-owned socket ${sock} unlinked; the agent runs through the helper`]]);
      mgr.kill(id);
      await waitFor(() => !mgr.has(id));
    } finally {
      warn.mockRestore();
      rmSync(sock, { force: true });
    }
  });

  it("stale: a reattach unlinks it and finds no session (null), with no helper call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = `stale-re-${Date.now()}`;
    const sock = sockOf(id);
    writeFileSync(sock, "");
    const mgr = new TerminalManager({ agentExec: x, ownerOf: (p) => (p === sock && existsSync(sock) ? process.getuid!() : null) });
    try {
      expect(await mgr.reattach(id)).toBeNull();
      expect(existsSync(sock)).toBe(false);
      expect(fx.calls()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      rmSync(sock, { force: true });
    }
  });

  it("a process named dtach that is not the console uid's does not count as live", () => {
    // liveConsoleDtach reads the real uid from /proc/<pid>/status.
    const procRoot = mkdtempSync(join(tmpdir(), "fake-proc-"));
    try {
      const sock = "/tmp/hc-x/choibot-a1.sock";
      const proc = (pid: number, uid: number) => {
        mkdirSync(join(procRoot, String(pid)));
        writeFileSync(join(procRoot, String(pid), "cmdline"), ["/usr/local/bin/dtach", "-A", sock, "claude"].join("\0") + "\0");
        writeFileSync(join(procRoot, String(pid), "status"), `Name:\tdtach\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      };
      proc(10, 4242);
      expect(liveConsoleDtach(sock, procRoot)).toBe(false);
      proc(11, process.getuid!());
      expect(liveConsoleDtach(sock, procRoot)).toBe(true);
      expect(liveConsoleDtach("/tmp/hc-x/choibot-b2.sock", procRoot)).toBe(false);
    } finally {
      rmSync(procRoot, { recursive: true, force: true });
    }
  });
});

// The second account of strong protection (server/chief/chiefaccount.ts): the fleet master, the
// Coordinator and a lead run through that account's helper, with their sockets in its own dtach
// folder; a worker stays on the workers' helper and folder. Without that account's helper (its
// probe failed) a persistent agent is refused, never run as the workers' account.
describe("TerminalManager: the persistent agents' account", () => {
  let fx: Fixture;
  let x: AgentExec;
  let c: AgentExec;
  let chiefDir: string;
  beforeEach(() => {
    fx = helperFixture();
    x = { sudo: fx.sudo, helper: fx.stub, uid: 4242 };
    c = { sudo: fx.sudo, helper: fx.stub, uid: 4343 };
    chiefDir = mkdtempSync(join(tmpdir(), "hct-chief-"));
    const env: Record<string, string> = {
      AGENT_SCOPE: "0", CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "http://127.0.0.1:4999",
      CHIEF_AGENT_UID: "4242", CHIEF_PERSISTENT_UID: "4343", AGENT_CLAUDE_CONFIG_DIR: "/home/agent/.claude",
      AGENT_CHIEF_CLAUDE_CONFIG_DIR: "/home/chief/.claude", AGENT_CHIEF_DTACH_DIR: chiefDir,
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(fx.root, { recursive: true, force: true });
    rmSync(chiefDir, { recursive: true, force: true });
  });
  const chiefSock = (id: string): string => join(chiefDir, `${agentSessionName(id)}.sock`);

  it("the fleet master, the Coordinator and a lead go through the second account's helper, with sockets in its folder", async () => {
    const mgr = new TerminalManager({ agentExec: x, chiefExec: c });
    const ids = ["fleet-master", "coordinator", "lead-app-shop"];
    for (const id of ids) mgr.spawn({ id, cwd: process.cwd(), command: "claude-bin", args: ["--x"], persist: true, env: {} });
    await waitFor(() => fx.calls().length === ids.length);
    const got = fx.calls().map((k) => k.argv).sort((a, b) => a.join(" ").localeCompare(b.join(" ")));
    const want = ids.map((id) => helperSpawnCommand(c, { systemdRun: null }, chiefSock(id), process.cwd(), "claude-bin", ["--x"]).args)
      .sort((a, b) => a.join(" ").localeCompare(b.join(" ")));
    expect(got).toEqual(want);
    for (const a of got) expect(a.slice(0, 3)).toEqual(["-n", "-u", "#4343"]);
    for (const id of ids) mgr.kill(id);
    await waitFor(() => fx.calls().length === ids.length * 2);
    for (const id of ids) expect(fx.calls().some((k) => k.argv.join(" ") === helperArgv(c, "kill", [chiefSock(id)]).slice(1).join(" "))).toBe(true);
  });

  it("a worker stays on the workers' helper and the workers' dtach folder", async () => {
    const mgr = new TerminalManager({ agentExec: x, chiefExec: c });
    const id = `worker-${Date.now()}`;
    mgr.spawn({ id, cwd: process.cwd(), command: "claude-bin", args: [], persist: true, env: {} });
    await waitFor(() => fx.calls().length === 1);
    expect(fx.calls()[0].argv).toEqual(helperSpawnCommand(x, { systemdRun: null }, sockOf(id), process.cwd(), "claude-bin", []).args);
    mgr.kill(id);
    await waitFor(() => fx.calls().length === 2);
  });

  it("without the second account's helper (its probe failed) a persistent agent is refused: no helper call, exit 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exits: [string, number][] = [];
    const mgr = new TerminalManager({ agentExec: x, onExit: (i, code) => { exits.push([i, code]); } });
    mgr.spawn({ id: "fleet-master", cwd: process.cwd(), command: "claude-bin", args: [], persist: true, env: {} });
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([["fleet-master", 1]]);
    expect(fx.calls()).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/fleet-master: the persistent agents' account is not ready \(its helper probe failed\); refused/);
    expect(await mgr.reattach("coordinator")).toBeNull();
    expect(fx.calls()).toEqual([]);
  });

  it("a socket of another uid in its folder is refused, never unlinked or attached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sock = chiefSock("fleet-master");
    writeFileSync(sock, "");
    const mgr = new TerminalManager({ agentExec: x, chiefExec: c, ownerOf: (p) => (p === sock ? 4242 : null) });
    expect(await mgr.reattach("fleet-master")).toBeNull();
    expect(existsSync(sock)).toBe(true);
    expect(fx.calls()).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/socket choibot-fleet-master\.sock has owner uid 4242, not the persistent agents' account; refused|socket choibot-fleet-master\.sock has owner uid 4242/);
  });

  it("CHIEF_PERSISTENT_UID unset: the fleet master runs as before (the workers' helper and folder)", async () => {
    vi.stubEnv("CHIEF_PERSISTENT_UID", "");
    const mgr = new TerminalManager({ agentExec: x, chiefExec: c });
    mgr.spawn({ id: "fleet-master", cwd: process.cwd(), command: "claude-bin", args: [], persist: true, env: {} });
    await waitFor(() => fx.calls().length === 1);
    expect(fx.calls()[0].argv).toEqual(helperSpawnCommand(x, { systemdRun: null }, sockOf("fleet-master"), process.cwd(), "claude-bin", []).args);
    mgr.kill("fleet-master");
    await waitFor(() => fx.calls().length === 2);
  });
});

// A dead session whose socket file stays: its dtach master ended by SIGKILL (a restart of the user
// manager, an OOM kill) without removing the file. The B3 proof on a real server (2026-11-25):
// the boot took such a file for a live session, attached, the attach ended at once, the record
// became "error", and no start and no wait of the second sign-in came. "dead" needs positive
// proof (a connect that is refused); a doubt is "live", as before.
describe("a dead session whose socket file stays", () => {
  let fx: Fixture;
  const x = (helper: string, uid = 4242): AgentExec => ({ sudo: fx.sudo, helper, uid });
  const stub = (alive: string): string => script(join(fx.root, `helper-${alive.replace(/\W/g, "")}`), STUB_HELPER.replace("case $1 in", `case $1 in alive) ${alive} ;;`));
  beforeEach(() => {
    fx = helperFixture();
    vi.stubEnv("AGENT_SCOPE", "0");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fx.root, { recursive: true, force: true });
  });

  // A real dtach session (no helper), then its whole tree killed with SIGKILL: the file stays.
  async function staleSocket(sock: string): Promise<void> {
    spawnSync(DTACH_BIN, ["-n", sock, "-z", "/bin/sleep", "300"]);
    await waitFor(() => masterPid(sock) !== null, 6000);
    killSocketTree(sock);
    await waitFor(() => masterPid(sock) === null, 6000);
    expect(lstatSync(sock).isSocket()).toBe(true);
  }
  const verbsAt = async (n: number): Promise<string[]> => {
    await waitFor(() => fx.verbs().length >= n, 6000);
    await settle(100);
    return fx.verbs();
  };
  const ping = async (mgr: TerminalManager, att: Attachment, id: string, text: string): Promise<void> => {
    let seen = "";
    att.subscribe((chunk) => { seen += chunk; });
    mgr.write(id, `${text}\n`);
    await waitFor(() => seen.includes(text));
  };

  it("basic protection, a live master: alive, its reattach works, nothing is unlinked, no second session", async () => {
    const id = `live-direct-${Date.now()}`;
    const sock = sockOf(id);
    const a = new TerminalManager();
    a.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
    try {
      await waitFor(() => existsSync(sock) && masterPid(sock) !== null, 6000);
      const master = masterPid(sock);
      const b = new TerminalManager();
      expect(await b.hasSession(id)).toBe(true);
      await ping(b, await waitValue(() => b.reattach(id)), id, "PING_LIVE_DIRECT");
      expect(masterPid(sock)).toBe(master);
      expect(existsSync(sock)).toBe(true);
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
    }
  }, 20_000);

  it("basic protection, a master killed with SIGKILL: not a session, no attach, no exit event; a start begins fresh over the file", async () => {
    const id = `stale-direct-${Date.now()}`;
    const sock = sockOf(id);
    await staleSocket(sock);
    let exits = 0;
    const b = new TerminalManager({ onExit: () => { exits++; } });
    try {
      expect(await b.hasSession(id)).toBe(false);
      expect(await b.reattach(id)).toBeNull();
      await settle(400);
      expect(exits).toBe(0);
      expect(b.has(id)).toBe(false);
      expect(dtachClientPids(sock)).toEqual([]);
      expect(existsSync(sock)).toBe(true); // nothing unlinked
      b.spawn({ id, cwd: process.cwd(), command: "cat", args: [], persist: true });
      await waitFor(() => masterPid(sock) !== null, 6000);
      await ping(b, b.attach(id)!, id, "PING_FRESH_DIRECT");
      b.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
      rmSync(sock, { force: true });
    }
  }, 20_000);

  it("through the real helper: a live session is alive and reattaches; after a SIGKILL only `alive` runs (no kill-clients, no attach) and a start begins fresh", async () => {
    const real = x(HELPER, process.getuid!());
    const id = `stale-helper-${Date.now()}`;
    const sock = sockOf(id);
    const cwd = join(fx.root, "ws");
    const a = new TerminalManager({ agentExec: real });
    a.spawn({ id, cwd, command: "/bin/cat", args: [], persist: true });
    try {
      await waitFor(() => existsSync(sock) && masterPid(sock) !== null, 6000);
      const b = new TerminalManager({ agentExec: real });
      expect(await b.hasSession(id)).toBe(true);
      await ping(b, await waitValue(() => b.reattach(id)), id, "PING_LIVE_HELPER");
      killSocketTree(sock);
      await waitFor(() => masterPid(sock) === null && !b.has(id), 6000);
      const before = fx.verbs().length;
      let exits = 0;
      const c = new TerminalManager({ agentExec: real, onExit: () => { exits++; } });
      expect(await c.hasSession(id)).toBe(false);
      expect(await c.reattach(id)).toBeNull();
      await settle(400);
      expect(fx.verbs().slice(before)).toEqual(["alive", "alive"]);
      expect(exits).toBe(0);
      c.spawn({ id, cwd, command: "/bin/cat", args: [], persist: true });
      await waitFor(() => masterPid(sock) !== null, 6000);
      await ping(c, c.attach(id)!, id, "PING_FRESH_HELPER");
      c.kill(id);
      await waitFor(() => !existsSync(sock), 6000);
    } finally {
      killSocketTree(sock);
      rmSync(sock, { force: true });
    }
  }, 20_000);

  it("a doubt is alive, as before: the helper says unknown, or fails; the reattach goes on (kill-clients, attach)", async () => {
    for (const answer of ["echo unknown", "exit 1"]) {
      const id = `doubt-${answer.length}-${Date.now()}`;
      const sock = sockOf(id);
      await staleSocket(sock);
      const before = fx.verbs().length;
      const m = new TerminalManager({ agentExec: x(stub(answer)), ownerOf: (p) => (p === sock ? 4242 : null) });
      try {
        expect(await m.hasSession(id)).toBe(true);
        expect(await m.reattach(id)).not.toBeNull();
        expect((await verbsAt(before + 4)).slice(before)).toEqual(["alive", "alive", "kill-clients", "attach"]);
      } finally {
        m.kill(id);
        await waitFor(() => !m.has(id), 6000);
        rmSync(sock, { force: true });
      }
    }
  }, 20_000);

  // The recovery path (boot, Resume, an ensure): a real TerminalManager with a helper stub that
  // proves the session dead. No real Claude runs: the stub's spawn is cat.
  const recordOf = (id: string, over: Partial<AgentRecord> = {}): AgentRecord => ({
    id, label: id, repo: "", worktree: join(fx.root, "ws"), cwd: join(fx.root, "ws"), branch: "", baseBranch: "",
    sessionId: null, hookToken: "t", status: "idle", createdAt: 1, ...over,
  } as AgentRecord);
  function recovery(terminals: TerminalManager, chiefWait?: ChiefWait): { ctx: RecoveryCtx; patches: Array<[string, Partial<AgentRecord>]> } {
    const patches: Array<[string, Partial<AgentRecord>]> = [];
    const ctx = {
      port: 3100, workspaceDir: join(fx.root, "ws"),
      claudeHooksPathFor: () => join(fx.root, "hooks.json"), writeClaudeHookSettings: async () => {},
      store: { list: async () => [], patch: async (id: string, p: Partial<AgentRecord>) => { patches.push([id, p]); } },
      terminals, ...(chiefWait ? { chiefWait } : {}),
    } as unknown as RecoveryCtx;
    return { ctx, patches };
  }

  it("a worker's stale socket through the helper (after a user@ restart): its resume starts it again, with no attach; a second Resume too", async () => {
    const id = `w-stale-${Date.now()}`;
    const sock = sockOf(id);
    await staleSocket(sock);
    const m = new TerminalManager({ agentExec: x(stub("echo dead")), ownerOf: (p) => (p === sock ? 4242 : null) });
    const { ctx, patches } = recovery(m);
    try {
      expect(await resumeAgent(recordOf(id), ctx)).toBe("cold");
      expect(await verbsAt(2)).toEqual(["alive", "spawn"]);
      expect(patches).toEqual([[id, expect.objectContaining({ status: "idle" })]]);
      m.kill(id);
      await waitFor(() => !m.has(id), 6000);
      await verbsAt(3);
      expect(await resumeAgent(recordOf(id), ctx)).toBe("cold");
      expect(await verbsAt(5)).toEqual(["alive", "spawn", "kill", "alive", "spawn"]);
    } finally {
      m.kill(id);
      await waitFor(() => !m.has(id), 6000);
      rmSync(sock, { force: true });
    }
  }, 20_000);

  it("at boot, the fleet master, a lead and the Coordinator with a stale socket: each waits for the second sign-in (no attach, its status kept); after the sign-in each starts", async () => {
    for (const [k, v] of Object.entries({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242", CHIEF_PERSISTENT_UID: "4343" })) vi.stubEnv(k, v);
    const recs = [recordOf("fleet-master", { kind: "fleet-master" }), recordOf("lead-web", { kind: "lead" }), recordOf("coordinator", { kind: "coordinator" })];
    const socks = recs.map((r) => sockOf(r.id));
    for (const s of socks) await staleSocket(s);
    let signed = false;
    const chiefWait = new ChiefWait({ signedIn: async () => signed, log: () => {} });
    let exits = 0;
    const m = new TerminalManager({
      agentExec: x(fx.stub), chiefExec: x(stub("echo dead"), 4343), ownerOf: (p) => (socks.includes(p) ? 4343 : null), onExit: () => { exits++; },
    });
    const { ctx, patches } = recovery(m, chiefWait);
    try {
      for (const r of recs) expect(await resumeAgent(r, ctx), r.id).toBe("waits");
      expect(fx.verbs()).toEqual(["alive", "alive", "alive"]);
      expect(chiefWait.waits().sort()).toEqual(["coordinator", "fleet-master", "lead-web"]);
      // The master's status and the Master tab read this: "Waits for its sign-in".
      expect(chiefWait.waitsFor("fleet-master")).toBe(true);
      expect(patches).toEqual([]);
      await settle(300);
      expect(exits).toBe(0);
      signed = true;
      for (const [i, r] of recs.entries()) {
        expect(await resumeAgent(r, ctx), r.id).toBe("cold");
        expect((await verbsAt(5 + 2 * i)).slice(3 + 2 * i), r.id).toEqual(["alive", "spawn"]);
      }
      expect(chiefWait.waits()).toEqual([]);
    } finally {
      for (const r of recs) m.kill(r.id);
      await waitFor(() => recs.every((r) => !m.has(r.id)), 6000);
      for (const s of socks) rmSync(s, { force: true });
    }
  }, 30_000);

  it("with the second sign-in made: a stale socket of the fleet master starts at once, with no attach to it", async () => {
    for (const [k, v] of Object.entries({ CHIEF_ENABLED: "1", CHIEF_USER_AUTH: "log", CHIEF_CONSOLE_URL: "https://c.example", CHIEF_AGENT_UID: "4242", CHIEF_PERSISTENT_UID: "4343" })) vi.stubEnv(k, v);
    const sock = sockOf("fleet-master");
    await staleSocket(sock);
    const m = new TerminalManager({ agentExec: x(fx.stub), chiefExec: x(stub("echo dead"), 4343), ownerOf: (p) => (p === sock ? 4343 : null) });
    const { ctx } = recovery(m, new ChiefWait({ signedIn: async () => true, log: () => {} }));
    try {
      expect(await resumeAgent(recordOf("fleet-master", { kind: "fleet-master" }), ctx)).toBe("cold");
      expect(await verbsAt(2)).toEqual(["alive", "spawn"]);
    } finally {
      m.kill("fleet-master");
      await waitFor(() => !m.has("fleet-master"), 6000);
      rmSync(sock, { force: true });
    }
  }, 20_000);

  it("a move of an agent whose socket is stale: the record takes the new login at once (no 8 s wait, no \"did not end\")", async () => {
    const id = `move-stale-${Date.now()}`;
    const sock = sockOf(id);
    await staleSocket(sock);
    const m = new TerminalManager({ agentExec: x(stub("echo dead")), ownerOf: (p) => (p === sock ? 4242 : null) });
    const { ctx, patches } = recovery(m);
    try {
      const t0 = Date.now();
      expect(await switchAccount(recordOf(id), "work", ctx)).toBe("patched");
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(patches).toEqual([[id, { account: "work" }]]);
      expect(fx.verbs()).toEqual(["alive"]);
    } finally {
      rmSync(sock, { force: true });
    }
  }, 20_000);
});

// The agents' keys reach the helper through the sudoers line's env_keep, never through sudo's
// --preserve-env list: sudo logs each value of that list (ENV=), and the agent's pass is one of
// them. At its start the console checks that the keys arrive (env-check after probe). Each age of
// the two parts starts an agent. The agent writes the NAMES of its env keys only, never a value.
describe("the agents' keys through env_keep, never --preserve-env", () => {
  let fx: Fixture | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (fx) rmSync(fx.root, { recursive: true, force: true });
    fx = undefined;
  });
  // The helper of an older console: no env-check, the same probe (testdata).
  const oldHelper = (f: Fixture): string => script(join(f.root, "old-helper"), readFileSync(fileURLToPath(new URL("./testdata/agent-exec-before-env-check.sh", import.meta.url)), "utf8"));
  const env = (id: string) => ({ CHOIBOT_AGENT_ID: id, CHOIBOT_AGENT_PASS: "made-up-pass-of-a-test", PORT: "4999" });
  // The keys the agent got (names only), written to a file by the session itself.
  const keyNames = async (out: string): Promise<string[]> => {
    await waitFor(() => existsSync(out), 6000);
    return readFileSync(out, "utf8").split("\n").filter(Boolean);
  };
  const NAMES_CMD = ["-c", 'tr "\\0" "\\n" < /proc/$$/environ | cut -d= -f1 | sort > "$0.tmp" && mv "$0.tmp" "$0"; exec /bin/cat'];

  async function startAgent(f: Fixture, x: AgentExec): Promise<string[]> {
    vi.stubEnv("AGENT_SCOPE", "0");
    const id = `keys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const sock = sockOf(id);
    const out = join(f.root, `${id}.names`);
    const m = new TerminalManager({ agentExec: x });
    m.spawn({ id, cwd: join(f.root, "ws"), command: "/bin/sh", args: [...NAMES_CMD.slice(0, 1), NAMES_CMD[1], out], persist: true, env: env(id) });
    try {
      return await keyNames(out);
    } finally {
      m.kill(id);
      await waitFor(() => !existsSync(sock), 6000).catch(() => killSocketTree(sock));
    }
  }

  it("a new console and a new helper: the probe and env-check pass, and the agent gets its id and pass", async () => {
    fx = helperFixture();
    const x: AgentExec = { sudo: fx.sudo, helper: HELPER, uid: process.getuid!() };
    const log = vi.fn();
    expect(await probedAgentExec(x, { log })).toBe(x);
    expect(log).not.toHaveBeenCalled();
    expect(fx.verbs()).toEqual(["probe", "env-check"]);
    // The env check's own call: the marker in the agent id key, nothing on argv.
    const check = fx.calls()[1];
    expect(check.argv).toEqual(helperArgv(x, "env-check", []).slice(1));
    expect(check.env.CHOIBOT_AGENT_ID).toBe("env-check");
    const names = await startAgent(fx, x);
    expect(names).toEqual(expect.arrayContaining(["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT"]));
    expect(fx.calls().every((c) => !c.argv.some((a) => a.startsWith("--preserve-env")))).toBe(true);
  }, 20_000);

  it("a new console and an older helper (no env-check): allowed with one line; the agent gets its id and pass", async () => {
    fx = helperFixture();
    const x: AgentExec = { sudo: fx.sudo, helper: oldHelper(fx), uid: process.getuid!() };
    const log = vi.fn();
    expect(await probedAgentExec(x, { log })).toBe(x);
    expect(log.mock.calls).toEqual([["[chief] the helper is older (it has no env-check): its env_keep was not checked; strong-setup updates it"]]);
    const names = await startAgent(fx, x);
    expect(names).toEqual(expect.arrayContaining(["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT"]));
  }, 20_000);

  it("an older console (its --preserve-env list) and a new helper: the probe passes and the agent gets its id and pass", async () => {
    vi.stubEnv("AGENT_SCOPE", "0");
    fx = helperFixture();
    const x: AgentExec = { sudo: fx.sudo, helper: HELPER, uid: process.getuid!() };
    const old = (argv: string[]): string[] => [...argv.slice(0, 4), `--preserve-env=${SUDO_ENV_KEEP.join(",")}`, ...argv.slice(4)];
    const [pcmd, ...pargs] = old(helperArgv(x, "probe", []));
    expect(spawnSync(pcmd, pargs, { encoding: "utf8", env: helperEnv(process.env) as NodeJS.ProcessEnv }).stdout).toBe("ok\n");
    const id = `keys-old-${Date.now()}`;
    const sock = sockOf(id);
    const out = join(fx.root, `${id}.names`);
    const [cmd, ...args] = old(helperArgv(x, "spawn", [sock, join(fx.root, "ws"), "--", "/bin/sh", NAMES_CMD[0], NAMES_CMD[1], out]));
    const p = pty.spawn(cmd, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: helperEnv({ ...process.env, ...env(id) }) });
    try {
      expect(await keyNames(out)).toEqual(expect.arrayContaining(["CHOIBOT_AGENT_ID", "CHOIBOT_AGENT_PASS", "PORT"]));
      expect(fx.calls().map((c) => c.argv[3].startsWith("--preserve-env="))).toEqual([true, true]);
    } finally {
      p.kill();
      killSocketTree(sock);
      rmSync(sock, { force: true });
    }
  }, 20_000);

  it("a sudoers line with no env_keep: env-check names no agent key; agent exec is unavailable, with the reason, and nothing runs through the helper", async () => {
    fx = helperFixture({ keep: [] });
    const x: AgentExec = { sudo: fx.sudo, helper: HELPER, uid: process.getuid!() };
    const log = vi.fn();
    expect(await probedAgentExec(x, { log })).toBeUndefined();
    expect(log.mock.calls).toEqual([["[chief] agent exec unavailable: the sudoers line of the helper keeps no agent keys (env_keep): CHOIBOT_AGENT_ID did not reach it, so the agents' id and pass would not"]]);
    expect(fx.verbs()).toEqual(["probe", "env-check"]);
  });

  it("an env-check that fails for another reason fails the probe with its line (fail closed)", async () => {
    const x: AgentExec = { sudo: "/s", helper: "/h", uid: 4242 };
    const run = async (_cmd: string, args: string[]) => (args.includes("env-check")
      ? { code: 2, stdout: "", stderr: "choibot-agent-exec: DTACH_DIR is not a directory: /x\n" }
      : { code: 0, stdout: "ok\n", stderr: "" });
    expect(await probeAgentExec(x, run)).toBe("choibot-agent-exec: DTACH_DIR is not a directory: /x");
  });
});
