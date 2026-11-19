# AGEND-316: the task board's cards, the list's width and the card page's activity — screenshots

`scripts/manual/smoke/smoke-316-board-cards.mts` on its 8 cases (desk 1470 / phone 390 × light / dark × English / zh-TW), on the realistic smoke fixture (`scripts/manual/smoke-fixture/`), signed in through the real `/signin`; a board with a card in each state (nothing but a title; sub tasks with progress; a sub task running; the next one to start; waiting for the person; blocked with a short and a long reason; done; a 100-character title; priority and size set and not).

- `before/` — `integration/tasks-revamp` at `5c8df3020` (the same seed, `SHOTS_ONLY=1`; the checks that name the new behaviour fail there, see `measures.json`).
- `after/` — PR #99 at `ebb3cec04`: `1-board` (the board, desk at 1470 px; `-1366` / `-1440` / `-1920` the same board at those widths), `2-running` (the running cards: the "Running" mark; no moving light), `3-owner-picker`, `4-owner-info`, `5-list` / `5-list-owner-picker`, `6-card-activity` (the card page scrolled to its activity panel) and `6-card-activity-panel` (the panel alone), `7-list-1366` / `-1440` / `-1920` (the project's list at those widths: the page as wide as the board's, the title column taking the extra width) and, on a phone, `7-list` (unchanged); phone: `1-board-tab0/1` (one status at a time). `measures.json` has what the page laid out (`list`: the page's margins and each column's width at every width) and every check.

`SHA256SUMS` lists the files.
