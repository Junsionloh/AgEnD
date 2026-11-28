# CLI diagnostics · Windows on this computer, where PowerShell can't be reached (screenshots)

The same dialog (Settings › Runtime › This PC › CLI diagnostics → Detect Windows CLIs) on a **fresh data folder** (no detection on record), desktop (1440×900) and phone (390×844 @2×) × light / dark × English / 繁體中文.

The failing host is made to look like a `node:22-bookworm` container on Docker Desktop (WSL2 kernel string in `/proc/sys/kernel/osrelease`, no `WSL_DISTRO_NAME`, an empty `binfmt_misc`, `/.dockerenv`, no `/mnt/c`): a scratch AgEnD in a private mount namespace on WSL with `/mnt/c` hidden (`unshare -rm`, a tmpfs over `/mnt/c`), and a preload that hides `WSL_DISTRO_NAME` and shows `/.dockerenv`. It was not run in a real container.

| Folder | What it shows |
|---|---|
| `before/` | `release/2.3.5-alpha` at `ed72b7faa`: *No detection recorded yet* **and** *Refresh failed. Showing the last successful inventory.* **and** `spawn /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ENOENT`. |
| `after/` | The fix on that same base: the failure says **why** (not on Windows or WSL) and **what to do** (run AgEnD on Windows/WSL, or Settings → Runtime → Connect a computer); no claim of a "last successful" result. |

Files are `<desk|phone>-<light|dark>-<en|zh-TW>.png`.
