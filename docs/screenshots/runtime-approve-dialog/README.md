# Settings → Runtime: a computer that asks to pair opens an approval dialog (#3190)

Before and after for a computer waiting for approval on Settings → Runtime, in the real dashboard served by the shared smoke fixture (the product's own web server in a scratch home, no fleet start, no network) and headless Chromium. The `/ui/runtimes` answers a fresh fleet cannot give are made up inside the browser, the same for both sides, so the pages, CSS and scripts are the product's own. **Fixture data only**: made-up computers ("Demo-notebook" twice, one paired and one waiting, "Lab-desktop", "Bench-pc"), made-up fingerprints, no real address, host name or machine.

- **Before**: `release/2.3.5-alpha` at `3b854610d`.
- **After**: this PR's last code commit, the one before this folder was added.

Each picture has three panes, left to right:

1. **Before** — the list as it is today: two long computer cards first, the waiting computers' **Approve** far down.
2. **After** — the dialog that opens by itself: name, host name, platform, request time, the pairing fingerprint in large type, the existing "compare it" hint, a note that a computer with this name is already paired (one computer pairing twice looks like this), **Later**, **Reject**, **Approve**, and "1 of 2" because two computers are waiting.
3. **After, Later pressed** — the bar "2 computers are waiting for approval" (with **Review and approve**), the waiting computers first, the same-name computer marked **#2** with when and which, and the cards' own **Approve**.

Desktop is 1366 px wide and the dialog is drawn at 900 px high; phone is 390 px wide and its dialog is the bottom sheet at 844 px high (the phone panes are drawn at 2× and shown at 1×).

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | [compare-desktop-light-en](compare-desktop-light-en.png) | [compare-desktop-light-zh-TW](compare-desktop-light-zh-TW.png) |
| Desktop, dark | [compare-desktop-dark-en](compare-desktop-dark-en.png) | [compare-desktop-dark-zh-TW](compare-desktop-dark-zh-TW.png) |
| Phone, light | [compare-mobile-light-en](compare-mobile-light-en.png) | [compare-mobile-light-zh-TW](compare-mobile-light-zh-TW.png) |
| Phone, dark | [compare-mobile-dark-en](compare-mobile-dark-en.png) | [compare-mobile-dark-zh-TW](compare-mobile-dark-zh-TW.png) |

`scripts/manual/smoke/smoke-runtime-approve-dialog.mts` drives the same page in all eight cases and checks, besides the pictures: the dialog opens by itself, the fingerprint is at least 22 px, **Approve** is off for the first second and then on, the focus is inside the dialog and on no button, **Later** closes it with no request and it does not open again on the next poll, a computer that starts waiting afterwards opens it alone, **Reject** sends the reject route and leaves no card, an expired request opens nothing and says so, every dialog button is at least 44 px high on a phone, and there is no page error, CSP report or horizontal scroll.

## Shared pieces and rules

`Dialog` (the app's native `<dialog>`; a bottom sheet on a phone), `.btn` / `.btn-primary` / `.btn-danger`, `.note`, `.lbar` (the straight left bar, in `--warn`), `.tag` and `.runtime-machine-facts`. **Three new rules** in `runtime-install.css`, all with `tokens.css` variables only and no inline style: `.runtime-approve-fingerprint` (the large fingerprint), `.runtime-pending-banner` (the waiting bar) and `.runtime-same-name` (the same-name hint). The "1 of 2" line is a plain `.note`; it has no rule of its own.

## Surfaces and clicks (UI guide §9)

The dialog opens only on Settings → Runtime. It adds **no click**: it is a shortcut to the card's own Approve, which stays; Reject needs no second question because the request has no credential yet (and the server refuses it for a computer that was approved meanwhile). **Approve** stays off for the first second after the dialog appears, because it appears by itself and a click already on its way must not land on it; that costs no click.
