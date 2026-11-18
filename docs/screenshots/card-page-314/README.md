# Card page layout (AGEND-314) — before / after

Real Chromium against the tailnet preview, demo data from `assets/agend-305-preview-demo`. Cards `M-2` (many empty fields) and `M-1` (every field filled, sub tasks, a watcher).
Desktop 1366×768 viewport; phone 390 wide (2×, touch). Light / dark × en / zh-TW.

- `before/` — `integration/tasks-revamp` @ `e32952491`
- `after-v1/` — `integration/tasks-revamp` @ `d456efe38` (scheme A, PR #97)
- `after/` — `improve/tasks-card-detail-grid` (the invisible grid, PR #98); `after-tall-*` are the views in a tall viewport (phone 2400 px, desktop 1400 px: the whole page in one picture)
- `pairs/` — before and after side by side (desktop: stacked; phone: first screen)
- `after-timeline/` — `improve/tasks-card-detail-grid` @ `5035dcd73` (PR #98): the activity timeline on `M-1` with extra demo data (earlier days, a run of equal history lines, a Markdown comment); `timeline-M-1-<desktop|mobile>-<light|dark>-<en|zh-TW>.png`, desktop 1500 px / phone 2800 px tall (the whole page in one picture)
