# An agent's `#M-n` reply is a card chip — screenshots

`scripts/manual/smoke/smoke-task-chat-ref.mts` on its 8 cases (desk 1366 / phone 390 × light / dark × English / zh-TW), on the realistic smoke fixture (`scripts/manual/smoke-fixture/`), signed in through the real `/signin`; the delivery to the agent is stubbed. Each shot is the chat after a person sent `#M-1` and `#S-1` and the agent replied with `#M-1`, `#S-1`, `#M-99` (no such card) and `#M-1` in a code span.

- `before/` — upstream `release/2.3.5-alpha` (`a7fc14bc3`): the person's numbers are chips; the agent's reply stays text.
- `after/` — this branch: the agent's `#M-1` and `#S-1` are chips too; `#M-99` and the number in code stay text.

`SHA256SUMS` lists the files.
