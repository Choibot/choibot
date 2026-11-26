// bin/lib/pair.ts — `pair`: the code that pairs the first device of a new install
// (server/chief/firstrun.ts). The code is made here, on the box, and written as a hash to the
// console's data dir: no HTTP route makes one. It goes to this terminal and nowhere else.
// On every other console the command says how that console pairs a device.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISPLAY_NAME } from "../../server/brand.js";
import { DeviceStore } from "../../server/chief/auth.js";
import { BOX_CODE_TTL_MS, firstRunOn, mintBoxCode } from "../../server/chief/firstrun.js";
import { chiefActive, chiefFlag, chiefPaths, chiefUserAuth, resolveChiefDataDir, type Env } from "../../server/chief/paths.js";
import { names } from "../../server/names.mjs";
import { cli } from "../../server/setup/steps.js";
import { humanShell } from "./client.js";
import { parseEnv } from "./env.js";
import { settingsFile } from "../../server/layout.js";

// How this console pairs a device, from its settings and its device list.
//   code      a new install with no paired device: the code of the box
//   more      a device is paired, or an install with the old names: the link from the box
//   telegram  the console pairs through Telegram
//   off       device pairing is off (the Queue is off, or its settings are not complete)
export type PairWay = "code" | "more" | "telegram" | "off";

export async function pairWay(env: Env, n: { legacy: boolean } = names()): Promise<PairWay> {
  if (!chiefFlag(env) || !chiefActive(env)) return "off";
  const userAuth = chiefUserAuth(env);
  if (userAuth === "telegram") return "telegram";
  if (!firstRunOn({ active: true, userAuth }, n)) return "more";
  const devices = await new DeviceStore(chiefPaths(resolveChiefDataDir(env)).devices).list();
  return devices.length === 0 ? "code" : "more";
}

// The settings of the install in `repoDir`: its file, under the env of this shell.
export function installEnv(repoDir: string, env: Env = process.env): Env {
  const path = settingsFile(repoDir);
  return { ...env, ...(existsSync(path) ? Object.fromEntries(parseEnv(readFileSync(path, "utf8"))) : {}) };
}

// The lines a person reads with a new code. The code is on its own line.
export function codeLines(code: string): string {
  return [
    "Pair your first device",
    "",
    `  1. Open ${DISPLAY_NAME} in the browser of that device.`,
    "  2. Type this code:",
    "",
    `       ${code}`,
    "",
    `The code works one time, for ${BOX_CODE_TTL_MS / 60_000} minutes. For a new one: ${cli("pair")}`,
  ].join("\n");
}

export const PAIR_NOT_HUMAN = "pair runs in a human shell only";

type PairDeps = {
  repoDir: string; env?: Env; stderrIsTTY?: boolean; names?: { legacy: boolean };
  out?: (s: string) => void; err?: (s: string) => void;
};

// `pair`. An agent's shell gets no code: a code is for the person at the box.
export async function runPair(d: PairDeps): Promise<number> {
  const out = d.out ?? ((s: string) => console.log(s));
  const err = d.err ?? ((s: string) => console.error(s));
  const shell = d.env ?? process.env;
  if (!humanShell(shell, d.stderrIsTTY ?? process.stderr.isTTY === true)) { err(PAIR_NOT_HUMAN); return 1; }
  const env = installEnv(d.repoDir, shell);
  const way = await pairWay(env, d.names);
  if (way === "off") { err("Device pairing is off on this console."); return 1; }
  if (way === "telegram") { out("This console pairs devices through Telegram. Send /pair and a name for the device in the Master topic."); return 0; }
  if (way === "more") {
    out(`To pair one more device: open ${DISPLAY_NAME} on a paired device, go to Settings, Devices, and press "Add a device".\nOr run: ${cli("brain pair <name>")}\nIt prints a link. Open the link on the device.`);
    return 0;
  }
  const { code } = await mintBoxCode(chiefPaths(resolveChiefDataDir(env)).pairCode);
  out(codeLines(code));
  return 0;
}

// The end of `setup --auto`: the code for the first device, when this console needs one. In a
// shell with no person (an agent, a script with no terminal) it names the command instead.
export async function firstDeviceLines(d: { repoDir: string; env?: Env; stderrIsTTY?: boolean; names?: { legacy: boolean } }): Promise<string | null> {
  const shell = d.env ?? process.env;
  const env = installEnv(d.repoDir, shell);
  if ((await pairWay(env, d.names)) !== "code") return null;
  if (!humanShell(shell, d.stderrIsTTY ?? process.stderr.isTTY === true)) return `To pair your first device, run: ${cli("pair")}`;
  return codeLines((await mintBoxCode(chiefPaths(resolveChiefDataDir(env)).pairCode)).code);
}
