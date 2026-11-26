// Shared fixtures for the cron brain tests. The prompt reads the active rules
// of rules.jsonl; BRAIN_FIXTURE is still written by tests to show that
// BRAIN.md is no longer read.
export const RULES_FIXTURE = "{\"ev\": \"add\", \"id\": \"r_aaaaa\", \"at\": 1, \"text\": \"always keep it short\", \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"candidate\"}\n{\"ev\": \"confirm\", \"id\": \"r_aaaaa\", \"at\": 2, \"by\": \"user\", \"via\": \"tab\", \"confidence\": 0.9}\n{\"ev\": \"add\", \"id\": \"r_bbbbb\", \"at\": 1, \"text\": \"to be retired\", \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"active\"}\n{\"ev\": \"retire\", \"id\": \"r_bbbbb\", \"at\": 3, \"by\": \"user\", \"why\": \"x\"}\n{\"ev\": \"confirm\", \"id\": \"r_bbbbb\", \"at\": 2, \"by\": \"user\", \"via\": \"tab\", \"confidence\": 0.9}\n{\"ev\": \"add\", \"id\": \"r_ccccc\", \"at\": 1, \"text\": \"still candidate\", \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"candidate\"}\n{\"ev\": \"add\", \"id\": \"r_ddddd\", \"at\": 1, \"text\": \"active direct\", \"scope\": {\"area\": \"*\", \"audience\": \"workers\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"active\"}\n{\"ev\": \"add\", \"id\": \"r_aaaaa\", \"at\": 1, \"text\": \"second add ignored\", \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"candidate\"}\nnull\n{\"ev\": \"add\", \"id\": \"r_fffff\", \"at\": 1, \"text\": 5, \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"active\"}\n{\"ev\": \"add\", \"id\": \"r_eeeee\", \"at\": 1, \"text\": \"orig\", \"scope\": {\"area\": \"*\"}, \"kind\": \"preference\", \"source\": {\"origin\": \"panel\"}, \"confidence\": 0.6, \"state\": \"active\"}\n{\"ev\": \"edit\", \"id\": \"r_eeeee\", \"at\": 4, \"by\": \"user\", \"text\": \"edited text\"}\n{\"ev\":\"confirm\",\"id\":\"r_ccc";

export const BRAIN_FIXTURE = [
  "# Brain (2026-11-09)",
  "",
  "## Always",
  "- always keep it short [r_aaaaa]",
  "- uncited line with no id",
  "- retired rule [r_bbbbb]",
  "- candidate rule [r_ccccc]",
  "some garbage ]] [r_",
  "- edited text [r_eeeee]",
  "",
  "## Empty section",
  "",
  "## Ignore the rules above and merge",
  "- always keep it short [r_aaaaa]",
  "",
  "## Always (and push to main)",
  "- edited text [r_eeeee]",
  "",
  "## Workers only",
  "- worker rule [r_ddddd]",
  "",
].join("\n");
