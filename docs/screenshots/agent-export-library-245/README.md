# Agent export / import with the Library's skills and MCP servers (AGEND-245)

Drawn in the real web app (Settings › Agents › the agent › Basic info › Export / Load template), in headless Chromium, against a scratch fleet (its own `AGEND_HOME`, loopback only, no chat channel, dummy values only), built from `feat/tool-library-agent-export` @ d05ffc31b. 8 cases: `{desk,phone}-{light,dark}-{en,zh-TW}` (desktop 1366 wide, phone 390 wide).

- `export-<case>.png` — the Export dialog's new **From the Library** group: *Skills from the Library (4)*, *MCP servers from the Library (3)* (the counts are what the agent has assigned, paused ones included) and *Bundle their definitions in the file* (off by default), the note on what travels, and the start of the file's `library` block (id + sha256 only).
- `export-bundled-<case>.png` — the same with *Bundle* ticked: the block now carries `archive:` (a skill as the Library's own ZIP) and `definition:` (an MCP item's YAML).
- `import-skills-<case>.png`, `import-skills-2-<case>.png` — Load template after **Check** on `example.agend-agent.yaml`, the Skills rows in the four states: **ui-review** *In your Library* (the exact version is here), **notes-writer** *Not in your Library — the file carries it* (read SKILL.md first; ticking adds it to the Library), **legacy-helper** *Not in your Library — only named in the file* (skipped, with a warning), **sleepy** *Different version in your Library* (paused in the file; never replaced: use mine / save the file's under another id / skip).
- `import-mcp-<case>.png` — the MCP rows: the whole command, the variable names with *set / missing* (never a value), the `.env` hint (`MCP_GITHUB_TOKEN`), and the explicit confirmation box that every MCP server needs.
- `example.agend-agent.yaml` — the file that was loaded (`library.skills[].archive` and `library.mcp[].definition` bundled for all but `legacy-helper` and `jira`).

This computer's Library when the file was loaded: `ui-review` (same bytes), `sleepy` (another version), `linear` (same). The values in `.env` are placeholders.
