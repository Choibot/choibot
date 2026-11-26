// src/components/ServiceTerminal.tsx
"use client";
import { XtermTerminal } from "./XtermTerminal";

// Read-only live log pane for a managed service. Reuses the agent/shell xterm
// host but in read-only mode — output + scrollback only, no stdin (logs are
// read-only in v1). The server WS also ignores input, so this is enforced on
// both ends.
export function ServiceTerminal({ serviceId }: { serviceId: string }) {
  return <XtermTerminal wsPath={`/api/services/${serviceId}/terminal`} readOnly />;
}
