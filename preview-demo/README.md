# Integration preview demo (AGEND-305)

Preview-only tooling, not product code. After `agend-preview.ps1 publish integration/tasks-revamp -Issue AGEND-305`:

    bash setup.sh        # 4 mock agents (lead, dev-a, dev-b, docs) + a seeded board, then restarts the preview

- `fleet.demo.yaml` — replaces the preview's fleet.yaml (the originals stay in /data/fleet.yaml.orig).
- `patch-mock.mjs` — the container's mock agent (e2e/mock-servers/mock-claude.mjs) quotes what it is told (a board notice, a
  chat message) in its reply, then looks busy for 40 s (MOCK_BUSY_S) so the board's Running mark can be seen.
  A mock has no tool steps: the Agent activity block says so.
- `seed.mjs` — projects 排行榜 (lead: `lead`) and 帳務, cards in every status, watchers (`docs` on M-1 and M-6), written with the
  board's own code before the restart, so nothing wakes while it is written.
Each publish starts with empty data: run `setup.sh` once per publish.
