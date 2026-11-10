#!/bin/bash
# usage: fleet.sh start|stop <label> <worktree> <port>
act=$1; label=$2; WT=$3; port=$4
D=/tmp/ev3539-$label
if [ "$act" = start ]; then
  export AGEND_HOME=$D/d HOME=$D/home PATH=$D/bin:$D/home/.local/bin:/usr/local/bin:/usr/bin:/bin AGEND_WSL=0
  unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID
  cd $WT
  setsid nohup node dist/cli.js fleet start > $D/fleet.log 2>&1 < /dev/null &
  echo $! > $D/fleet.pid
  for i in $(seq 1 60); do /usr/bin/curl -s -o /dev/null http://127.0.0.1:$port/ 2>/dev/null && break; sleep 1; done
  sleep 4; echo started pid $(cat $D/fleet.pid)
else
  kill $(cat $D/fleet.pid) 2>/dev/null || true
  sleep 3
  pkill -f "tmux -L agend-.* -f $D/d/tmux" 2>/dev/null || true
fi
