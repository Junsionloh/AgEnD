# Screenshots for the three-part split: comment threads (a), comment status and unread (b), live sub task state (c)

Images only. Taken headless with Chromium from a scratch fleet of made-up cards (the repository's `scripts/manual/smoke-fixture`), desktop 1366 px and phone 390 px,
light and dark, English and 繁體中文. `before/` is `release/2.3.5-alpha` without the change, `after/` is the part's branch; a pair has the same file name, and what is
new has no "before". This headless browser has no colour-emoji font, so emoji show as empty boxes in every picture, before and after alike.

- `a/` — a card's comments: `1-stream`, `2-menu-own`, `3-menu-other`, `4-picker`, `5-delete-dialog`, `6-reply-recipients`, `7-resolved-open`, `8-waiting-card-comment-box`.
- `b/` — where a comment stands and what is new: `1-board`, `2-card-statuses`, `3-home-1-unread`, `4-home-6-unread`.
- `c/` — a main task and its sub tasks: `1-board`, `2-card-running` (running, waiting and blocked), `3-card-handoff`, `4-card-unclaimed`, `5-card-unclaimed-late`. The title's sweep is frozen mid-way so every picture shows the same frame.
