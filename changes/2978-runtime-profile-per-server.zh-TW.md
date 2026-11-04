---
section: Fixed
---
- **已配對到另一個 AgEnD 的電腦現在也能連線（#2978）。** 從連線就緒的 ZIP 雙擊 `connect-agend.bat` 時，會保留原有配對，並在 `profiles\<host>-<port>` 下為新的 server 另外配對一個獨立 profile；同一個 bat 以及在該資料夾執行的 `run`/`status`/`rotate`/`disconnect` 都會重用它。憑證不會被送往不同的 server，明確指定 `--profile` 時行為不變。`disconnect` 與 `rotate` 不再被 Windows 重開機前留下的鎖擋住；真的還在執行的 Runtime 仍保有它的鎖，訊息會指出要檢查的程序。
