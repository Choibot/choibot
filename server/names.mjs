// server/names.mjs — the technical names of this install: the systemd unit, the data dir, the
// env keys, the per-repo folder and the dtach sockets. Plain JS with no imports from the repo:
// the server, the CLI and the plain-JS cron runner all read it. Not for the browser.
//
// One table: every install has these names. The console gives them to its agents through their
// env, so the CLI in an agent reads the same keys.
//
// OLD_NAMES is the same table under a second name, and envKeys gives a list of one key: code that
// reads "a name and its other spelling" reads one name.

/**
 * @typedef {object} Names
 * @property {boolean} legacy always false: no install keeps other names
 * @property {string} unit the systemd user unit the console runs in
 * @property {string} cronUnitPrefix a cron job's units: <prefix><job>.service and .timer
 * @property {string} dataDir the data dir name under $XDG_DATA_HOME (default ~/.local/share)
 * @property {string} configDir the dir name under ~/.config (the user token file)
 * @property {string} envPrefix the prefix of the env keys the console gives its agents
 * @property {string} repoFolder the per-repo folder (docs.json, previews, uploads, codex-home)
 * @property {string} hooksFile the hook settings file in a worktree
 * @property {string} agentsFolder the folder in the workspace dir for agents with no repo
 * @property {string} dtachPrefix an agent's socket: <prefix><id>.sock
 * @property {string} dtachDir the default socket dir name in the tmp dir
 * @property {string} cliEntry the CLI file from the repo root, as the agents' prompts print it
 */

/** @type {Readonly<Names>} */
export const NEW_NAMES = Object.freeze({
  legacy: false,
  unit: "choibot.service",
  cronUnitPrefix: "choibot-cron-",
  dataDir: "choibot",
  configDir: "choibot",
  envPrefix: "CHOIBOT_",
  repoFolder: ".choibot",
  hooksFile: ".choibot-hooks.json",
  agentsFolder: ".choibot-agents",
  dtachPrefix: "choibot-",
  dtachDir: "choibot-dtach",
  cliEntry: "bin/choibot.ts",
});

/** @type {Readonly<Names>} */
export const OLD_NAMES = NEW_NAMES;

/**
 * The facts of an install with other names: none, whatever the env and the files.
 * @param {Record<string, string | undefined>} [_env]
 * @param {(path: string) => boolean} [_exists]
 * @returns {string[]}
 */
export function legacyMarkers(_env, _exists) {
  return [];
}

/**
 * The names of an install.
 * @param {readonly string[]} [_markers]
 * @returns {Readonly<Names>}
 */
export function resolveNames(_markers) {
  return NEW_NAMES;
}

const decided = Object.freeze({ names: NEW_NAMES, markers: Object.freeze([]) });

/** The decision of this process and the markers behind it. */
export function namesDecision() {
  return decided;
}

/**
 * The names of this install.
 * @returns {Readonly<Names>}
 */
export function names() {
  return NEW_NAMES;
}

/**
 * The env key of `name` (AGENT_ID, AGENT_PASS, WIDGET_DIR, CRON_SPOOL, USER_TOKEN): CHOIBOT_<name>.
 * @param {string} name
 * @param {Readonly<Names>} [n]
 */
export function envKey(name, n = names()) {
  return `${n.envPrefix}${name}`;
}

/**
 * Every spelling of the key of `name`: one (see the head of this file).
 * @param {string} name
 * @returns {string[]}
 */
export function envKeys(name) {
  return [`${NEW_NAMES.envPrefix}${name}`];
}

/**
 * READ a key the console gave (or a person set).
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
export function envRead(env, name) {
  return env[`${NEW_NAMES.envPrefix}${name}`];
}

/**
 * The per-repo folders to READ from.
 * @param {Readonly<Names>} [n]
 * @returns {string[]}
 */
export function repoFoldersToRead(n = names()) {
  return [n.repoFolder];
}
