# Settings → Runtime → Connect a computer: one pasted command (#3190)

Before and after for the Windows (PowerShell) tab of **Settings → Runtime → Connect a computer**, in the real dashboard served by two scratch AgEnD fleets (empty `AGEND_HOME`, no agents, no paired computer; Remote Runtime on) and headless Chrome. The pages, CSS and scripts are the product's own; nothing is faked in the browser. **Nothing real is shown**: the address field was set to the placeholder `https://agend.example.ts.net`, and the pairing codes and installer hashes are those of the scratch fleets.

- **Before**: `release/2.3.5-alpha` at `e4ce9b21`.
- **After**: this PR's code at `ff3a1abb`, the head before this folder was added.

Each picture shows the whole "Connect a computer" panel, before on the left and after on the right. Desktop is 1460 px wide; phone is 390 px wide (drawn at 2×).

| | English | 繁體中文 |
|---|---|---|
| Desktop, light | [compare-desktop-light-en](compare-desktop-light-en.png) | [compare-desktop-light-zh-TW](compare-desktop-light-zh-TW.png) |
| Desktop, dark | [compare-desktop-dark-en](compare-desktop-dark-en.png) | [compare-desktop-dark-zh-TW](compare-desktop-dark-zh-TW.png) |
| Phone, light | [compare-mobile-light-en](compare-mobile-light-en.png) | [compare-mobile-light-zh-TW](compare-mobile-light-zh-TW.png) |
| Phone, dark | [compare-mobile-dark-en](compare-mobile-dark-en.png) | [compare-mobile-dark-zh-TW](compare-mobile-dark-zh-TW.png) |

## What changed on the page

- Step 2 is "Paste the command into PowerShell" and says the command installs **and** connects in the same window (it used to say it does not connect).
- Step 3 is "Enter the pairing code when the window asks" (it used to hold a second command to run). The reconnect hint (`connect-agend.bat` in the install folder) is in it.
- The two commands for an AI agent or a script (install only, and connect) are in a collapsed block, **Manual commands (for an AI agent or a script)**, under the install command.
- Nothing else moved: the address, the pairing-code card, the ZIP tab and the approval step are as before.

## Shared pieces the after side uses

Only existing ones: `.runtime-command-card` (the command boxes), `details.runtime-manual-command` (the collapsed block, already used by the ZIP tab's manual command), `.runtime-step`, `.note`, `.btn`. No new component and no new CSS rule.
