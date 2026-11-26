import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppDataDir, resolveClaudeBin, resolveDtachBin, resolveWorkspaceDir, toolBin } from "./defaults.js";

// os.homedir() reads $HOME, so each test gets its own home.
let home: string;
let savedHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "defaults-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function exe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\n");
  chmodSync(p, 0o755);
  return p;
}

describe("resolveWorkspaceDir", () => {
  it("takes WORKSPACE_DIR, else ~/workspace", () => {
    expect(resolveWorkspaceDir({ WORKSPACE_DIR: "/srv/ws" })).toBe("/srv/ws");
    expect(resolveWorkspaceDir({ WORKSPACE_DIR: " " })).toBe(join(home, "workspace"));
    expect(resolveWorkspaceDir({})).toBe(join(home, "workspace"));
  });
});

describe("resolveAppDataDir", () => {
  // The suite runs as an install with the old names (vitest.setup.ts): the dir is choibot.
  it("is the data dir of the install under XDG_DATA_HOME, else under ~/.local/share", () => {
    expect(resolveAppDataDir({ XDG_DATA_HOME: "/x" })).toBe("/x/choibot");
    expect(resolveAppDataDir({})).toBe(join(home, ".local", "share", "choibot"));
  });
});

describe("toolBin", () => {
  it("takes the env key first, even when the file is not there", () => {
    expect(resolveClaudeBin({ CLAUDE_CODE_EXECUTABLE: "/opt/claude", PATH: "" })).toBe("/opt/claude");
    expect(resolveDtachBin({ AGENT_DTACH_BIN: "/opt/dtach", PATH: "" })).toBe("/opt/dtach");
  });
  it("then ~/.local/bin, then PATH, then the bare name", () => {
    const onPath = exe(join(home, "bin"), "dtach");
    expect(toolBin("dtach", undefined, { PATH: join(home, "bin") })).toBe(onPath);
    const local = exe(join(home, ".local", "bin"), "dtach");
    expect(toolBin("dtach", "", { PATH: join(home, "bin") })).toBe(local);
    expect(toolBin("no-such-tool", undefined, { PATH: join(home, "bin") })).toBe("no-such-tool");
  });
  it("skips a file that is not executable", () => {
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "claude"), "");
    expect(resolveClaudeBin({ PATH: join(home, "bin") })).toBe("claude");
  });
});
