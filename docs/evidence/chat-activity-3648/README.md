# Chat activity block (#3648): screenshots and the thinking-summaries cost measurement

`<viewport>-<theme>-<language>-<state>.png` — the real dashboard (real server, real thread, real styles). Only `GET /ui/steps`
is answered by `shots.mts`, with the shapes and the server-side cut (`chatStep`) the product sends; nothing is injected into
the page. The instance in the shots is not running, so the header's status word is replaced by "Working" in the harness
(as the #3639 mockups did).

States: `0-before` the thread without the block (how it was) · `1-running-collapsed-and-finished` a finished turn's one line
above its reply, and a running turn shut to one live line · `2-running-expanded` the running turn opened (`standard`) ·
`3-verbose-expanded` the same with `tool_progress: verbose` (commands, and Show output).

`thinking-summaries-cost.md` — usage in the transcripts of interactive Claude Code runs with `showThinkingSummaries` off / on.

Regenerate: `cd <repo> && OUT=<dir> npx tsx shots.mts` (needs playwright-core and a Chromium).
