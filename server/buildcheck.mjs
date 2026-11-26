// server/buildcheck.mjs — the one rule that says if `next build` runs Next's own type check and
// lint. Plain JS with no import from the repo: next.config.mjs reads it at build time, the CLI
// (bin/lib/steps.ts) sets its switch.
//
// Next's type check is a second copy of `tsc --noEmit -p .` (the same tsconfig, the test files
// too), in a worker with V8's default heap: half of the machine's memory. On a server with 2 GB
// it does not fit: the build of the hosted image died there on 2026-11-25 ("JavaScript heap out
// of memory"). The code of main is type-checked before each merge, and the deploy runner runs
// `tsc --noEmit` itself before its build, so the build of an install does not need this check.
// The repo has no ESLint config: Next's lint checks nothing, but it starts one more process.

/** The switch of the build of an install (setup and update set it on `pnpm build` only). */
export const NO_CHECK_SWITCH = "CHOIBOT_BUILD_NO_CHECK";

/**
 * The smallest V8 heap limit, in MB, with which Next's type check runs. V8 takes half of the
 * memory (of the machine, or of its cgroup), so this is a machine with less than about 4 GB. On
 * a server with 1914 MB the limit is 957 MB (+ 96 MB young space), and today's check needs
 * 952 MB of it (2026-11-25). With 2048 MB the check has twice the room it needs.
 */
export const MIN_CHECK_HEAP_MB = 2048;

/**
 * @typedef {object} CheckSkip
 * @property {"deploy" | "switch" | "heap"} rule the rule that turned the check off
 * @property {string} why the reason, in words, for the build's output
 */

/**
 * Null: Next runs its type check and lint. Else the first rule that turns them off.
 * @param {{ env: Record<string, string | undefined>; heapLimitMb: number }} facts
 * @returns {CheckSkip | null}
 */
export function buildCheckSkip({ env, heapLimitMb }) {
  if (env.CHOIBOT_DEPLOY_BUILD === "1") {
    return { rule: "deploy", why: "this is a deploy build (CHOIBOT_DEPLOY_BUILD=1), and the deploy runner ran tsc --noEmit before it" };
  }
  if (env[NO_CHECK_SWITCH] === "1") {
    return { rule: "switch", why: `${NO_CHECK_SWITCH}=1, the build of an install (setup or update); main is type-checked before each merge` };
  }
  if (heapLimitMb < MIN_CHECK_HEAP_MB) {
    return { rule: "heap", why: `the heap limit of Node is ${Math.round(heapLimitMb)} MB, below ${MIN_CHECK_HEAP_MB} MB (a machine with less than about 4 GB of memory)` };
  }
  return null;
}

/**
 * The line of the build's output: a person who reads the log of a server sees that the skip is
 * on purpose, and which rule did it.
 * @param {CheckSkip} skip
 * @returns {string}
 */
export function skipLine(skip) {
  return `   ○ Next's type check and lint are off on purpose (rule "${skip.rule}"): ${skip.why}.`;
}
