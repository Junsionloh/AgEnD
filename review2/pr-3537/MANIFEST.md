# MANIFEST for upstream PR #3537 evidence

## Commits
- BEFORE = `1be11da9186914756d12fb021e8d8822cc70ab86` (upstream release tip), worktree `workdir/ev3537/before` (detached)
- AFTER = `8d37814a0219a7b0a1b58454a02dd9ba9cb55581` (`feat/runtime-install-opencode` head), worktree `workdir/ev3537/after` (detached)
- Between them only two files under `src/ui` differ: `cli-caps.js` and `runtime-cli-install.js` (`runtime-install.css`, `app-i18n.js`, `panel-runtimes.js` are byte-identical in both).
- The app footer of the AFTER screenshots reads "Source build 8d37814a0219" (real build provenance).

## Build and run (exact commands)
```
git -C <workdir>/AgEnD worktree add --detach <workdir>/ev3537/before 1be11da91
git -C <workdir>/AgEnD worktree add --detach <workdir>/ev3537/after  8d37814a0
ln -s <workdir>/AgEnD/node_modules <worktree>/node_modules      # both
cp <workdir>/AgEnD/.agend-tmux.json <worktree>/                  # both; untracked tmux install receipt, needed by the fleet to start (no product code touched)
(cd <worktree> && npm run build)                                 # tsc + postbuild; both exit 0
evidence/3537/run.sh all        # starts both fleets, runs shoot.mjs, stops both
```
`run.sh` per server: copy of fixture `/tmp/ag133/d` to `/tmp/ev3537-<before|after>/d` (fixture itself untouched), `sed` of fleet.yaml (`/tmp/ag133` -> data dir, `health_port`), then
`AGEND_HOME=/tmp/ev3537-<n>/d HOME=/tmp/ev3537-<n>/home PATH=/usr/local/bin:/usr/bin:/bin AGEND_WSL=0 setsid nohup node dist/cli.js fleet start` (cwd = that worktree).
Ports: BEFORE 127.0.0.1:19810, AFTER 127.0.0.1:19811. Stopped at the end by `kill <recorded PID>` plus `pkill -f "tmux -L agend-.* -f /tmp/ev3537-<n>/d/tmux"`; both ports verified closed afterwards.
Browser: `HOME=/home/junsionloh LD_LIBRARY_PATH=/home/junsionloh/chromelibs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/home/junsionloh/.cache/ms-playwright node evidence/3537/shoot.mjs evidence/3537 all` (playwright-core from the AFTER worktree's node_modules, Chromium).
Sign-in: `POST /auth/issue-code` with `X-Agend-Token` from `web.token`, then `/signin#code=...`, a fresh browser context per image.

## How the images are made
- Page: the real signed-in `/settings/runtimes` (Settings shell: sidebar, settings nav, Runtime page). Desktop viewport 1180x900, phone 390x844 (the phone shell shows its own top bar and bottom tabs).
- Light/dark: Playwright `colorScheme` emulation; the app is on its default theme "system" (`agend_theme` not set, `data-theme` absent), so the page's own `prefers-color-scheme` CSS decides. Page background measured: light `rgb(255,255,255)`, dark `rgb(33,33,33)`.
- Language: the host keeps the first language chosen (#1665), so per image the script calls the app's own `setLang()` (from `/assets/app-i18n.js`, the function Preferences uses) after the page loads; `<html lang>` verified `en` / `zh-Hant` per image in `matrix-state.json`. No raw i18n keys (`runtimeInstall.*`), `undefined`, `NaN` or `[object` in the Install block of any image (`raw: []` for all 16 + 3 skew).
- The "Other CLIs" disclosure is opened by clicking its summary. The Settings shell scrolls inside its own pane, so for the shot the viewport height is grown (same width) to the pane's full scroll height and the shot taken from the top: one real screenshot of the whole shell, nothing cropped or composited. Resulting image heights: desktop 1685-2053 px, phone 2078-2776 px. (On phone 12 px of pane scroll remains below the bottom tab bar; the Install block is fully in frame.)
- Files: `{desk,phone}-{light,dark}-{en,zh-TW}-{before,after}.png` (16), `skew-old-registry-en.png`, `skew-old-install-module-en.png`, `skew-old-css-en.png`; per-image measured state in `matrix-state.json` and `skew-state.json`.

## Assets: sha256 as fetched from the running server vs the git commit
Every `.js`/`.css` the page requested was hashed from the HTTP response body (Playwright `response.body()`) during the matrix runs and compared with `git show <commit>:<path>` (`/ui/js/X` = `src/ui/X`, `/assets/X` = `src/ui/shared/X`). Result: **176 of 176 files on BEFORE and 176 of 176 on AFTER match, 0 mismatches, none without a git counterpart** (full output: `manifest-check.out`; raw hashes: `served-sha.json`; the list of AFTER requests: `after-served-assets.txt`). The assets that matter here:

| server | URL | git path | sha256 from server | sha256 in git commit | |
|---|---|---|---|---|---|
| after | `/assets/app-i18n.js` | `src/ui/shared/app-i18n.js` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | match |
| after | `/assets/runtime-install.css` | `src/ui/shared/runtime-install.css` | `d351a880f9f9c042d8afc30353cbae26ed0ea94afa537f5da2d9d99269e31a54` | `d351a880f9f9c042d8afc30353cbae26ed0ea94afa537f5da2d9d99269e31a54` | match |
| after | `/ui/js/cli-caps.js` | `src/ui/cli-caps.js` | `f0bc54a5e2e201c6735e898a4241fda9b86638c0b4cf6c2a1415dbcb7db364a1` | `f0bc54a5e2e201c6735e898a4241fda9b86638c0b4cf6c2a1415dbcb7db364a1` | match |
| after | `/ui/js/panel-runtimes.js` | `src/ui/panel-runtimes.js` | `484771b55207fcb99a54c2adbd5d3606462a7acd4c059a24a74fc2b9c442cb8d` | `484771b55207fcb99a54c2adbd5d3606462a7acd4c059a24a74fc2b9c442cb8d` | match |
| after | `/ui/js/runtime-cli-install.js` | `src/ui/runtime-cli-install.js` | `a16876678b69ca000ba4a220c9ebe9302ff1ce867d13e13146ada4c99894912e` | `a16876678b69ca000ba4a220c9ebe9302ff1ce867d13e13146ada4c99894912e` | match |
| before | `/assets/app-i18n.js` | `src/ui/shared/app-i18n.js` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | match |
| before | `/assets/runtime-install.css` | `src/ui/shared/runtime-install.css` | `d351a880f9f9c042d8afc30353cbae26ed0ea94afa537f5da2d9d99269e31a54` | `d351a880f9f9c042d8afc30353cbae26ed0ea94afa537f5da2d9d99269e31a54` | match |
| before | `/ui/js/cli-caps.js` | `src/ui/cli-caps.js` | `237b2067d520c04fa6d585c0f3d9f9eea946ded76fa493d4bece235dd427a056` | `237b2067d520c04fa6d585c0f3d9f9eea946ded76fa493d4bece235dd427a056` | match |
| before | `/ui/js/panel-runtimes.js` | `src/ui/panel-runtimes.js` | `484771b55207fcb99a54c2adbd5d3606462a7acd4c059a24a74fc2b9c442cb8d` | `484771b55207fcb99a54c2adbd5d3606462a7acd4c059a24a74fc2b9c442cb8d` | match |
| before | `/ui/js/runtime-cli-install.js` | `src/ui/runtime-cli-install.js` | `e39513987feb5563a0ded318770908e34d1cec628fa52c1b6573da51d73f86da` | `e39513987feb5563a0ded318770908e34d1cec628fa52c1b6573da51d73f86da` | match |

Skew: the "old" files served by `page.route` were fetched from the BEFORE server (signed-in session) and hashed: cli-caps `237b2067...a056`, runtime-cli-install `e3951398...86da`, runtime-install.css `d351a880...1a54`, each equal to the same file in the BEFORE commit. For the old CSS case the old and new file are the same bytes (`d351a880...`), so that case is a no-op by construction (the PR does not touch CSS).

## Synthetic data (what is fake)
- Everything about the paired Windows computer "Office PC" is mocked with Playwright `page.route`: `GET /ui/runtimes` returns one machine (id `12345678-1234-4321-abcd-123456789012`, win32, online, paired, runtime 2.3.5-alpha, capabilities incl. `cli-install`, inventory with ONE CLI: Claude Code `2.1.316 (Claude Code)`, authenticated), and `GET /ui/runtimes/machines/*/remote-setup` returns `capable: true`, `switches.install.on: true` (until now+2h; so the "Allowed until ..." line shows the real clock time of the run), `job: null` and a `catalog` of `{id, version}` taken from each build's own `INSTALLABLE_CLIS` (BEFORE: claude-code 2.1.316, codex 0.165.0; AFTER: claude-code 2.1.316, codex 0.165.0, opencode 1.19.5).
- The "Update status unavailable" notice and the "Claude accounts" text come from the real page reacting to this fake machine (it has no update info/accounts).
- Not synthetic: the page's JS, CSS, strings (EN and zh-TW), the Settings shell, the fleet server (a real fleet start on a copy of an old fixture with one `master` instance; the "Notices" badge counts and instance list in the sidebar are that fixture's). No real Windows computer, no vendor install, no real CLI install, no install button was pressed.
- The 401 `/auth/session` and one-off 404 `/ui/windows-cli/probe` seen in the browser console are the sign-in page's anonymous probe and the fixture's missing Windows probe, unrelated to this PR (the 404 also occurs on BEFORE).

## Visual observations on the AFTER images (product code not touched)
1. Phone (390 px), both languages and themes: the Antigravity command (`irm https://antigravity.google/cli/install.ps1 | iex`) wraps to three lines and the command card's `max-height: 4.8em` (`.runtime-command-text`, `runtime-install.css`) cuts the third line ("ps1 | iex") at its bottom edge; the rest is reachable only by scrolling inside the card. The same card and CSS exist on BEFORE (the CSS is unchanged), so this is not a regression of #3537, but the new "Other CLIs" list makes it more visible.
2. All viewports: the "Why not here: ..." note has no spacing below it, so the next entry's label (Antigravity, Muse, Kiro) sits right under it, tight against the previous reason (desktop and phone, light and dark). Readable, but the grouping of reason-to-command is only clear by the command card between them.
3. No clipped or overflowing text found by measurement (no element in the Install block wider than its container or the viewport at 390 px), no raw i18n keys, no unreadable dark colours (the note text is the page's secondary grey on the dark card; legible). zh-TW strings all present (4 reasons, OpenCode row, Muse card).
