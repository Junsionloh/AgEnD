---
section: Fixed
---
- **ACP agent 不會再因終端機啟動留下的設定而沒有 AgEnD 工具，終端機指令也不會被當成 prompt（#3731）。** ACP instance 現在把自己的工具宣告為 MCP server `agend_acp`：grok 會用資料夾裡的 `.mcp.json` 依名稱蓋掉 client 傳來的工具，終端機啟動留下的 `agend` 項目因此取代了它們，agent 沒有 `reply` 工具（一句 `hi` 花了兩分鐘在找工具）。tmux ↔ ACP 互相切換兩個方向都不需要清理，agy 的全域啟動器也不會帶任何 instance 的身分。ACP agent 的 MCP server 在 45 秒內沒有連上時，會像終端機 agent 一樣被回報（通知、Log、聊天時間軸上的錯誤）。`/effort` 與 `/model` 改為透過 ACP 設定 agent 自己的 session 設定（不重啟、也不輸入任何文字給它；agent 不提供的值會被拒絕並列出它提供的值），設定的 effort 與 model 在每次啟動時套用；`/compact`、`/clear`、`/save`、`/load`、`/raw` 會回覆「ACP 模式不支援」，不會當成問題送給 agent。
