---
section: Fixed
---
- **用 `#` 引用卡片時，每種 runtime 都會被告知怎麼讀整張卡（AGEND-333）。** `#M-3` 引用下面那行「用工具讀整張卡」的提示，以前 native（Windows）agent 沒有，但它們其實有 `task` 工具。現在每種 runtime 都有，而且寫成那個 agent 實際能用的方式：有 MCP 工具的寫 `task get M-3`（detail: true），CLI 模式寫 `agend-agent task get M-3 --detail`；工具組沒有 `task` 工具（`minimal`）的 agent 會被告知它沒有這個工具，不再叫它用一個會被拒絕的工具。
