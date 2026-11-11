# Reasoning effort in Settings → agent → Runtime & model — before and after

Drawn in the real web app in headless Chromium, against a scratch fleet (own `AGEND_HOME`, loopback only, no chat channel, no fleet start) by `scripts/manual/smoke/smoke-effort-field-3636.mts`. "Before" is `improve/effort-by-model` @ 256754094 (PR 1, no effort field); "After" is this branch. One `claude-code` agent runs `claude-opus-4-6`; the scratch claude catalog gives Opus 4.6 `low/medium/high/max`, Opus 4.5 `low/medium/high`, Haiku 4.5 none.

For each of the 8 cases (`{desk,phone}-{light,dark}-{en,zh-TW}`; desk 1366 wide, phone 390 wide), the **Model** card of the Runtime & model category:

- `before-card-<case>.png` — the base: the model, no effort.
- `after-card-<case>.png` — **Reasoning effort** under the model, same `.field` layout; *Model default* first, then the model's own levels; "Immediately" says it applies now.
- `after-model-moved-<case>.png` — the model field moved to Opus 4.5 (not saved): the list follows (no `max`), the field is disabled with a note until Save.
- `after-tip-<case>.png` — the ⓘ open: it says a running agent applies it at once, and that some CLIs (such as Codex) restart the agent for it to take effect.
- `after-chosen-<case>.png` — `high` chosen: applied through the chip's `/effort` at once (nothing staged), *Model default* can no longer be picked back.

SKEW (desk-light-en): `skew-old-daemon` (new page, daemon without `/ui/effort-options`: no field, no error), `skew-old-shell` (old shared `/assets` shell under these modules), `skew-old-strings` (an old tab's cached `agent-page-strings.js`: the field draws, its words show as keys, nothing throws).
