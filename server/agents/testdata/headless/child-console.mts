// server/agents/testdata/headless/child-console.mts — a console in its own process, for the host
// tests: it starts a worker with the fake stream claude, sends one message, writes "ready" when
// Claude took it, and stays until it is killed.
//   node --import tsx child-console.mts <runDir> <stateDir> <unitPrefix> <id> <cwd> <fakeLog>
import { fileURLToPath } from "node:url";
import { HeadlessHost } from "../../headless/host.js";

const [runDir, stateDir, unitPrefix, id, cwd, fakeLog] = process.argv.slice(2) as [string, string, string, string, string, string];
const FAKE = fileURLToPath(new URL("./fake-stream-claude.mjs", import.meta.url));
const h = new HeadlessHost({
  runDir, stateDir, unitPrefix, tickMs: 30,
  onEvent: (_id, e) => { if (e.kind === "ack") process.stdout.write("ready\n"); },
});
const r = await h.spawn({ id, cwd, command: process.execPath, args: [FAKE], env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_LOG: fakeLog } });
if (!r.ok) {
  process.stdout.write(`failed: ${r.why}\n`);
  process.exit(1);
}
await h.send(id, "[fake sleep=1500] from the child console");
setInterval(() => {}, 1 << 30);
