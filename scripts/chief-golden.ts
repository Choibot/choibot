// One-shot generator for server/chief/testdata/golden/*: pins today's (flag-off)
// prompts and claude argv. Run once, before any chief code change.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentPrompt, buildClaudeArgs } from "../server/agents/argv.js";
import { fleetMasterSystemPrompt } from "../server/master/prompt.js";

const dir = join(import.meta.dirname, "..", "server", "chief", "testdata", "golden");
if (existsSync(dir)) {
  console.error(`${dir} already exists; refusing to overwrite`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const REC = { id: "11111111-2222-3333-4444-555555555555", repo: "/ws/app-shop" };
const files: Record<string, string> = {
  "agent-prompt-worker.txt": agentPrompt(REC, "/widgets"),
  "agent-prompt-issue.txt": agentPrompt({ ...REC, kind: "issue" }, "/widgets"),
  "agent-prompt-workspace.txt": agentPrompt({ ...REC, repo: "" }, "/widgets"),
  "fleet-master-prompt.txt": fleetMasterSystemPrompt({
    repoDir: "/repo", masterDataDir: "/data/master", claudeBin: "/bin/claude", cronDataDir: "/data/cron", timeZone: "UTC",
  }),
  "claude-args.json":
    JSON.stringify(
      {
        full: buildClaudeArgs({ systemPrompt: "SP" }, { settingsPath: "/s.json", resume: "sid-1", prompt: "go" }),
        bare: buildClaudeArgs({}, {}),
      },
      null,
      2,
    ) + "\n",
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
