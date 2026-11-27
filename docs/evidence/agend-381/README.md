# CLI diagnostics · Windows on this computer, where PowerShell can't be reached (screenshots)

AGEND-381. The same dialog (Settings › Runtime › This PC › CLI diagnostics → Detect Windows CLIs) on a **fresh data folder** (no detection on record), desktop (1440×900) and phone (390×844 @2×) × light / dark × English / 繁體中文.

The failing host is made to look like the Docker preview (`node:22-bookworm` on Docker Desktop), whose facts were read from the running container: the WSL2 kernel string in `/proc/sys/kernel/osrelease`, no `WSL_DISTRO_NAME`, an empty `binfmt_misc`, `/.dockerenv`, and no `/mnt/c`. Here that is a private AgEnD on a scratch data folder in a mount namespace with `/mnt/c` hidden (`unshare -rm`, a tmpfs over `/mnt/c`), and a preload that hides `WSL_DISTRO_NAME` and shows `/.dockerenv`. Nothing on the host or on the real Docker preview was changed. The zh-TW shots rewrite the page's language in what the browser reads (the host's preference is English).

| Folder | What it shows |
|---|---|
| `before/` | Base `ed72b7faa` (`upstream/release/2.3.5-alpha`): *No detection recorded yet* **and** *Refresh failed. Showing the last successful inventory.* **and** `spawn /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ENOENT` — the issue's screenshot, reproduced. |
| `after/` | This branch: the failure says **why** (this AgEnD is not on Windows or WSL — a container or a plain Linux server) and **what to do** (run AgEnD on Windows/WSL, or Settings → Runtime → Connect a computer); no claim of a "last successful" result. |

Files are `<desk|phone>-<light|dark>-<en|zh-TW>.png`. The window names (`Native Windows`) and the preview-only data are the scratch instance's own.
