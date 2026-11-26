// scripts/build-memory/preload.cjs — loaded into each Node process of a measured run
// (NODE_OPTIONS=--require). Two things:
//   - the server has 1 vCPU: os.cpus() gives 1 CPU, as Next sizes its workers from it;
//   - the heap peak of the process (v8 used_heap_size, MB) and its heap limit (heap_size_limit,
//     MB): one file per pid in BUILD_MEMORY_HEAP_DIR, line "<peak> <limit> <command>". A timer
//     cannot see a long synchronous task (Next's type check blocks its worker for 30 s), so V8's
//     own GC trace is on too: run.sh reads the heap of each GC in the step's log.
const os = require("node:os");
const first = os.cpus().slice(0, 1);
os.cpus = () => first;
os.availableParallelism = () => 1;

const dir = process.env.BUILD_MEMORY_HEAP_DIR;
if (dir) {
  const v8 = require("node:v8");
  // Not allowed in NODE_OPTIONS, but V8 takes it at run time.
  v8.setFlagsFromString("--trace-gc");
  const fs = require("node:fs");
  const path = require("node:path");
  const file = path.join(dir, String(process.pid));
  const command = process.argv.slice(1).map((a) => path.basename(a)).join(" ").slice(0, 100);
  let peak = 0;
  const tick = () => {
    const s = v8.getHeapStatistics();
    if (s.used_heap_size <= peak) return;
    peak = s.used_heap_size;
    try { fs.writeFileSync(file, `${(peak / 2 ** 20).toFixed(1)} ${(s.heap_size_limit / 2 ** 20).toFixed(0)} ${command}\n`); } catch { /* the run goes on */ }
  };
  setInterval(tick, 200).unref();
  process.on("exit", tick);
}
