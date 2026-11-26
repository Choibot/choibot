// server/chief/deploy/boot.ts — builds the DeployService from the server's own boot facts
// (spec §5.7). index.ts calls it only with the chief flag on; with the flag off nothing here
// runs and no deploy route exists.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChiefCore } from "../boot.js";
import { checkUrlOf, deployUnit, ownUnit, pnpmArgv, readBuildCommit, type Armed } from "./config.js";
import { deployGit } from "./git.js";
import { installKind, type InstallKind } from "../../release.js";
import { DeployService, systemdLaunch, systemdRunnerAlive } from "./service.js";

type Env = Record<string, string | undefined>;

// The checks that turn deploy on, in order. Each one that fails leaves the console exactly as it
// was: no ticket, and POST /api/deploy answers 503 with the reason. Deploy is for a git checkout
// only: a release or an archive install gets its new code another way (server/release.ts).
export async function armedFor(core: Pick<ChiefCore, "active">, unit: string, dev: boolean, o: {
  kind: InstallKind; own?: (unit: string) => Promise<Armed>;
}): Promise<Armed> {
  if (!core.active) return { ok: false, why: "the chief is misconfigured" };
  if (dev) return { ok: false, why: "this console is a dev server, not a production build" };
  if (o.kind === "release") return { ok: false, why: "this console runs a release: it gets new code from a release, not from git" };
  if (o.kind === "archive") return { ok: false, why: "this console was installed from an archive file: it has no git checkout" };
  return (o.own ?? ownUnit)(unit);
}

export async function makeDeployService(core: Pick<ChiefCore, "active" | "queue" | "paths">, o: {
  dev: boolean; dir?: string; env?: Env; log?: (s: string) => void;
}): Promise<DeployService> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((s: string) => console.warn(s));
  // The console's own checkout: the directory it runs from (the unit's WorkingDirectory).
  const dir = o.dir ?? process.cwd();
  const unit = deployUnit(env);
  const armed = await armedFor(core, unit, o.dev, { kind: installKind(dir) });
  const git = deployGit(dir);
  // Read once, now: HEAD can move while the console runs, and the build can be replaced on disk.
  const head = armed.ok ? await git.head().catch(() => null) : null;
  const build = armed.ok ? await readBuildCommit(dir) : null;
  if (armed.ok) log(`[deploy] on: unit ${unit}, checkout ${dir}, build ${build ?? "unknown"}, boot ${head ?? "unknown"}`);
  else if (core.active && !o.dev) log(`[deploy] off: ${armed.why}`);
  const deployDir = core.paths.deployDir;
  return new DeployService({
    store: core.queue, dir, unit, armed,
    boot: { head, build, at: Date.now() - Math.round(process.uptime() * 1000) },
    git, stateFile: join(deployDir, "state.json"), logDir: deployDir, pnpm: pnpmArgv(env), checkUrl: checkUrlOf(env),
    launch: systemdLaunch({ unit, runner: join(dirname(fileURLToPath(import.meta.url)), "runner.mjs") }),
    runnerAlive: systemdRunnerAlive(unit), log,
  });
}
