---
section: Changed
---
- **An agent is told how to write a card comment (AGEND-342).** An agent's comment sometimes showed its steps run together ("1) … ; 2) … ; 3) …" in one paragraph), and not every time. Nothing in AgEnD takes a newline out (the lines go through the tool, the store and the page unchanged, and the page draws a step per line as a list); the comments that came out in one line had no newline in what the agent sent. The only thing the agent was told about a comment was "A comment on the card". The comment field, the `task` tool's description and the `agend-agent task comment` line now say, in a few words: Markdown, one list item or step per line, long text in paragraphs.
