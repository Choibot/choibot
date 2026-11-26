import { getHeapStatistics } from "node:v8";
import { buildCheckSkip, skipLine } from "./server/buildcheck.mjs";
import { buildCommit } from "./server/buildid.mjs";
import { userCli } from "./server/usercli.mjs";

// The build id is the commit that was built (.next/BUILD_ID; chief spec §5.7), so the console
// knows which commit its running build is: the release builder's CHOIBOT_BUILD_COMMIT, the commit
// that `git archive` wrote, or the checkout's HEAD (server/buildid.mjs). None of them: Next's own
// random id, and the console then makes no deploy ticket.

// The deploy runner (server/chief/deploy/runner.mjs) builds into .next-build, never into the
// .next that the running server reads, and puts it in place only while the server is stopped.
// Every other build, `next start`, `pnpm start` and `next dev` use .next.
const deployBuild = process.env.CHOIBOT_DEPLOY_BUILD === "1";

// Next's own type check and lint: off for a deploy build, for the build of an install (setup and
// update), and on a machine with too little memory for them. The rule and its numbers are in
// server/buildcheck.mjs. Next's check worker gets the heap limit of this process.
const checkSkip = buildCheckSkip({ env: process.env, heapLimitMb: getHeapStatistics().heap_size_limit / 2 ** 20 });

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The command that a text of a page names (server/brand.ts USER_CLI): the one that works on
  // this install. The build runs in the install itself, so the value is the install's own.
  env: { NEXT_PUBLIC_USER_CLI: userCli() },
  distDir: deployBuild ? ".next-build" : ".next",
  // The console has no next/image. With the optimizer off, /_next/image is not a route of Next:
  // no caller (server/auth.ts lets every /_next address pass) can make the server fetch a URL.
  images: { unoptimized: true },
  generateBuildId: async () => buildCommit(),
  // A deploy build must skip the check for one more reason: it would see the route types of
  // .next and of .next-build together (TS2428 when the routes change).
  typescript: { ignoreBuildErrors: checkSkip !== null },
  eslint: { ignoreDuringBuilds: checkSkip !== null },
  experimental: {
    // A running server never writes a page it renders into the dist dir (.next/server/route-cache):
    // a server that rendered during an in-place build wrote a page with the old build's asset
    // names there, and the new server served it (incident 2026-11-19). The cache stays in memory.
    isrFlushToDisk: false,
  },
};

/** @type {(phase: string) => import('next').NextConfig} */
export default function nextConfig(phase) {
  // One line per build. Next's workers read this file again, and the server reads it at each start.
  if (checkSkip && phase === "phase-production-build" && process.env.IS_NEXT_WORKER !== "true") console.log(skipLine(checkSkip));
  return config;
}
