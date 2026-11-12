#!/bin/sh
# Start (or stop) an isolated AgEnD instance for the capture: instance.sh start|stop <name> <repo-dir> <health-port>
# Own AGEND_HOME and HOME under cap/run/<name>; the fake claude/grok on PATH; no real credentials; never :8445 or :19280.
set -e
CAP="$(cd "$(dirname "$0")" && pwd)"; cmd=$1; name=$2; repo=$3; port=$4
R="$CAP/run/$name"
case "$cmd" in
start)
  rm -rf "$R"; mkdir -p "$R/home" "$R/ah" "$R/work"
  cat > "$R/ah/fleet.yaml" <<YAML
health_port: $port
preview_port: $((port+1))
defaults:
  backend: claude-code
instances: {}
YAML
  # dist + node: nothing else the instance can reach on PATH but the two fakes, node's own dir and the system bins
  NODEBIN="$(dirname "$(command -v node)")"
  env -i HOME="$R/home" AGEND_HOME="$R/ah" PATH="$CAP/bin:$NODEBIN:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 TMPDIR=/tmp AGEND_WSL=0 \
    sh -c "cd '$repo' && exec node dist/cli.js start" > "$R/fleet.log" 2>&1 &
  echo $! > "$R/pid"
  for i in $(seq 1 60); do curl -fs "http://127.0.0.1:$port/health" >/dev/null 2>&1 && { echo "up $name :$port pid $(cat $R/pid)"; exit 0; }; sleep 1; done
  echo "not up"; tail -20 "$R/fleet.log"; exit 1 ;;
stop)
  [ -f "$R/pid" ] && kill "$(cat "$R/pid")" 2>/dev/null || true ;;
esac
