---
section: Added
---
- **grok 與 antigravity 的 instance 可以改用 ACP 執行，不再需要終端機（#3731）。** 在 instance 設定 `cli_adapter: acp`（或在表單選 **ACP**）：CLI 會作為自己的 Agent Client Protocol 伺服器執行，不開 tmux pane。聊天的活動區塊即時顯示工具進度（依該 agent 的 `tool_progress` 裁切，和任何 CLI 一樣），開了 `web.log_thinking` 的 admin 也能看到思考文字；權限請求是區塊裡有 允許／拒絕／取消這回合 的卡片，預設詢問（`acp_always_approve: true` 會自己「僅此一次允許」，絕不選「永遠」）。取消、當機重啟、卡住偵測、重啟後接續儲存的對話都可使用；CLI 版本不在測試清單（grok 1.0.77、agy 1.5.8、1.5.9）時，會以訊息拒絕而不是啟動。這類 instance 沒有終端機畫面，也不能 `agend attach`。其他 instance 完全照舊。
