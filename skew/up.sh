#!/bin/sh
# Throwaway fleet: isolated HOME and AGEND_HOME, temp named accounts only. Port 19793.
W=/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-132-c29e606c811e/workdir
D=/tmp/ag132s/d; H=/tmp/ag132s/home; P=19793
rm -rf /tmp/ag132s; mkdir -p $D/workspaces $H $D/credential-profiles/claude-code/work $D/credential-profiles/claude-code/off
printf 'defaults:\n  backend: claude-code\ninstances: {}\nhealth_port: %s\nweb:\n  preview: false\n' $P > $D/fleet.yaml
echo '{"oauthAccount":{"accountUuid":"00000000-0000-4000-8000-000000000001"}}' > $D/credential-profiles/claude-code/work/.claude.json
echo "{\"claudeAiOauth\":{\"accessToken\":\"$(printf c%.0s $(seq 32))\",\"refreshToken\":\"$(printf c%.0s $(seq 32))\",\"expiresAt\":$(( $(date +%s)*1000 + 86400000 ))}}" > $D/credential-profiles/claude-code/work/.credentials.json
cd $W/AgEnD && AGEND_HOME=$D HOME=$H PATH=/home/junsionloh/.local/bin:$PATH AGEND_WSL=0 setsid nohup node dist/cli.js fleet start >> /tmp/ag132s/fleet.log 2>&1 < /dev/null &
echo $! > /tmp/ag132s/fleet.pid
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:$P/signin && break; sleep 1; done
curl -s -o /dev/null -w "fleet %{http_code}\n" http://127.0.0.1:$P/signin
