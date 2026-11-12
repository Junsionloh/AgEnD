# grok live line (Reasoning… / Running a tool…) — before / after screenshots

The **real dashboard** (the product's own `FleetManager` serves the page and the seeded chat history), a grok instance working
on a turn:

- `reasoning`: the transcript has only the prompt (grok writes a thought when it ends); grok's `events.jsonl` says it is reasoning.
- `tool`: one call is done, the next is running; `events.jsonl` says `tool`.

**before** = the page with the live line from #3738 and the grok transcript from #3710 (`667dd1ba9`): "Working…" / the newest
step. **after** = `b20264506` (the phase change on top of it): "Reasoning…" / "Running a tool…".

`<viewport>-<theme>-<language>-<before|after>-<reasoning|tool>.png`; 2 viewports × light/dark × EN/繁中 = 8 sets.

Scripted (a harness, not the product): `GET /ui/steps` answers the finished first turn and the second turn's steps through the
server's own `chatStep` cut, with `phase` in the answer for **after** (the real route reads it from `events.jsonl`, covered by
the PR's tests); the agent is made "working" by the SSE `activity` event the daemon sends on a transition; the header's
"stopped" is replaced by "working" because the shot instance is not running.

Regenerate: `VARIANT=before|after STATE=reasoning|tool OUT=<dir> npx tsx ../scripts/shots-grok-phase.mts` from a checkout in a
directory named `AgEnD`, the script in a sibling `scripts/` directory (needs playwright-core and a Chromium).
