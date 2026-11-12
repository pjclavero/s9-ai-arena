#!/usr/bin/env bash
# G2 · uso: g2-tanda.sh <SHA> <nombre> <cmd...>  (VM112, bajo heavy.lock, timeout 590, primer plano)
set -u
case "$(hostname)" in ia-server) echo STOP; exit 1;; esac
export PATH=/srv/s9-test/toolchain/node/bin:$PATH NODE_OPTIONS=--max-old-space-size=2048
SHA="$1"; NAME="$2"; shift 2
WT=/srv/s9-test/wt-ola2-g2
exec 9>/srv/s9-test/wt-ola2-g2.lock; flock -n 9 || { echo WT_BUSY; exit 95; }
cd "$WT" || exit 90
git fetch -q origin || exit 91
git checkout -q -- . ; git clean -fdq -e node_modules >/dev/null 2>&1
git checkout -q --detach "$SHA" || exit 92
echo "HEAD=$(git rev-parse HEAD)"
LOG=/tmp/g2-$NAME.log
flock -o /srv/s9-test/heavy.lock timeout 590 "$@" > "$LOG" 2>&1
RC=$?
echo "CMD_RC=$RC"
sed "s/\x1b\[[0-9;]*m//g" "$LOG" | grep -E "Test Files|Tests |FAIL |✗|×" | sort -u | head -${G2_LINES:-60}
echo "TREE=$( [ -z "$(git status --porcelain --untracked-files=no)" ] && echo limpio || echo SUCIO)"
exit $RC
