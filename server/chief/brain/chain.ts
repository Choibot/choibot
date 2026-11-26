// The one onChain key that serializes every write of the proposal and the
// brain files of one chief dir (distill's proposal write, apply, discard,
// rollback). A module of its own: apply.ts imports distill.ts.
import type { ChiefPaths } from "../paths.js";

export const brainChainKey = (p: ChiefPaths): string => `chief-brain:${p.brainDir}`;
