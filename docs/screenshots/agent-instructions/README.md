# Agent Instructions — before and after

Drawn in the real web app, in a headless browser, against two scratch fleets (each with its own `AGEND_HOME`, loopback only, no chat channel): one built from the base of this change (#3624's head, f44a4742d; "Before"), one from this branch ("After"). Both have the same two agents; `claude-kasa` has a description and two tags.

- `agent-instructions-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the 8 cases (desktop 1280 wide, phone 390 wide; light and dark; English and Traditional Chinese). The two builds side by side, "Before" on the left: *Settings → Basic info* of the agent. After, the page has the new **Agent Instructions** card under *Name & description*, shown here with a few lines typed (the unsaved-changes bar is the page's own).
- `preview-{desktop,phone}-{light,dark}-{en,zh-TW}.png` — the same card on its **Preview** tab (the chat's Markdown look), with the counter and the two notes under it.
- `confirm-card-light-en.png`, `confirm-card-dark-zh-TW.png` — saving a change to the text: the confirmation shows the length, a fingerprint and the first words of the text, never the whole of it.

Also checked on these two fleets: with Instructions saved, the file the agent is started with (`fleet-instructions.md`) is the one the "Before" fleet writes, byte for byte, plus one final `## Agent Instructions` section holding the text; an agent without Instructions (the Codex agent here) gets a file identical to the "Before" fleet's.
