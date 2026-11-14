---
section: Changed
---
- **Instance 現在透過 adapter 介面執行，目前唯一的 adapter 是 tmux（#3731）。** instance 的執行方式完全不變：同樣的 tmux pane、啟動指令、投遞與取消路徑。只能在終端機使用的操作，改為詢問 adapter 有沒有 pane，不再預設一定有。新增選填的 `cli_adapter` 設定（可設在 instance 或 `defaults`），目前只接受 `tmux`；其他值在載入設定時就會被拒絕。
