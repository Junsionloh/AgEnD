# Capture receipt — upstream PR #3725 (AGEND-234)

Re-capture of the 8 combination screenshots from a **clean build of the PR head**, replacing `assets/agend-222-screenshots` (whose after-shots were taken from `27a399317b [modified]`).

| | commit | `git status --porcelain` | `dist/build-provenance.json` | page badge |
|---|---|---|---|---|
| before | `944535da9932c3fc71068b69f7faebfc963ac254` (upstream base of the PR (merge-base with release/2.3.5-alpha at review time)) | `''` | modified=false, channel=source | `Source build · 944535da9932` |
| after | `7c1e13de4f8d7713aa71b0a962ceb5ef47d5c68c` (PR #3725 head) | `''` | modified=false, channel=source | `Source build · 7c1e13de4f8d` |

- Captured: 2026-11-12T07:41:30.147Z · Node v22.23.4
- Build: git worktree at the commit (detached), `npm ci`, `npm run build` (tsc + postbuild, which stamps dist/build-provenance.json); `git status --porcelain --untracked-files=normal` empty before and after the build.
- Run: cap/instance.sh start <side> <repo> <port> (own AGEND_HOME and HOME, env -i, PATH = cap/bin fakes + node + system bins; fleet.yaml with no instances; no real credentials; never :8445 / :19280), then cap/capture.mjs.
- Fake CLIs: cap/bin/claude and cap/bin/grok: logged out; `claude auth login` replays the real 2.1.286 OAuth-URL pane, `grok login` the real 1.0.77 device-code pane (both from tests/fixtures); nothing reaches a provider.
- Pages served: every static resource the pages loaded (`/assets/*`, `/ui/js/*`; 209 per side) was hashed as served over HTTP and compared with the committed `src/ui` file of that commit: **201 match, 0 mismatch** on each side; the 8 "unmapped" entries are JSON API endpoints, not files. Per-file hashes: `receipt.json` → `sides.<side>.servedResources.files`.
- Every one of the 48 single shots records the page's own badge text (full commit in the text; the phone header truncates the display to `7c1…`), its sha256 and the badge crop taken from the same page load (`single/badge-*.png`). All badges equal their side's commit; none says modified/unknown.

## Notes
- Scene (a) hides the Codex/Kiro/other cards with an inline display:none (only the two this change is about stay); the badge crop beside each shot is the page's own header badge from the same page load.
- Scene (a) is shot at a 2600px-tall viewport so the page's fixed bars do not cover the cards; (b) and (c) are plain viewport shots.
- Scene (b) is opened with the page's own openSignIn (the page itself disables a backend's Connect while that backend is connecting, which is the point of the change).
- Before-side refusal text is the server's sentence (it follows the host's language, here zh-TW, not the page's); the after side words it in the page's language.
- The 'before' instance is the PR's merge-base (944535da9), not the current tip of release/2.3.5-alpha, so the diff shown is exactly this PR.

## Images
`1`–`8` are the combinations (desktop/phone x light/dark x en/zh-TW); left = before, right = after, rows (a) Claude Code connecting → Grok Connect, (b) same backend pressed again → refusal, (c) Claude Code dialog console-fallback note. `single/` holds the 48 originals; `receipt.json` lists each with its badge and sha256.

## Reproduce
```
git worktree add --detach ../base 944535da9 && git worktree add --detach ../head 7c1e13de4   # npm ci && npm run build in each
capture/instance.sh start before <base> 19720 ; capture/instance.sh start after <head> 19710
node capture/capture.mjs <out>   # once per combo with ONLY=desk-light-en etc.; then composite.mjs and finalize.mjs
```
(`lib.mjs` expects playwright-core under `~/.cache/agend-smoke/pw` and its Chromium libs under `~/.cache/agend-smoke/libs`.)
