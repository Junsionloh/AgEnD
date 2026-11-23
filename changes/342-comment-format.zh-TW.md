---
section: Changed
---
- **agent 現在會被告知卡片留言該怎麼寫（AGEND-342）。** agent 的留言有時候會把步驟擠成一段（「1) … ；2) … ；3) …」全在同一個段落），而且不是每次。AgEnD 沒有任何一段會把換行拿掉（換行經過工具、資料庫和頁面都原樣保留，頁面也會把一行一個的步驟畫成列表）；擠成一行的留言，是 agent 送出的字串裡本來就沒有換行。而 agent 對留言唯一的說明只有「A comment on the card」。現在留言欄位、`task` 工具的說明和 `agend-agent task comment` 那一行都用幾個字說明：用 Markdown，列點或步驟每項各自一行，長內容分段。
