# AGEND-122 round 3 — screenshots for Prism's second review of PR #3503 (fake data only)

Captured at head `744cb8ab39a466cd0645380e9b5c34a53d6270d2` of `Junsionloh:feat/remote-settings-auth` (PR songsid/AgEnD#3503). Source is identical to
`9387ab3b6`; the head commit only adds the smoke script `scripts/manual/smoke/smoke-remote-confirm-122-round3.mts`.
Chromium on the shared smoke fixture, own ephemeral ports, a scratch home each; demo accounts and a throw-away authenticator secret only.
Run: `PART=chat|skew REPO=<checkout> OUT=<dir> MATRIX=full|quick [SKEW=<dir>] npx tsx scripts/manual/smoke/smoke-remote-confirm-122-round3.mts`.

- `chat/` — a CHAT fleet's admin (a Discord demo account in the connection's admin list; not the host's own session) on a LAN name, matrix `full`
  (desk/phone × light/dark × en/zh-TW), 4 + 7 checks each, all PASS (`result.json`):
  `1-chat-no-app` (held Delete agent applies at once), `2-chat-app-off`, `3-chat-code` (own switch on: code field; another app's code refused, own code applies),
  `4a…4f` (Owner verification card: not set up, set-up dialog, set up, replace asks the current code, switch-off asks it, remove asks it **with the switch off**),
  `5-dashboard-notices` (the Notice that every connection's General and the dashboard's Notices got).
  (The bell glyph shows as an empty box in this sandbox's font; the text is what is judged.)
- `skew/` — the new server against a tab that cached the review base's shared assets: variants `fresh`, `dict` (`app-i18n.js` old), `css` (`app.css` old),
  `dict-css`, `shell` (`app.js`, `app-shell.js`, `app-i18n.js`, `app.css` old); matrix `quick` (desk-light-en, phone-dark-zh-TW). For each: the pending card
  (lenient → applies at once; own switch → code field → code applies) and the Owner verification card with its current-code dialog. 90 checks, all PASS:
  no raw key / `undefined`, actions work, no page error. Known and accepted: an old dictionary or shell shows the old wording of the lenient card
  ("Confirmed by your account (this browser is web-verified)"), and the old shell keeps its folded "confirm on the host" command; nothing breaks.
