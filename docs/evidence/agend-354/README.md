# AGEND-354 — screenshots

The owner's M-12 scenario on the real Tasks tab (smoke fixture, `scripts/manual/smoke/smoke-354-task-card-files.mts`):
planner's design document (S-1), dev's HTML prototype (S-2), master's acceptance (S-3).

- `before/` — the base release (`acf22f6dc`): the agents could only write text, so the result and the comment are a local path.
- `after/` — this change: the same words as Markdown, and the files the agents attached on the card.
  `*-planner-card.png` (S-1), `*-dev-card.png` (S-2), `desk-light-en-dev-card-preview-running.png` (the prototype running from
  the card's Preview, in the sandbox frame).

Matrix: desk 1366 / phone 390, light / dark, English / zh-TW (`<device>-<theme>-<lang>-…`). `after-results.json` records the
browser check that the prototype runs in an iframe of the preview origin (`sandbox="allow-scripts"`) and that the file itself is
served as a download (`application/octet-stream`, `attachment`, sandboxing CSP).
