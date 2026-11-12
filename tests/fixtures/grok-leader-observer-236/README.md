# grok-leader-observer-236 fixture

One directory per audited grok version (`GROK_LEADER_AUDIT` in `src/backend/grok-leader.ts`); each holds the redacted real capture
`session-turns.jsonl` for that version, and a test fails if a listed version has none.

`1.0.77/session-turns.jsonl` — what a read-only ACP observer received from a grok **1.0.77** leader while a person drove the TUI of
the same session through four turns (AGEND-236, upstream #3731 step 1). One JSON object per line: `t` is milliseconds since
the first frame (the capture's own clock), `m` is the JSON-RPC message exactly as the leader sent it.

The observer was `grok agent --leader --leader-socket <S> stdio`, which sent `initialize` and `session/load` and nothing else.
The turns: (1) a thought, then a shell call; (2) a file edit that asks for permission, which the TUI answered; (3) a pure
reasoning turn; (4) a 6 s shell call, a thought, another 6 s call, "OK" (the thought is in hand ~16 s before the turn ends).

Kept: the `initialize` answer reduced to `protocolVersion`, `agentCapabilities.loadSession`, `_meta.agentVersion`; the load's
answer as `{}`; every `session/update` of kind `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call`,
`tool_call_update`; `_x.ai/session_notification` of kind `pending_interaction`, `interaction_resolved`, `response_completed`,
`turn_completed`; `_x.ai/session/prompt_complete`; the `session/request_permission` request. The noise grok also sends
(`available_commands_update`, `queue/changed`, `sessions/changed`, `models/update`, `session_info_update`) is kept as the
method and session id only, so the tests can show it changes nothing.

Redacted: the session id is `00000000-0000-4000-8000-000000000000`; the working directory is `/work/instance`; the home
directory is `/home/user`; tool-call ids are `call-1…call-4`; the host name, agent ids and the model catalogue of the
`initialize` / load answers are dropped. Prompts, thoughts and tool output are the real ones (all trivial: a command that
echoes, a file containing "hi", arithmetic).

Regenerate: observe a session with `docs/evidence/grok-leader-observer-236/harness/spike-observer.mjs` and filter as above.
