// src/components/AgentTerminal.tsx
"use client";
import { XtermTerminal } from "./XtermTerminal";
import { AgentComposer } from "./Composer";
import s from "./Composer.module.css";

// The agent's terminal with the composer below it (spec 2026-11-05-agent-composer).
export function AgentTerminal({ agentId }: { agentId: string }) {
  return (
    <div className={`${s.col} composerCol`}>
      <XtermTerminal
        wsPath={`/api/agents/${agentId}/terminal`}
        uploadPath={`/api/agents/${agentId}/upload`}
        keepKey={agentId}
      />
      <AgentComposer agentId={agentId} />
    </div>
  );
}
