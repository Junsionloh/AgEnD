---
section: Fixed
---
- AgEnD 中斷連線時，`connect-agend.bat` 不再讓視窗一閃而過：視窗會保持開啟，說明原因（電腦已被撤銷或不被辨識、同一組配對被另一個 Runtime 接手、或訊息被拒絕）與下一步，且 Runtime 以非 0 的結束碼離開。若資料夾仍保留另一個 AgEnD 的工作紀錄，現在不會再重送給新的伺服器（過去會在顯示「Connected」之後立刻被中斷）。
