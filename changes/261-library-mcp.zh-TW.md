---
section: Added
---
- **資源庫 MCP server 可以交給 Agent（AGEND-261）。** 在「設定 → 該 Agent → 工作目錄 → MCP servers」（**＋ 新增**，或資源庫 MCP 列上的 **＋**），
  管理員現在可以把資源庫的 MCP server 掛到 Claude Code 或 Codex 的 Agent 上。頁面會先顯示它實際會執行什麼、需要哪些變數；
  server 在 Agent 下次啟動時寫進它的 MCP 設定，變數值取自 `.env`——有變數沒有值就不啟動。沒掛載任何東西的 Agent 逐 byte 不變。
  另外：透過 API 取代資源庫項目現在要帶讀取時的雜湊、資源庫的 Skill 不能再和內建 Skill 同名、zip 檔名只差 Unicode 形式也視為同名。MCP 項目只能從 `.env` 取用名稱以 `MCP_` 開頭的變數（也可以用另一個名稱交給 server），不能再要求 AgEnD 自己的憑證。
