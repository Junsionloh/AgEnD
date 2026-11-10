#!/bin/bash
# usage: run.sh [probe|all]   — starts BEFORE on :19810 and AFTER on :19811 (each its own copy of the fixture data dir), runs shoot.mjs, stops both.
W=/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir
E=$W/evidence/3537
MODE=${1:-all}
start() { # name port
  local n=$1 port=$2 D=/tmp/ev3537-$1
  rm -rf $D; mkdir -p $D/home; cp -a /tmp/ag133/d $D/d
  sed -i "s#/tmp/ag133#$D#g; s#health_port: .*#health_port: $port#" $D/d/fleet.yaml
  rm -rf $D/d/tmux $D/d/fleet.pid; mkdir -p $D/d/workspaces/a
  ( cd $W/ev3537/$n
    export AGEND_HOME=$D/d HOME=$D/home PATH=/usr/local/bin:/usr/bin:/bin AGEND_WSL=0
    unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID
    setsid nohup node dist/cli.js fleet start > $D/fleet.log 2>&1 < /dev/null &
    echo $! > $D/fleet.pid )
  for i in $(seq 1 40); do /usr/bin/curl -s -o /dev/null http://127.0.0.1:$port/ 2>/dev/null && break; sleep 1; done
}
stop() { local D=/tmp/ev3537-$1; kill $(cat $D/fleet.pid) 2>/dev/null; sleep 3; pkill -f "tmux -L agend-.* -f $D/d/tmux" 2>/dev/null; true; }
start before 19810; start after 19811; sleep 4
for n in before after; do (cd $W/ev3537/$n && node -e 'import("./dist/runtime-cli-install.js").then(m=>console.log(JSON.stringify(Object.values(m.INSTALLABLE_CLIS).map(({id,version,kind})=>({id,version,kind})))))' > /tmp/ev3537-$n/catalog.json); done
HOME=/home/junsionloh LD_LIBRARY_PATH=/home/junsionloh/chromelibs/root/usr/lib/x86_64-linux-gnu PLAYWRIGHT_BROWSERS_PATH=/home/junsionloh/.cache/ms-playwright node $E/shoot.mjs $E $MODE
stop before; stop after
