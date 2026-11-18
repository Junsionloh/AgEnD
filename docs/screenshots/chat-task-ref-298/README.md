# AGEND-298: task cards in the web chat — screenshots

`scripts/manual/smoke/smoke-298-chat-task-ref.mts` on its 8 cases (desk 1366 / phone 390 × light / dark × English / zh-TW), on the realistic smoke fixture (`scripts/manual/smoke-fixture/`), signed in through the real `/signin`; the delivery to the agent is stubbed.

- `before/` — upstream `release/2.3.5-alpha` (`ab656e927`): `#` opens nothing, the numbers stay text.
- `after/` — this branch: `1-picker` (the list opened by `#`), `2-sent` (the message with its chips; the agent's reply that names a card stays text), `3-card-opened` (a chip opened the card).

`SHA256SUMS` lists the files.
