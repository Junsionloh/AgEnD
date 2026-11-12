# Chat live activity line — before / after screenshots

Taken on the **real dashboard** (the product's own `FleetManager` serves the page and the seeded chat history): a Claude Code
instance working on a turn whose transcript has only its prompt so far — the state a long thought leaves, because the CLI
writes a thought to its transcript when it ends.

- **before**: upstream `release/2.3.5-alpha` at `7ff12ade0` — the thread shows no block for the turn in progress.
- **after**: `23332c273` (the live-line change on top of `7ff12ade0`) — the turn has a live line, shut and opened.

`<viewport>-<theme>-<language>-<before|after>-working-no-step[-opened].png`; 2 viewports × light/dark × EN/繁中 = 8 sets.

What is scripted (a harness, not the product): `GET /ui/steps` answers the finished first turn and the second turn's prompt only
(through the server's own `chatStep` cut); the agent is made "working" by the SSE `activity` event the daemon sends on a state
transition; the header's "stopped" word is replaced by "working" because the instance in the shot is not running.

Regenerate: `VARIANT=before|after OUT=<dir> npx tsx ../scripts/shots-live.mts` from a checkout in a directory named `AgEnD`,
with the script in a sibling `scripts/` directory (needs playwright-core and a Chromium).
