# Settings → Runtime → Connect a computer: one command (#3190)

Before and after for **Connect a computer** on Settings → Runtime, in the real dashboard served by the shared smoke fixture (the product's own web server in a scratch home, no fleet start, no network) and headless Chromium. The `/ui/runtimes` answers a fresh fleet cannot give are made up inside the browser, the same for both sides, so the pages, CSS and scripts are the product's own. **Fixture data only**: the address is `https://agend.example.ts.net`, the computers are "Design workstation" and "Studio laptop", the token, the fingerprint and the installer hash are made-up strings, and no real credential, address or machine appears.

- **Before**: `release/2.3.5-alpha` at `3b854610d`.
- **After**: this PR's last code commit, the one before this folder was added.

Each picture has four panes, left to right and top to bottom on desktop, left to right on a phone:

1. **Before** — the panel as it opens: install command, a separate connect command, the pairing code on the right.
2. **After** — the panel as it opens: the one-time install command (with the server fingerprint it carries, the countdown, **New command** and **Revoke and close**).
3. **After, Manual options opened** — the pairing code route, with a pairing code made on request.
4. **After, a computer joined** — the notice **A new computer joined with an install command** (with **Revoke** and **Dismiss**) above the computers, and the new computer's card labelled **Joined by install command**.

Desktop is 1366 px wide; phone is 390 px wide (the phone panes are drawn at 2× and shown at 1×).

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | [compare-desktop-light-en](compare-desktop-light-en.png) | [compare-desktop-light-zh-TW](compare-desktop-light-zh-TW.png) |
| Desktop, dark | [compare-desktop-dark-en](compare-desktop-dark-en.png) | [compare-desktop-dark-zh-TW](compare-desktop-dark-zh-TW.png) |
| Phone, light | [compare-mobile-light-en](compare-mobile-light-en.png) | [compare-mobile-light-zh-TW](compare-mobile-light-zh-TW.png) |
| Phone, dark | [compare-mobile-dark-en](compare-mobile-dark-en.png) | [compare-mobile-dark-zh-TW](compare-mobile-dark-zh-TW.png) |

In all eight cases the page has no horizontal scroll with the panel open, with Manual options opened and with the notice shown.

## Shared pieces the after side uses

`.runtime-pair-card` and the command cards (`commandCard`, the existing install-command card with Copy), `details.runtime-manual-command`, the shared `Icon`, `.btn` / `.btn-sm`, `Skeleton` for the installer's first read, and the machine card. The two new rules (the countdown card and the joined notice) hold only `tokens.css` variables, the coloured left edge is the shared `.lbar`, and nothing is an inline style. No new click or confirmation: **Connect a computer** now generates the install command in the click it already took, and **Revoke** on the notice is the existing computer **Revoke** with its existing confirmation.
