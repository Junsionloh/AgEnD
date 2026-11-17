---
section: Added
---
- **ACP agent 在六個地方追上終端機模式的 agent（#3731）。** ACP instance 可以用具名帳號執行（`backend_options.<cli>.credential_profile`：grok 用自己的 `GROK_HOME`，agy 用 `--app_data_dir`；子行程不會拿到預設帳號的任何變數）。`auto_pause_after` 會暫停閒置的 ACP instance（閒置由回合狀態判斷，不看畫面），下一則訊息會把它喚醒。context 數字會出現在儀表板、`/ctx` 和 `/status`（agy 的 `usage_update`；grok 則是每次呼叫的 token 回報除以該模型的視窗）。`skipPermissions: false` 時，權限請求也會是 Telegram 或 Discord 話題裡的一張卡片（僅此一次允許／拒絕／取消這回合；只限 fleet admin）。送給忙碌 ACP agent 的訊息預設排隊到這一輪結束，和終端機一樣；`/steer <訊息>`，或其他 instance 帶 `steer: true`，則是插話：兩個 CLI 都把它加進進行中的回合、不取消（grok 用自己的 `_x.ai/interject`，agy 把第二個 prompt 折進這一輪）；只有 CLI 拒絕時才取消進行中的回合，在同一個 session 接著送這則，排在佇列前面。額度通知仍不支援（ACP 沒有額度事件）。已停止或沒登入的 ACP agent，Log 不再指向它沒有的 View。
- **ACP agent 在聊天裡的工作區塊，精確掛在它的回覆上。** daemon 同時握有 agent 的 `session/update` 串流和 fleet 對每則回覆的回應，所以每則回覆的步驟區塊現在用該氣泡自己的 message id 掛在它上方，不再靠文字、時間或「這一輪的最後一則」推測。回合結尾只有文字、沒用 `reply` 工具（agy 在背景跑指令時的習慣）時，會留下和呼叫 `reply` 一樣的回覆步驟，步驟不會再掛到別的氣泡上，這段文字也不會在區塊裡再顯示一次。
