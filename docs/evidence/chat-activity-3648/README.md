# Chat activity block (#3648): screenshots and the thinking-summaries cost measurement

Taken on **PR2 `131d263aa`** (it contains PR1 `caf059b3f`), i.e. the AGEND-200 layout. They replace the first set on
branch `docs/chat-activity-197-evidence`, which showed the layout from before AGEND-200.

`<viewport>-<theme>-<language>-<state>.png` — the real dashboard (real server, real thread, real styles). Only `GET /ui/steps`
is answered by `shots.mts`, with the shapes and the server-side cut (`chatStep`) the product sends; nothing is injected into
the page. The instance in the shots is not running, so the header's status word is replaced by "Working" in the harness
(as the #3639 mockups did).

## Main set — Claude Code, 8 sets (desktop / phone × light / dark × EN / 繁中), 4 states each (32 files)

States: `0-before` the thread without the block (how it was) · `1-running-collapsed-and-finished` a finished turn's one line
above its reply, and a running turn shut to one live line · `2-running-expanded` the running turn opened (`standard`) ·
`3-verbose-expanded` the same with `tool_progress: verbose` (commands, and Show output).

## agy / grok set — PR2 (12 files)

`agy-…` and `grok-…`, desktop + phone, light, EN. `shots-agy-grok.mts` feeds the **real redacted interactive captures**
(`tests/fixtures/chat-activity-3648/{agy,grok}-web-chat.jsonl` and their ledgers) through the real `AntigravityStepParser` /
`GrokStepParser` and `chatStep`; three finished turns, one block above each reply. States: `1-standard-collapsed`,
`2-standard-opened`, `3-verbose-opened` (every block opened). What differs from the Claude Code set is only the steps
themselves: agy's `run_command` / `read_file` rows, grok's tool-search row and a **failed** read (red icon, "failed · 228 ms").

`thinking-summaries-cost.md` — usage in the transcripts of interactive Claude Code runs with `showThinkingSummaries` off / on.

Regenerate (the scripts import `../AgEnD/src/…`, so run them from a checkout in a directory named `AgEnD`, scripts one level up):
`OUT=<dir> npx tsx ../shots.mts` and `BACKEND=antigravity|grok OUT=<dir> npx tsx ../shots-agy-grok.mts` (need playwright-core
and a Chromium).
