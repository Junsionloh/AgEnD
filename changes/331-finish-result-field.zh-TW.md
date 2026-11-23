---
section: Fixed
---
- **完成卡片時漏了結果，現在會說明要填哪個欄位（AGEND-331）。** 真的 agent 把卡片移到待確認或完成時，把總結寫在 `comment`，只被告知「finishing needs a result」，結果又犯同樣的錯一次才找到 `result`。完成，以及從待確認重新送出這兩種拒絕，現在都會說結果要放在 `result` 欄位，留言不算。什麼時候需要結果的規則沒有變。
