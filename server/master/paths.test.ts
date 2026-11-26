import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { FLEET_MASTER_ID, masterPaths, resolveMasterDataDir } from "./paths.js";

describe("resolveMasterDataDir", () => {
  it("prefers MASTER_DATA_DIR", () => {
    expect(resolveMasterDataDir({ MASTER_DATA_DIR: "/x/m", XDG_DATA_HOME: "/xdg" })).toBe("/x/m");
  });
  it("falls back to XDG_DATA_HOME, then ~/.local/share", () => {
    expect(resolveMasterDataDir({ XDG_DATA_HOME: "/xdg" })).toBe("/xdg/choibot/master");
    expect(resolveMasterDataDir({})).toBe(join(homedir(), ".local", "share", "choibot", "master"));
  });
});

describe("masterPaths", () => {
  it("puts the agent cwd, the memory dir and the photo inbox under the data dir", () => {
    expect(masterPaths("/d")).toEqual({ agentDir: "/d/agent", memoryDir: "/d/memory", inboxDir: "/d/inbox" });
  });
  it("uses the fixed id", () => {
    expect(FLEET_MASTER_ID).toBe("fleet-master");
  });
});
