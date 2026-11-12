# Chat activity block (#3648) — captures on head `6aaf195c0`, with receipts (AGEND-214, review of upstream PR #3709, item 7)

This set **replaces** the first one in `../chat-activity-3648/` (kept untouched, with its real pins: it was shot on PR2
`131d263aa`, whose PR1 ancestor is `caf059b3f`; it does not contain the head Prism reviewed `b0feba52f`, and its "before"
was the candidate UI with `/ui/steps` answered 404). Nothing there is relabelled.

| | |
|---|---|
| head (this set) | `6aaf195c0936d90b88b38b0e684c996c1a181a6a` — `feat/chat-activity-timeline-alpha`, the head #3709 shows |
| base ("before") | `c1cfcfe03c6a54f989b4ae8467ceadf22f57fe46` — the real product before the PR: no block code, no `/ui/steps` route |
| fixture | `tests/fixtures/chat-activity-3648/claude-web-chat.{jsonl,ledger.json}` — the real redacted Claude Code capture (sha256 in the receipt) |

Files: `after/` (24: 8 sets × 3 states), `before/` (8), `skew/` (32: 8 retained-file cases × chat/Log × 2 views),
`capture-receipt.json`, `skew-receipt.json`, `shots.mts` (the harness).

## What is real

The product's own `FleetManager` serves the page; an admin signs in with a real dashboard code. `GET /ui/steps` is **not
stubbed**: the real route (admission, re-check after the read), the real `LogService` and parser and the server-side cut
answer it from a scratch copy of the redacted transcript. The harness changes only: all timestamps by one constant (so the
running turn is "now"); the running scenes cut the transcript before turn 2's reply result (the reply call is in; its
result, the closing `.` and the turn end are not; the ledger lacks turn 2's reply row); and the header's "Stopped" is
edited to "Working" (the shot instance is not running). Emoji in text show as a missing-glyph box: no emoji font here.

States: `0-before` · `1-running-collapsed-and-finished` (turn 1's one line above its reply, turn 2's live line, both shut)
· `2-running-expanded` (`standard`) · `3-verbose-expanded` (`verbose`).

## Receipts

`capture-receipt.json`: pins; for every capture, the sha256 of each `/ui/js/*.js` and `/assets/*.js|css` response body as
the browser received it, compared with the file at the pinned commit — **136 files at the head, 133 at the base, 0
mismatches**; per scene: blocks drawn, steps, composer present, page errors (only the sign-in page's own 401 on
`/auth/session`), `/ui/steps` statuses (200 after; none before).

`skew-receipt.json`: real Chrome against the head's server while the browser **retains older files** — each case serves the
named paths from an older checkout and hashes the bytes returned: old `app-i18n.js` / `app-shell.js` / `app-ctx.js` (byte-equal
to the head's: unchanged by the PR), old `chat-thread.js`, old `app.css`, old `panel-log.js` (the Log module from before
`log-row.js`), old `panel-chat.js` (all from the base), the previous head's activity modules, and `log-row.js` missing (404).
Each is read on the chat page and on the Log tab. Result: 7 of 8 keep the composer and the Log rows and raise no page
error (old thread/panel: the block is just not drawn; old CSS: drawn unstyled but readable and openable). **The 8th fails and
is disclosed**: with `log-row.js` at 404 neither the chat page nor the Log tab draws (static import, as every shared module).

Regenerate (run from a checkout; playwright-core and a Chromium needed):
`MODE=shots LABEL=after|before REPO=<checkout> [FIXREPO=<head>] OUT=<dir> CHROME=<bin> npx tsx shots.mts` and
`MODE=skew REPO=<head> BASE=<base> PREV=<previous head> OUT=<dir> CHROME=<bin> npx tsx shots.mts`.
