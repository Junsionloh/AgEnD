---
section: Changed
---
- **The built-in workflow tells an agent to claim a card before working on it (AGEND-338).** A real agent went straight to moving a card it had not claimed to review and was refused. The task board line of the built-in workflow (and the `agend-agent task claim` line of the CLI instructions) now says to claim a card (`task claim`) first. It is one clause, since every agent's prompt carries it; with the task board switched off it leaves with the rest of the board's guidance, and a custom workflow is not touched.
