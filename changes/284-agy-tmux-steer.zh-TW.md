---
section: Added
---
- **終端機模式的 agy 可以插話到進行中的回合（#3731）。** 在 tmux 裡執行的 `antigravity` instance（agy 1.4.0 以上），`/steer`、web 聊天的 Ctrl+Enter 和 `steer: true` 現在都有效；以前只會被排隊，並標「不支援插話」。agy 依自己的 `Queued Messages` 設定決定訊息怎麼送：預設 `queue` 時，AgEnD 打字後按 `Alt+M`（以和設定相反的方式送出），設為 `send-immediately` 時改按一般的 Enter。兩種情況下進行中的工具都不會被取消：訊息在 agent 下一次呼叫模型之前送到，氣泡標「插話・已送進這一輪」。agy 只在啟動時讀這個設定，所以啟動後設定檔被改過（或設定讀不出來），插話會照舊排隊，直到 instance 重新啟動。一般訊息不變；Windows native pane 沒有 `Alt+M`，所以只有在 `send-immediately` 下才提供插話。
