# Evidence for upstream PR #3539 (Update button + version line in Settings -> Agents -> AI accounts and API keys)

## Source binding

| | commit | worktree (detached, `npm run build` = tsc + postbuild) | port | data dir |
|---|---|---|---|---|
| BEFORE | `1be11da91` (upstream release tip, contains #3536 Install, no Update/version line) | `.../workdir/ev3539/before` | 19820 | `/tmp/ev3539-before` |
| AFTER | `c79c501fb` (`feat/web-update-cli`, head of #3539) | `.../workdir/ev3539/after` | 19821 | `/tmp/ev3539-after` |

Both servers are the real `node dist/cli.js fleet start` of that build. Product code was not changed (`git status` of both worktrees is clean; only the untracked, git-ignored tmux receipt `.agend-tmux.json` and `.agend-runtime.*` were copied in from the main checkout so the bundled tmux verifies).

### Asset hashes: AS FETCHED FROM THE RUNNING SERVER (signed-in session) vs the same file in the git commit

Result: all 22 rows match (no mismatch). Script: `scripts/manifest-hash.mjs`, raw table `scripts/hashes.md`. Changed by #3539 in the Accounts page: `accounts-view.js`, `host-install.js`, `accounts.css` (the other assets are byte-identical in both builds). The "old copies" served in the skew tests (SKEW.md) are `git show 1be11da91:<path>`, i.e. exactly the BEFORE rows below.

| build | served URL | git path | sha256 served | sha256 git | |
|---|---|---|---|---|---|
| before | `/ui/js/accounts-view.js` | `src/ui/accounts-view.js` | `56bd1ac76e737c65752edbba09d82db3d3fad3316fdc977c3eb3802ca10b34e2` | `56bd1ac76e737c65752edbba09d82db3d3fad3316fdc977c3eb3802ca10b34e2` | match |
| before | `/ui/js/host-install.js` | `src/ui/host-install.js` | `4808af383b428f3ac35f0fadc6e1205fe284ffe7d486f665d3b331112a4fc8f6` | `4808af383b428f3ac35f0fadc6e1205fe284ffe7d486f665d3b331112a4fc8f6` | match |
| before | `/assets/accounts.css` | `src/ui/shared/accounts.css` | `54f899f215a1f62480961503252e34aa8f39cad0531c81b3eacf9b057f084e3f` | `54f899f215a1f62480961503252e34aa8f39cad0531c81b3eacf9b057f084e3f` | match |
| before | `/ui/js/settings-confirm.js` | `src/ui/settings-confirm.js` | `a9516dc099d479a5c6648386d2b91928603c32908107bad0f5c9fa5faff47d15` | `a9516dc099d479a5c6648386d2b91928603c32908107bad0f5c9fa5faff47d15` | match |
| before | `/ui/js/accounts-manage.js` | `src/ui/accounts-manage.js` | `7132a53e6f9cd911c1e28bc3b608159bf31c8f7c263331a528af758d10e5fc07` | `7132a53e6f9cd911c1e28bc3b608159bf31c8f7c263331a528af758d10e5fc07` | match |
| before | `/ui/js/accounts-keepalive.js` | `src/ui/accounts-keepalive.js` | `47dc197d386613903c6ddb334eba8c50d094305e1432c8759c53be52d60039ac` | `47dc197d386613903c6ddb334eba8c50d094305e1432c8759c53be52d60039ac` | match |
| before | `/assets/accounts-keepalive.css` | `src/ui/shared/accounts-keepalive.css` | `ce23afea1948ef40f84a649700a46948ee116dd8bfdbc98ec1564cb6a4a9ce87` | `ce23afea1948ef40f84a649700a46948ee116dd8bfdbc98ec1564cb6a4a9ce87` | match |
| before | `/assets/app-i18n.js` | `src/ui/shared/app-i18n.js` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | match |
| before | `/assets/ui-toast.js` | `src/ui/shared/ui-toast.js` | `601074179fe7c9156d05d507f28e3d22f93b49aba43f8d903b40ae4b8b1bba8d` | `601074179fe7c9156d05d507f28e3d22f93b49aba43f8d903b40ae4b8b1bba8d` | match |
| before | `/assets/app-html.js` | `src/ui/shared/app-html.js` | `8949e374c68b9252d5ee3ee788ec1b0340d12c4a6999ef8b734fe89562266bd9` | `8949e374c68b9252d5ee3ee788ec1b0340d12c4a6999ef8b734fe89562266bd9` | match |
| before | `/assets/app-store.js` | `src/ui/shared/app-store.js` | `8cee97c514d1b6789b1410fdee5bef549cc0bc854e3ddb071055bc036385fa88` | `8cee97c514d1b6789b1410fdee5bef549cc0bc854e3ddb071055bc036385fa88` | match |
| after | `/ui/js/accounts-view.js` | `src/ui/accounts-view.js` | `c80c3a14bd107848231b94f3c9a6a860e459ba95c4952f9f175369351c62574a` | `c80c3a14bd107848231b94f3c9a6a860e459ba95c4952f9f175369351c62574a` | match |
| after | `/ui/js/host-install.js` | `src/ui/host-install.js` | `0645a13131a64fdb338d647e7aa49807613a0434897c7c094b7d72c06d6c115d` | `0645a13131a64fdb338d647e7aa49807613a0434897c7c094b7d72c06d6c115d` | match |
| after | `/assets/accounts.css` | `src/ui/shared/accounts.css` | `cbe6a142ec0113f24b20fb64997c810ae112cb9d81d340a8cbc2e0f6b316ee9b` | `cbe6a142ec0113f24b20fb64997c810ae112cb9d81d340a8cbc2e0f6b316ee9b` | match |
| after | `/ui/js/settings-confirm.js` | `src/ui/settings-confirm.js` | `a9516dc099d479a5c6648386d2b91928603c32908107bad0f5c9fa5faff47d15` | `a9516dc099d479a5c6648386d2b91928603c32908107bad0f5c9fa5faff47d15` | match |
| after | `/ui/js/accounts-manage.js` | `src/ui/accounts-manage.js` | `7132a53e6f9cd911c1e28bc3b608159bf31c8f7c263331a528af758d10e5fc07` | `7132a53e6f9cd911c1e28bc3b608159bf31c8f7c263331a528af758d10e5fc07` | match |
| after | `/ui/js/accounts-keepalive.js` | `src/ui/accounts-keepalive.js` | `47dc197d386613903c6ddb334eba8c50d094305e1432c8759c53be52d60039ac` | `47dc197d386613903c6ddb334eba8c50d094305e1432c8759c53be52d60039ac` | match |
| after | `/assets/accounts-keepalive.css` | `src/ui/shared/accounts-keepalive.css` | `ce23afea1948ef40f84a649700a46948ee116dd8bfdbc98ec1564cb6a4a9ce87` | `ce23afea1948ef40f84a649700a46948ee116dd8bfdbc98ec1564cb6a4a9ce87` | match |
| after | `/assets/app-i18n.js` | `src/ui/shared/app-i18n.js` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | `f565a95444de2f7d929bb25e38f3f33cae05582a35feb2be3c2674d0a41fd1d5` | match |
| after | `/assets/ui-toast.js` | `src/ui/shared/ui-toast.js` | `601074179fe7c9156d05d507f28e3d22f93b49aba43f8d903b40ae4b8b1bba8d` | `601074179fe7c9156d05d507f28e3d22f93b49aba43f8d903b40ae4b8b1bba8d` | match |
| after | `/assets/app-html.js` | `src/ui/shared/app-html.js` | `8949e374c68b9252d5ee3ee788ec1b0340d12c4a6999ef8b734fe89562266bd9` | `8949e374c68b9252d5ee3ee788ec1b0340d12c4a6999ef8b734fe89562266bd9` | match |
| after | `/assets/app-store.js` | `src/ui/shared/app-store.js` | `8cee97c514d1b6789b1410fdee5bef549cc0bc854e3ddb071055bc036385fa88` | `8cee97c514d1b6789b1410fdee5bef549cc0bc854e3ddb071055bc036385fa88` | match |

(`/ui/js/X.js` = `src/ui/X.js`, `/assets/X` = `src/ui/shared/X`; the app-i18n bundle is `/assets/app-i18n.js`, the shell toast `/assets/ui-toast.js`, the held-change card `settings-confirm.js`.)

### Components reused (not new)
Accounts card/row (`.s-account-card`, `.s-account-row`, `src/ui/accounts-view.js`), `InstallButton` / `HostInstallRun` from `src/ui/host-install.js` (#3536; `VersionLine` and the Update button are the new parts, in the same module), the shell toast (`ui-toast.js`), `confirmedWrite` (`settings-confirm.js`) for the held change card (Install/Update are held changes of the Settings gate; for the signed-in local admin the lenient default applies them at once: the POST answers `202 pending_confirmation` with a `pending_change` in `state: applying`, and the page follows it).

### Exact commands
```
# build (each worktree; node_modules symlinked to the main checkout's)
git -C <AgEnD> worktree add --detach .../ev3539/before 1be11da91 ; git -C <AgEnD> worktree add --detach .../ev3539/after c79c501fb
(cd .../ev3539/before && npm run build) ; (cd .../ev3539/after && npm run build)
# fixture + fleet (scripts/setup.sh, scripts/fleet.sh), one command pair per build:
scripts/setup.sh after 19821      # copies /tmp/ag136/{home,d} to /tmp/ev3539-after, rewrites the paths and health_port in fleet.yaml, writes the FAKE CLIs and the fake curl
scripts/fleet.sh start after .../ev3539/after 19821
#   = AGEND_HOME=/tmp/ev3539-after/d HOME=/tmp/ev3539-after/home PATH=/tmp/ev3539-after/bin:/tmp/ev3539-after/home/.local/bin:/usr/local/bin:/usr/bin:/bin AGEND_WSL=0 setsid nohup node dist/cli.js fleet start
scripts/fleet.sh start before .../ev3539/before 19820   (same, for the BEFORE build, after scripts/setup.sh before 19820)
# browser (Playwright from the worktree's node_modules; chromium; scripts/run-node.sh sets HOME, LD_LIBRARY_PATH, PLAYWRIGHT_BROWSERS_PATH)
scripts/run-node.sh scripts/matrix.mjs                 # 16 matrix images
scripts/run-node.sh scripts/states.mjs [running|warning|failure|success] [comboIndex]   # phone states on AFTER
scripts/run-node.sh scripts/skew.mjs                   # skew variants on AFTER (fresh fleet per variant)
scripts/run-node.sh scripts/manifest-hash.mjs          # the hash table
# stop: kill $(cat /tmp/ev3539-<label>/fleet.pid); pkill -f "tmux -L agend-.* -f /tmp/ev3539-<label>/d/tmux"   (done; nothing left running)
```
Sign-in: `POST /auth/issue-code` with the data dir's `web.token`, then `/signin#code=...` (as in the AGEND-142 prior art). Theme and language live on the HOST (`web-prefs.json`, the page paints the host's choice over localStorage), so each page is set the way the Preferences page sets them: `POST /ui/prefs {set:{theme,lang}}`, with Playwright `colorScheme` and `locale` also set to match. Dark/light was verified from `html[data-theme]` and the card background (light `rgb(244,244,244)`, dark `rgb(47,47,47)`); zh-TW from CJK text in the block and the translated button labels (`scripts` logs: `matrix/matrix-log.txt`).

Screenshot framing: the Settings shell scrolls inside `.panel-body`, not the document, so a "full page" shot sets the viewport width to 1180 / 390 and the height tall enough that the whole `/settings/agents` page (shell, nav, agent list, Accounts block with the details open) is visible (device scale factor 2 for the 390 ones). `phone-states/*-fullpage.png` are that tall frame; `phone-states/<name>.png` (without suffix) is the literal 390x844 viewport scrolled so the Grok card is at the top.

### Synthetic data (read this)
Everything below is FAKE and scripted; no real vendor install and no real CLI update happened, nothing touched the network and no real CLI was installed.
- The CLIs on this fleet are tiny shell scripts in the copied fixture home (`/tmp/ev3539-<label>/home`, copied with `cp -a` from `/tmp/ag136`, originals untouched) that print a version: Claude Code `2.1.320` (newer than audited 2.1.319), Codex `0.167.0` (current), Kiro `2.37.0` (behind audited 3.1.0, Update button), Antigravity `1.3.6` (behind 1.5.3, self-updating: versions, no button), Grok `1.0.70` (behind 1.0.77, Update button), Muse `.muse-version` = `1.4.12-R6909.1` (self-updating, no button), OpenCode NOT installed (Install button). Audited versions come from the shipped ledger `src/cli-audited.ts` of the AFTER commit (claude 2.1.319, codex 0.167.0, kiro 3.1.0, grok 1.0.77, antigravity 1.5.3, opencode 1.19.5, muse 1.4.14-R7309.1).
- The vendor installer / update commands are replaced by a FAKE `curl` shim on the fleet's PATH (`scripts/bin/curl`, with the data dir baked in): it prints a scripted installer for the vendor URL it is asked for. Its behaviour per CLI is read from `/tmp/ev3539-<label>/ctl/<backend>`: `slow` (prints a progress line every 2 s for 80 s: the running state, cancellable), `ok` (exits 0 and rewrites the fake binary to the requested version), `warn` (exits 0, leaves the fake CLI at the old version, last lines say so: the WARNING), `fail` (exits 22 with `curl: (22) ... 404` lines). The phone states all use the Grok card with the mode set per state; versions, exit codes and "last lines" are therefore scripted.
- The "AI accounts" cards (not connected, connected, used by 1 agent) come from the fixture fleet (one `master` instance, stopped) and are as the fixture left them; no account or API key is real. The host caches the version it read, so each successful-update screenshot that needed a fresh "1.0.70" was taken after a fresh fleet start from a fresh fixture copy.
- Fixture note: the `pending_change.summary` text in the 202 answer is in zh-TW even for an English session (server-side locale of the fleet, not the page language); the page shows its own translated label.
