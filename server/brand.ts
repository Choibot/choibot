// server/brand.ts — the names people see and type. Pure constants with no imports: the browser
// bundle imports this file too. The technical names of an install (unit, data dir, env keys,
// repo folder, sockets) are in server/names.mjs: an install made before the rename keeps its
// old ones.

// The name people see (page title, sidebar, server banner, help and message texts).
export const DISPLAY_NAME = "ChoiBot";
// The command of the CLI in help and hint texts: `pnpm choibot <command>` (bin/choibot.ts).
// `pnpm choi` is the short form.
export const CLI_NAME = "choibot";
export const CLI_SHORT_NAME = "choi";
// How the user of THIS install types the command, for a text of a page that says "run … on your
// server": `choibot` on an install that the install line made, `pnpm choibot` on every other
// one (server/usercli.mjs decides). The build of the pages puts the value in
// (next.config.mjs); a process that is not a page has none and keeps the old form. The server's
// own texts use cli() of server/setup/steps.ts.
export const USER_CLI: string = process.env.NEXT_PUBLIC_USER_CLI || `pnpm ${CLI_NAME}`;
