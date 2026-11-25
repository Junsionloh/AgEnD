Screenshots for the task-card files PR (songsid/AgEnD). This branch only carries them.

- `before/`: `release/2.3.5-alpha` at `bb91baddb`.
- `after/`: the PR's code (`feat/task-card-content-attachments-upstream`).
- Both from `scripts/manual/smoke/smoke-task-card-files.mts` (`ROLE=before` / `ROLE=after`, `MATRIX=full`): desk 1366 / phone 390 × light / dark × English / Traditional Chinese, same seed.
- `<device>-<theme>-<lang>-planner-card.png` is the planner's card (design document), `…-dev-card.png` the developer's card (the one-file prototype), `…-dev-card-preview-running.png` the prototype running from the card's Preview.
- `after-844/`: standard-height phone frames, **390×844 viewport shots (not full page)** of the PR's code at `00174afd96e557eb17f824173d69e29179f0a3b1`, light / dark × English / Traditional Chinese, same seeded fleet as `after/`. The page is scrolled the way a person scrolls it; `<theme>-<lang>-<n>-<state>.png`: `1-card-top` (Markdown fields, Edit button in its own row), `2-comment-file` (the file under the comment: Download / Show), `3-files-field` (the Files field), `4-dev-files-actions` (Download / Preview), `5-preview-opened` (consent notice, Stop, top of the running frame), `6-preview-box` (scrolled to the running sandbox frame: the whole box inside the 844 px frame, under the sticky header).
