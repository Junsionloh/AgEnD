---
section: Fixed
---
- **A `#` card reference tells every runtime how to read the card (AGEND-333).** The "read the whole card" line under a `#M-3` reference was left out for native (Windows) agents, although they have the `task` tool. It is now given on every runtime in the form the agent can use: `task get M-3` (detail: true) for an agent with the MCP tool, `agend-agent task get M-3 --detail` in CLI mode; an agent whose tool set has no `task` tool (`minimal`) is told it has none, instead of being pointed at one it would be refused.
