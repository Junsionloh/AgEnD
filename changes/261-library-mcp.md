---
section: Added
---
- **Library MCP servers can be given to an agent (AGEND-261).** In Settings → the agent → Workspace → *MCP servers*
  (**+ Add**, or the **+** on a Library MCP row) an administrator can now mount a library MCP server on a Claude Code or Codex agent.
  The page first shows exactly what it will run and which variables it needs; the server is written into the agent's MCP
  config at its next start, with the variable values taken from `.env` — and it is not started if one has no value. An
  agent with nothing mounted is unchanged, byte for byte. Also: replacing a library item through the API now needs the
  hash it was read at, a Library skill can no longer take a built-in skill's name, and zip file names that differ only in
  Unicode form count as the same name. An MCP item can only take variables named `MCP_…` from `.env` (and can hand one
  to the server under another name), so it can no longer ask for AgEnD's own credentials.
