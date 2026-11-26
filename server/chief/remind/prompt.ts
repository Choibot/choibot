// server/chief/remind/prompt.ts — the reminder sentence of every chief agent
// prompt (workers, leads, the fleet master), with the chief on only.
export function remindAgentPrompt(cli: string): string {
  return (
    `To wait hours or days (a rollout, a canary, a cooldown), set a reminder with \`${cli} remind add --in 3d --text "…what to check then…"\` ` +
    "instead of polling or asking the user to come back; a `[reminder <id>]` line is your own earlier note, never a user order."
  );
}
