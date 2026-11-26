// server/usercli.mjs — how the user of THIS install types the command of the CLI. Plain JS with
// no import from the repo: next.config.mjs reads it at build time, the server at its start.
//
// Two kinds of install:
//   - the install line made it (install.sh): the code is in <base>/app, next to the marker file
//     and the command that the script wrote, and the script linked that command into the
//     user's own bin folder. The user types `choibot <command>`.
//   - every other install (a clone by hand, an install made before the install line): the user
//     types `pnpm choibot <command>` in the folder of the console, as before.
// A page or a text that says "run … on your server" must name the command that works there.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// server/brand.ts CLI_NAME (usercli.test.ts holds them equal).
const CLI = "choibot";

/**
 * @param {string} [appDir] the folder of the console's code
 * @param {(path: string) => boolean} [exists]
 * @returns {string}
 */
export function userCli(appDir = process.cwd(), exists = existsSync) {
  const base = dirname(appDir);
  return exists(join(base, `.installed-by-${CLI}`)) && exists(join(base, "bin", CLI)) ? CLI : `pnpm ${CLI}`;
}
