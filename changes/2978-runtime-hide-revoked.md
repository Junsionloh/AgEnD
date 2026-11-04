---
section: Fixed
---
- A computer you revoke in **Settings → Runtime** no longer stays in the list after the page is refreshed. Right after you revoke it, its card stays in place marked as revoked, and goes when you leave or reload the page. The server keeps the revocation record.
- The Agent list, its Runtime filter, an Agent's Runtime setting, the chat header and the sidebar now name a remote computer instead of showing its full ID. In the Agent list, a computer that is revoked or no longer known to AgEnD reads "Revoked computer" or "Unknown computer" with the first 8 characters of its ID, and points you to the Agent's settings to change its Runtime. The sidebar and chat header show "Computer a5166881" (the first 8 characters of its ID) when no name is known, next to the existing revoked / offline tag.
