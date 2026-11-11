---
section: Added
---
- **An agent can have its own Instructions.** In an agent's Settings › Basic info, write Markdown for one agent — who it is, how it works, the rules it follows — with an Edit / Preview switch and a counter (characters and bytes; up to 24,000 characters; a note that Codex reads at most 32 KiB of `AGENTS.md` in total). It is saved as `instructions:` under the agent in `fleet.yaml`, beside `systemPrompt` (which is untouched and stays in Advanced), and AgEnD puts it as the last section of what the AI is told, under "Agent Instructions", the next time the agent starts. An agent without Instructions is told exactly what it was told before. The save confirmation shows the length, a fingerprint and the first words instead of the whole text.
