# Access & security browser evidence

- Commit: `c57bb19724e36ee109fb2aac3e72e2901406848c` (clean working tree); old assets (BASE): `9c8e47ee161d93c51f8c04ab08b0de16d02cd945`; pre-fix controls: `cd7f378b`
- One-time local fixture: a web-only fleet in a scratch home on 127.0.0.1; English UI; Chromium. Nothing real: the code, the authenticator key, the code typed into a field and the QR are redacted (in the page, before the shot) in every screenshot, and never printed. The authenticator account label (carried by the QR's otpauth URI) is the fixture's fake host name `fixture-host`.
- Result: **16/16 steps pass**

| path | direction | step | result | what the browser showed |
|---|---|---|---|---|
| Sign-in page (new device shows a code) | stale | old sign-in tab: no "another device" button; a host code still signs in through /auth/login | PASS | old signin.js: form shown, button hidden, POST /auth/login → /ui; /auth/device-login* never called — `evidence-A-stale-old-signin-script-form.png` |
| Sign-in page (new device shows a code) | fresh | a new device asks for a code (shown, redacted here), with a countdown | PASS | code shown (redacted); "Waiting for approval… Expires in m:ss." — `evidence-A-fresh-new-device-code.png` |
| Device list and Add device approval | fresh | the owner opens Add device, enters the code, sees who is asking, and allows it | PASS | confirm screen: from «This computer», address, code to compare (redacted), device label; after Allow: «Approved. The new device signs in within a few seconds.» — `evidence-B-fresh-confirm-who-is-asking.png` |
| Sign-in page (new device shows a code) | fresh | the new device signs itself in (its own poll) and lands in the app | PASS | POST /auth/device-login/poll → approved → /ui — `evidence-A-fresh-new-device-signed-in.png` |
| Device list and Add device approval | fresh | the device list shows both devices, how each was approved, and the new one can be signed out by the owner | PASS | 3 devices: «Chrome on Linux This device Approved by this computer · Owner verified · active just now Chrome on Linux Approved by device code · Signed in, owner not verified yet · active just n» — `evidence-B-fresh-device-list.png` |
| Sign-in page (new device shows a code) | fresh | Back, then a new attempt while the cancel is slow: the new attempt keeps its cookie, and the owner's approval signs it in | PASS | slow POST /auth/device-login/cancel (1.5 s), new code requested at once → approved → signed in — `evidence-A-fresh-race-back-then-new-signed-in.png` |
| Sign-in page (new device shows a code) | stale | control — the sign-in script before the race fix, same order: A's late cancel answer expires B's cookie, and the approved B reads "expired" | PASS | same steps → «This code has expired.» after the owner approved it (the review's finding, reproduced) — `evidence-A-control-before-fix-approved-but-expired.png` |
| Device list and Add device approval | stale | old shell + new Settings panel (stale-shell): the Devices & sign-in card renders and its endpoints answer | PASS | app.css is BASE's (no .s-devices rule); card rendered, 6 device(s) listed from GET /ui/devices — `evidence-B-stale-shell-devices-card.png` |
| Device list and Add device approval | stale | old Session menu (BASE's app-session.js) in the device-approved session: it offers Sign out for another device; the new endpoint refuses and the menu says so | PASS | DELETE /auth/sessions/<handle> → 403 (a session a device approval made may sign itself out, not another); the old menu shows its failure line and stays usable — `evidence-B-stale-old-session-menu-refused.png` |
| Authenticator set-up dialog | stale | old-page (new shell + BASE's Settings modules): the old inline set-up still works against /ui/outside/enroll and /confirm | PASS | old inline block (no dialog): key + QR (redacted) → code accepted by the new endpoint → "set up" — `evidence-C-stale-old-page-inline-setup.png` |
| Authenticator set-up dialog | fresh | the set-up dialog (Set up again): steps 1 and 2, the key and QR (redacted), a wrong code is answered inside it, a right one turns it on | PASS | title «Set up again»; wrong code → «That code didn't work. Check that your phone's clock is right and try the newest code.» inside the dialog; right code closes it and the card shows the new state — `evidence-C-fresh-dialog-open.png`, `evidence-C-fresh-dialog-wrong-code.png`, `evidence-C-fresh-dialog-done.png` |
| Authenticator set-up dialog | fresh | Cancel while the secret is being asked for, then open again (the review's order, in a browser): one request, and the key on screen confirms | PASS | first request slow, Cancel (Esc), open again → 1 POST /ui/outside/enroll; the code from the key on screen was accepted |
| Authenticator set-up dialog | stale | control — the module before the enrolment fix, same order: the browser shows the key of the SECOND request while the first lands last, so its code is refused | PASS | 2 POST /ui/outside/enroll; the code from the key on screen was refused (the review's finding, reproduced) — see C-control-before-fix-code-refused — `evidence-C-control-before-fix-code-refused.png` |
| all | fresh | no page errors in any tab | PASS |  |
| all | fresh | the authenticator account label is the fixture's fake host name, not this machine's | PASS | label «fixture-host» (the QR code's otpauth URI carries it) |
| all | fresh | no screenshot decodes as a QR code (jsQR, both polarities), and the canary does | PASS | 14 screenshots, 0 decoded; canary (the unredacted dialog) decoded |

## Requests to the new endpoints (method, path, status — no bodies, no cookies)
```
DELETE /auth/sessions/<handle> → 403
GET /auth/session → 200
GET /auth/session → 401
GET /auth/sessions → 200
GET /ui/devices → 200
GET /ui/outside → 200
POST /auth/device-login → 200
POST /auth/device-login/cancel → 200
POST /auth/device-login/poll → 200
POST /auth/login → 200
POST /ui/devices/approve → 200
POST /ui/devices/lookup → 200
POST /ui/outside/enroll → 200
POST /ui/outside/enroll/confirm → 200
POST /ui/outside/enroll/confirm → 400
```

## Redaction, per screenshot (every target present, redacted, and verified before and after the shot; page scan: no key, code, otpauth URI, app-painted QR or hostname)
- A-stale-old-signin-script-form: no target — redaction verified before and after the shot; page scan clean
- A-fresh-new-device-code: text:#devCode — redaction verified before and after the shot; page scan clean
- B-fresh-confirm-who-is-asking: text:#devCodeShown — redaction verified before and after the shot; page scan clean
- A-fresh-new-device-signed-in: no target — redaction verified before and after the shot; page scan clean
- B-fresh-device-list: no target — redaction verified before and after the shot; page scan clean
- A-fresh-race-back-then-new-signed-in: no target — redaction verified before and after the shot; page scan clean
- A-control-before-fix-approved-but-expired: text:#devCode — redaction verified before and after the shot; page scan clean
- B-stale-shell-devices-card: no target — redaction verified before and after the shot; page scan clean
- B-stale-old-session-menu-refused: no target — redaction verified before and after the shot; page scan clean
- C-stale-old-page-inline-setup: qr:#outQr, text:#outKey, input:#outCode — redaction verified before and after the shot; page scan clean
- C-fresh-dialog-open: qr:#outQr, text:#outKey, input:#outCode — redaction verified before and after the shot; page scan clean
- C-fresh-dialog-wrong-code: qr:#outQr, text:#outKey, input:#outCode — redaction verified before and after the shot; page scan clean
- C-fresh-dialog-done: no target — redaction verified before and after the shot; page scan clean
- C-control-before-fix-code-refused: qr:#outQr, text:#outKey, input:#outCode — redaction verified before and after the shot; page scan clean

## QR decode check of the screenshots (jsQR, both polarities; canary: the unredacted dialog decoded, so the check can see a QR)
- no QR  `evidence-A-control-before-fix-approved-but-expired.png`
- no QR  `evidence-A-fresh-new-device-code.png`
- no QR  `evidence-A-fresh-new-device-signed-in.png`
- no QR  `evidence-A-fresh-race-back-then-new-signed-in.png`
- no QR  `evidence-A-stale-old-signin-script-form.png`
- no QR  `evidence-B-fresh-confirm-who-is-asking.png`
- no QR  `evidence-B-fresh-device-list.png`
- no QR  `evidence-B-stale-old-session-menu-refused.png`
- no QR  `evidence-B-stale-shell-devices-card.png`
- no QR  `evidence-C-control-before-fix-code-refused.png`
- no QR  `evidence-C-fresh-dialog-done.png`
- no QR  `evidence-C-fresh-dialog-open.png`
- no QR  `evidence-C-fresh-dialog-wrong-code.png`
- no QR  `evidence-C-stale-old-page-inline-setup.png`

## Old (BASE) files served per direction
- sign-in page: `/assets/signin.js`; stale-shell: `/assets/app.js`, `/assets/app-shell.js`, `/assets/app-stream.js`, `/assets/app.css`, `/assets/instance-nav.js`, `/assets/app-session.js`, `/assets/signin.js`; Session menu: `/assets/app-session.js`; old-page: `/ui/js/panel-settings.js`, `/ui/js/search-dialog.js`, `/ui/js/settings-outside.js`, `/ui/js/settings-registry.js`, `/ui/js/settings-web-authority.js`.
