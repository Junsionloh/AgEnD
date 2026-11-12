---
section: Added
---
- **實驗功能，預設關閉：Grok 保留終端機，對話裡即時顯示它的思考與工具呼叫（#3731）。** 在 Grok instance 設定 `backend_options.grok.leader_observer: true`，AgEnD 會為這個 instance 啟動它專屬的 Grok leader，讓終端機和另一個唯讀的連線共用同一個 session。唯讀連線只聽、不送：不會送出提示、取消或按鍵，也不會回覆權限請求（由終端機回覆）。一輪進行中，對話的活動區塊會顯示正在執行的呼叫；管理員開啟思考顯示時，還會顯示目前的思考內容。只在已稽核的 Grok 版本啟用（目前只有 1.0.77）；其他版本，以及任何無法確認舊 leader 已結束的情況，都維持原本行為。沒有這個設定時一切照舊：Grok 仍以 `--no-leader` 啟動。
