#!/usr/bin/env bash
# AGEND-305: turn a freshly published integration preview (agend-preview.ps1 publish integration/tasks-revamp -Issue AGEND-305)
# into the demo: four mock agents (lead, dev-a, dev-b, docs) that quote what they are told, and a seeded board. Idempotent on a
# FRESH publish only (the seed creates projects and cards; run it once per publish). Preview-only: nothing here is product code.
set -euo pipefail
DK="${DK:-/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe}"
PS1='C:\Users\junsionloh\agend-preview\agend-preview.ps1'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=agend-preview
"$DK" exec "$C" sh -c 'mkdir -p /data/workspaces/lead /data/workspaces/dev-a /data/workspaces/dev-b /data/workspaces/docs; [ -f /data/fleet.yaml.orig ] || cp /data/fleet.yaml /data/fleet.yaml.orig'
"$DK" exec -i "$C" sh -c 'cat > /data/fleet.yaml' < "$HERE/fleet.demo.yaml"
for f in patch-mock.mjs seed.mjs; do "$DK" exec -i "$C" sh -c "cat > /tmp/$f" < "$HERE/$f"; done
"$DK" exec "$C" node /tmp/patch-mock.mjs
"$DK" exec "$C" node --check /app/e2e/mock-servers/mock-claude.mjs
"$DK" exec "$C" node /tmp/seed.mjs       # written while the old fleet runs; the restart below loads it
pwsh.exe -NoProfile -File "$PS1" restart
