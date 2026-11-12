---
section: Added
---
- **Experimental, off by default: Grok keeps its terminal and the chat shows its thinking and tool calls live (#3731).** Set `backend_options.grok.leader_observer: true` on a Grok instance and AgEnD starts that instance's own Grok leader, which lets the terminal and a second, read-only client share one session. The read-only client only listens: it never sends a prompt, a cancel or a key press, and never answers a permission request (the terminal does). While a turn runs, the chat's activity block shows the call in progress and, for an admin with thinking turned on, the thought so far. Needs Grok 1.0.77 or a later 1.0.x; any other version keeps the old behaviour. Without the setting nothing changes: Grok still starts with `--no-leader`.
