# Headless worker test data

`stream-2.1.332.txt` — JSON lines (a .txt file: the public copy takes no .jsonl) of the output
stream of `claude -p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages`, Claude Code 2.1.332. The parser (`server/agents/headless/stream.ts`)
reads 5 kinds (init, ack, lifecycle, result, control) and skips the rest.

**Source: captured 2026-11-27.** One run of the real `claude` (model haiku, a subscription login,
a scratch folder, no console), with 6 inputs:

1. a message that runs a tool (`sleep 8; echo tick`);
2. a second message, sent during that tool call;
3. a message that runs a long tool, ended by an interrupt (`control_request`, subtype interrupt);
4. `/model haiku`;
5. `/compact`;
6. a last message, then the end of the input (a normal end, exit 0).

Every line is there, in order, with all its keys. Cut values only: in `system/init`,
`mcp_servers`, `slash_commands`, `skills`, `plugins`, `agents`, `memory_paths` and
`messaging_socket_path` (they name the machine); the output of each hook; the text of the
`/compact` summary; the work folder is `/home/user/project`.

What the run showed (the host and the fake depend on it):

- A replay (`isReplay: true`) has the `uuid` of our input line, also for a local command:
  `/model haiku` comes back as
  `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>`,
  a string, with our uuid. The stdout of a local command (`<local-command-stdout>Compacted
  </local-command-stdout>`) is a replay with a new uuid.
- `system/init` comes before each turn, also of a local command; its `user_message_uuids` holds
  our uuid.
- A message that comes during a tool call joins the turn: one result, `num_turns` 2, the text of
  the last reply.
- An interrupt: `control_response` (success, `still_queued`), then the user line
  `[Request interrupted by user]` (no replay), then a result `error_during_execution` with
  `is_error: true` and no `result` key.
- `/model`: init, the assistant text "Set model to `Haiku 5.5` for this session only", the replay,
  a result `success` with the same text and `num_turns` 0.
- `/compact`: status "compacting", the hooks, status null, init, `compact_boundary`, a synthetic
  user line (`isSynthetic: true`, `isReplay: false`), a synthetic assistant line (the last
  text again), the stdout replay, the `/compact` replay, a result `success` with "" and
  `num_turns` 0.
- `command_lifecycle` lines: `{type, command_uuid, state, uuid, session_id}`, with our uuid as
  `command_uuid` and the states queued, started, completed and cancelled. A message that joined
  a turn is completed before the result; the turn's own input after it. An interrupt: the
  result, then cancelled. A local command: the result, then completed.
- In a `result` line, `type` is not the first key.

`stream-2.1.332-commands.txt` — **captured 2026-11-27**, a second run of the same `claude`
(same limits), with 4 inputs: `/clear`, `/nosuchcmd now` (an unknown command), `/tmp/x is full`
(a text that starts with "/"), and `Reply with the single word END.`, then the end of the input.
Every line is there, in order, with all its keys. Cut values only: the same lists of
`system/init`, the output of each hook, each thinking signature, and in the turn of
`/tmp/x is full` the tool inputs (also `wire_tool_inputs`), the tool results
(`tool_use_result` too) and the texts that name `/tmp/x` (the model looked at files of the
machine); the work folder is `/home/user/project`.

What the run showed:

- Each of the 4 inputs got its replay with our uuid, then its result, then `completed`.
- `/clear`: queued, started, a `conversation_reset` line (`trigger: "clear"`,
  `user_message_uuid` = our uuid, `new_conversation_id`), the hooks, init with a new session
  id (not the `new_conversation_id`; the session id of the later lines), the replay `<command-name>/clear</command-name>…`, a result `success` with "" and
  `num_turns` 0, completed.
- `/nosuchcmd now` is not a local command: the replay is the text as typed, and it goes to the
  model (`num_turns` 1).
- `/tmp/x is full` is a normal message (the model ran 2 Bash calls; `num_turns` 3).

So in 2.1.332 each input gets a replay; the host also closes an entry at the end of its
`command_lifecycle`, for an input that gets none.

`fake-stream-claude.mjs` — a fake `claude -p` that writes lines of the same shape (its header
says what it does, and what is a guess). The host tests run it in a real systemd user scope.
