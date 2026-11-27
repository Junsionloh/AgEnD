# Screenshots for the task card's comment threads, comment status and live sub task state

Images only. Taken headless with Chromium from a scratch fleet of made-up cards (the repository's `scripts/manual/smoke-fixture`), desktop 1366 px and phone 390 px,
light and dark, English and 繁體中文. `before/` is `release/2.3.5-alpha` without the change, `after/` is the branch; each pair has the same file name.

- `threads/` — a card's comments: `1-stream` (all comments), and in `after/` also `2-menu` (the ⋯ menu) and `3-reply` (a reply and its recipient list).
- `status/` — where a comment stands and what is new: `1-board` (the board), `2-card` (the card).
- `flow/` — a main task and its sub tasks: `1-board`, `2-card-running`, `3-card-handoff`, `4-card-unclaimed`, `5-card-unclaimed-late`.
  The title's sweep is frozen mid-way in these pictures so that every one shows the same frame.
