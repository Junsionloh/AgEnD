#!/bin/bash
# probe the longest leader socket path grok accepts (Linux). Only touches /tmp/gl/aaaa*.
for n in 100 103 104 106 107 108; do
  pad=$(( n - 8 - 5 ))            # "/tmp/gl/" is 8 bytes, ".sock" 5
  name=$(head -c $pad < /dev/zero | tr '\0' a).sock
  p="/tmp/gl/$name"
  echo "len=${#p}"
  setsid nohup grok agent leader --leader-socket "$p" --relay-on-demand --no-auto-update >/tmp/gl/ev/len.out 2>&1 </dev/null &
  sleep 3
  if [ -S "$p" ]; then
    echo "  socket OK; files: $(ls /tmp/gl | grep -c '^aaaa')"
    P=$(ps -eo pid,args | awk -v s="$p" '$2=="grok" && $5=="--leader-socket" && $6==s {print $1}')
    echo "  pid=$P"; [ -n "$P" ] && kill $P
  else
    echo "  NO socket: $(tail -1 ~/.grok/leader.log | cut -c1-160)"
    P=$(ps -eo pid,args | awk -v s="$p" '$2=="grok" && $5=="--leader-socket" && $6==s {print $1}')
    [ -n "$P" ] && kill $P
  fi
  sleep 1
  rm -f -- /tmp/gl/aaaa*
done
