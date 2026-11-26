// src/components/CiBadge.tsx
"use client";
import { useEffect, useState } from "react";
import { fetchAgentChecks, fetchRepoChecks, ciLabel, type PrStatus } from "../lib/gh";
import s from "./CiBadge.module.css";

// Polls PR status every 15s while the PR is open. Pass either an agentId (the
// PR an agent opened) or a repo+pr (a PR under review).
export function CiBadge({ agentId, repo, pr }: { agentId?: string; repo?: string; pr?: number }) {
  const [status, setStatus] = useState<PrStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      (agentId ? fetchAgentChecks(agentId) : repo && pr ? fetchRepoChecks(repo, pr) : Promise.resolve(null))
        .then((r) => { if (alive) setStatus(r); });
    void load();
    const t = setInterval(() => { if (status?.prState && status.prState !== "OPEN") return; void load(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [agentId, repo, pr, status?.prState]);

  if (!status || status.pr === null) return null;
  const roll = status.checks?.rollup ?? "none";
  return (
    <a className={`${s.badge} ${s[roll]}`} href={status.url} target="_blank" rel="noreferrer" title="CI / PR status (updates every 15s)">
      {ciLabel(status).replace(/^[✓✗●] /, "")}
    </a>
  );
}
