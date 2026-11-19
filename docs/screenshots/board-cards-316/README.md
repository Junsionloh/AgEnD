# AGEND-316: the task board's cards — screenshots

`scripts/manual/smoke/smoke-316-board-cards.mts` on its 8 cases (desk 1470 / phone 390 × light / dark × English / zh-TW), on the realistic smoke fixture (`scripts/manual/smoke-fixture/`), signed in through the real `/signin`; a board with a card in each state (nothing but a title; sub tasks with progress; a sub task running; the next one to start; waiting for the person; blocked with a short and a long reason; done; a 100-character title; priority and size set and not).

- `before/` — `integration/tasks-revamp` at `5c8df3020` (the same seed, `SHOTS_ONLY=1`; the checks that name the new behaviour fail there, see `measures.json`).
- `after/` — this branch: `1-board` (the board, desk at 1470 px; `-1366` / `-1440` / `-1920` the same board at those widths), `2-running` (the running cards; `2-running-reduced-motion` with `prefers-reduced-motion`), `3-owner-picker` (the avatar's picker), `4-owner-info` (the info card on hover), `5-list` / `5-list-owner-picker` (the list's avatar); phone: `1-board-tab0/1` (one status at a time). `measures.json` has what the page laid out and every check.
- `running-light/` — the in-progress column over ~3 s (26 frames): the soft band and the breathing edge on the running cards.

`SHA256SUMS` lists the files.
