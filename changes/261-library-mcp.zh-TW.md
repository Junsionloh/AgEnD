---
section: Added
---
- **資源庫 MCP server 可以交給 Agent（AGEND-261）。** 在「設定 → 該 Agent → 工作目錄 → 團隊 MCP server」（或資源庫 MCP 列上的 **＋**），
  管理員現在可以把資源庫的 MCP server 掛到 Claude Code 或 Codex 的 Agent 上。頁面會先顯示它實際會執行什麼、需要哪些變數；
  server 在 Agent 下次啟動時寫進它的 MCP 設定，變數值取自 `.env`——有變數沒有值就不啟動。沒掛載任何東西的 Agent 逐 byte 不變。
  另外：透過 API 取代資源庫項目現在要帶讀取時的雜湊、團隊 Skill 不能再和內建 Skill 同名、zip 檔名只差 Unicode 形式也視為同名。
