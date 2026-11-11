---
section: Added
---
- **Agent 可以有自己的 Instructions。** 在「設定 › 基本資料」替單一 Agent 寫 Markdown：它是誰、怎麼做事、要遵守的規則；有「編輯／預覽」切換與字數計（字元與 bytes，上限 24,000 字元，並提示 Codex 讀 `AGENTS.md` 一共最多 32 KiB）。內容存成 `fleet.yaml` 裡該 Agent 的 `instructions:`，和 `systemPrompt` 並存（`systemPrompt` 完全不動、仍在「進階」），AgEnD 會在 Agent 下次啟動時，把它放在給 AI 的指令最後一段「Agent Instructions」。沒有填 Instructions 的 Agent，被告知的內容和以前一模一樣。儲存時的確認畫面顯示字數、指紋與前幾十字，而不是整份內容。
