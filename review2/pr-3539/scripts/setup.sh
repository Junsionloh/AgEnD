#!/bin/bash
# usage: setup.sh <label> <port>   — builds /tmp/ev3539-<label> from a COPY of the old fixtures with FAKE CLIs of the versions this evidence needs. Fixtures in /tmp/ag136 are never touched.
set -e
label=$1; port=$2
S=/home/junsionloh/multica_workspaces/agend-bcac6942356a/agend-144-ffe4cc7a7f14/workdir/evidence/3539/scripts
D=/tmp/ev3539-$label
rm -rf $D; mkdir -p $D
cp -a /tmp/ag136/home $D/home; cp -a /tmp/ag136/d $D/d
rm -rf $D/d/tmux $D/d/fleet.pid 2>/dev/null || true
sed -i "s#/tmp/ag136#$D#g; s#health_port: .*#health_port: $port#" $D/d/fleet.yaml
mkdir -p $D/d/workspaces/a $D/ctl $D/bin
sed "s#__CTL__#$D/ctl#" $S/bin/curl > $D/bin/curl; chmod +x $D/bin/curl
fake() { # path name-for-output version-string
  printf '#!/bin/sh\ncase "$1" in --version|-v|version) echo "%s";; *) echo "fake %s";; esac\n' "$3" "$2" > "$1"; chmod +x "$1"; }
H=$D/home
fake $H/.local/bin/claude claude "2.1.320 (Claude Code)"          # newer than audited 2.1.319
fake $H/.local/bin/codex codex "codex-cli 0.167.0"                  # current
fake $H/.local/bin/kiro-cli kiro-cli "kiro-cli 2.37.0"              # behind (audited 3.1.0) -> Update (failure shim)
fake $H/.grok/bin/grok grok "grok 1.0.70 (50ca579fa996)"            # behind (audited 1.0.77) -> Update (slow / ok shim)
rm -f $H/.opencode/bin/opencode                                       # opencode NOT installed -> an Install button (and the install-only row)
fake $H/.local/bin/agy antigravity "1.3.6"                          # behind, self-updating: no button
echo "1.4.12-R6909.1" > $H/.local/bin/.muse-version                  # muse with a build, self-updating: no button
echo "$D"
