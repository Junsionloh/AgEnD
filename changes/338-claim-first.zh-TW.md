---
section: Changed
---
- **內建 workflow 現在會提醒 agent 先認領卡片再動手（AGEND-338）。** 真的 agent 曾對還沒認領的卡直接移到待確認，被拒絕。內建 workflow 的任務板那一行（以及 CLI 指示裡 `agend-agent task claim` 那一行）現在寫明要先認領（`task claim`）。只加了一小句，因為每個 agent 的 prompt 都帶著它；任務板關閉時它和任務板的其他指引一起拿掉，自訂的 workflow 不受影響。
