# Screenshots for the one-command Windows Runtime connect (songsid/AgEnD, #3190)

Evidence for the pull request, kept on this branch so the pull request itself carries no binary files. Every picture is the real dashboard served by the shared smoke fixture (the product's own web server in a scratch home, no fleet start, no network) in headless Chromium; the `/ui/runtimes` answers a fresh fleet cannot give are made up inside the browser, the same for both sides. **Fixture data only**: the address is `https://agend.example.ts.net`, the computers are made up ("Design workstation", "Studio laptop", "Demo-notebook", "Lab-desktop", "Bench-pc"), and the token, fingerprints and installer hash are made-up strings. Desktop is 1366 px wide, phone 390 px (drawn at 2× and shown at 1×). Before = `release/2.3.5-alpha` at `47106e8d0`; after = the pull request head.

## `connect-a-computer/`: Settings → Runtime → Connect a computer

Four panes per picture: **Before** (install command, a separate connect command, the pairing code on the right) · **After** (the one-time install command, compact: the SHA-256, the server fingerprint and the help texts are folded into "Verification hashes & troubleshooting"; the step text says the Runtime keeps running in the background) · **After, both disclosures opened** (the checks and help, and Manual options with the pairing code) · **After, a computer joined** (the notice with Revoke and Dismiss, and the card labelled "Joined by install command").

## `approval-dialog/`: a computer asks to pair

Three panes per picture: **Before** (the waiting computers' Approve far down a long list) · **After** (the dialog that opens by itself: facts, the pairing fingerprint in large type, "1 of 2", the same-name note, Later / Reject / Approve) · **After, Later pressed** (the "2 computers are waiting for approval" bar, waiting computers first, the same-name computer marked #2).

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | `compare-desktop-light-en.png` | `compare-desktop-light-zh-TW.png` |
| Desktop, dark | `compare-desktop-dark-en.png` | `compare-desktop-dark-zh-TW.png` |
| Phone, light | `compare-mobile-light-en.png` | `compare-mobile-light-zh-TW.png` |
| Phone, dark | `compare-mobile-dark-en.png` | `compare-mobile-dark-zh-TW.png` |

(each name exists in both folders)
