---
section: Changed
---
- **人留言叫醒 agent 的任務板通知，會提示 agent 這張卡是人在看（AGEND-339）。** agent 被「web-user mentioned you」叫醒後，回了 `@web-user`，結果被告知沒有這個 instance、沒有人被叫醒。現在，人寫的留言或 `@mention` 的 `[Task board]` 通知結尾會加上「(a person reads the card; no @ needed)」。instance 的留言（`@` 可能正是對的回應）不加這句，誰會被叫醒也沒有其他改變。
