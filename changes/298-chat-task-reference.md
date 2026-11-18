---
section: Added
---
- **Refer to a task card in an instance's web chat (AGEND-298).** Type `#` in the chat box to pick a card from the board (by number or by words of the title); the box holds its number, `#M-3`. A number typed by hand counts too. In the conversation a number that is a card becomes a chip with its number, title and status that opens the card, and when the message is sent the agent gets the card's number, status, title and owner under your words, with how to read it in full (`task get`). A number that is no card is just text. Nothing new is stored, so older chats read as before; Telegram and Discord messages are unchanged.
