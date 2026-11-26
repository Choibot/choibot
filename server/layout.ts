// server/layout.ts — where the settings file and the data folders of this install are (H2). One
// place for the console and the command line; nothing else joins ".env" or a data folder name.
//
// Two layouts:
//   - the folder layout: a git checkout, an archive install, a release from before the release
//     layout. The settings and the data are in the code folder: <app>/.env, <app>/.agent-data,
//     <app>/.services-data, <app>/.widgets-data (relative to the code folder, as before).
//   - the release layout: a fresh install from a release (install.sh CHOIBOT_RELEASE). The code
//     folder holds code only, so a release can replace it whole:
//       <home>/console.env                 the settings (0600, the console account's)
//       <app data dir>/agents, /services   the agent records and the service records (private)
//       <home>/widgets                     the widgets: outside the console user's home, because
//                                          the agents reach them (bin/lib/strong.ts refuses a
//                                          widget folder in the home)
//     where <home> is the folder of the install (the parent of app/, /opt/choibot on the image).
// A release (app/release.json) whose <home>/console.env is there has the release layout. A key of
// the settings (AGENT_DATA_DIR, SERVICES_DATA_DIR, WIDGETS_DATA_DIR) wins in both, as before.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveAppDataDir, type Env } from "./defaults.js";

export const SETTINGS_NAME = "console.env";
const FOLDER_SETTINGS = ".env";

// The release layout: a release whose settings file is outside its code folder.
export function releaseLayout(appDir: string): boolean {
  return existsSync(join(appDir, "release.json")) && existsSync(join(dirname(resolve(appDir)), SETTINGS_NAME));
}

// The settings file of the install whose code folder is `appDir`.
export function settingsFile(appDir: string): string {
  return releaseLayout(appDir) ? join(dirname(resolve(appDir)), SETTINGS_NAME) : join(appDir, FOLDER_SETTINGS);
}

const keyed = (v: string | undefined): string | undefined => v?.trim() || undefined;

// The agent records (their hook tokens): private to the console account.
export function agentDataDir(env: Env, appDir: string): string {
  const k = keyed(env.AGENT_DATA_DIR);
  if (k) return resolve(appDir, k);
  return releaseLayout(appDir) ? join(resolveAppDataDir(env), "agents") : resolve(appDir, ".agent-data");
}

// The service records: private to the console account.
export function servicesDataDir(env: Env, appDir: string): string {
  const k = keyed(env.SERVICES_DATA_DIR);
  if (k) return resolve(appDir, k);
  return releaseLayout(appDir) ? join(resolveAppDataDir(env), "services") : resolve(appDir, ".services-data");
}

// The widgets: shared with the agents (strong protection gives the folder its group), so never in
// the console user's home.
export function widgetsDataDir(env: Env, appDir: string): string {
  const k = keyed(env.WIDGETS_DATA_DIR);
  if (k) return resolve(appDir, k);
  return releaseLayout(appDir) ? join(dirname(resolve(appDir)), "widgets") : resolve(appDir, ".widgets-data");
}
