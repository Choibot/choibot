// server/layout.test.ts — where the settings file and the data folders are (server/layout.ts): the
// folder layout of today, the release layout of a fresh install from a release, the keys that win.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETTINGS_NAME, agentDataDir, releaseLayout, servicesDataDir, settingsFile, widgetsDataDir } from "./layout.js";
import { isRefused, refusalFor } from "./files/refused.js";
import { names } from "./names.mjs";

// The data folder's name of this install (the tests run as an install with the old names).
const DATA = names().dataDir;

describe("the layout of an install", () => {
  let home: string, app: string;
  const env = () => ({ HOME: join(home, "user"), XDG_DATA_HOME: join(home, "user", ".local", "share") });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "layout-"));
    app = join(home, "app");
    mkdirSync(app);
  });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("the folder layout (a checkout, an archive): everything in the code folder, as before", () => {
    expect(releaseLayout(app)).toBe(false);
    expect(settingsFile(app)).toBe(join(app, ".env"));
    expect(agentDataDir(env(), app)).toBe(join(app, ".agent-data"));
    expect(servicesDataDir(env(), app)).toBe(join(app, ".services-data"));
    expect(widgetsDataDir(env(), app)).toBe(join(app, ".widgets-data"));
  });

  it("ignores a console.env next to a code folder that is not a release (a git checkout)", () => {
    writeFileSync(join(home, SETTINGS_NAME), "PORT=1\n");
    expect(releaseLayout(app)).toBe(false);
    expect(settingsFile(app)).toBe(join(app, ".env"));
  });

  it("a release from before (no console.env outside): the folder layout", () => {
    writeFileSync(join(app, "release.json"), "{}");
    expect(releaseLayout(app)).toBe(false);
    expect(settingsFile(app)).toBe(join(app, ".env"));
  });

  it("the release layout: the code folder holds code only", () => {
    writeFileSync(join(app, "release.json"), "{}");
    writeFileSync(join(home, SETTINGS_NAME), "PORT=1\n");
    expect(releaseLayout(app)).toBe(true);
    expect(settingsFile(app)).toBe(join(home, "console.env"));
    expect(agentDataDir(env(), app)).toBe(join(home, "user", ".local", "share", DATA, "agents"));
    expect(servicesDataDir(env(), app)).toBe(join(home, "user", ".local", "share", DATA, "services"));
    // The widgets: outside the console user's home (the agents reach them).
    expect(widgetsDataDir(env(), app)).toBe(join(home, "widgets"));
  });

  it("a key of the settings wins in both layouts, relative to the code folder as before", () => {
    const keys = { ...env(), AGENT_DATA_DIR: "/data/agents", SERVICES_DATA_DIR: "svc", WIDGETS_DATA_DIR: " /data/w " };
    for (const release of [false, true]) {
      if (release) { writeFileSync(join(app, "release.json"), "{}"); writeFileSync(join(home, SETTINGS_NAME), ""); }
      expect([release, agentDataDir(keys, app), servicesDataDir(keys, app), widgetsDataDir(keys, app)]).toEqual([release, "/data/agents", join(app, "svc"), "/data/w"]);
    }
  });

  it("the file routes refuse the settings file and the data folders of the release layout", () => {
    writeFileSync(join(app, "release.json"), "{}");
    writeFileSync(join(home, SETTINGS_NAME), "CONSOLE_COOKIE_SECRET=x\n");
    mkdirSync(join(home, "user", ".local", "share", DATA, "agents"), { recursive: true });
    const r = refusalFor({ env: env(), checkout: app });
    expect(isRefused(join(home, "console.env"), r)).toBe(true);
    expect(isRefused(join(home, "user", ".local", "share", DATA, "agents", "a1.json"), r)).toBe(true);
    expect(isRefused(join(app, "server", "index.ts"), r)).toBe(false);
  });
});
