#!/usr/bin/env bash
# 在 tx 上上传副本的仓库根目录执行；只添加/清理本次固定执行入口。
set -euo pipefail
ruukoto_release_src=$(pwd)
ruukoto_release_wrapper=$(mktemp /tmp/ruukoto-release24-launch-XXXXXX)
ruukoto_release_sudoers=$(mktemp /tmp/ruukoto-release24-sudoers-XXXXXX)
cleanup() {
  sudo -n rm -f /etc/sudoers.d/ruukoto-release24-exec /usr/local/libexec/ruukoto-release24/ruukoto-exec-launch /usr/local/libexec/ruukoto-release24/ruukoto-exec-stop
  sudo -n rm -rf /usr/local/lib/ruukoto-release24-worker
  rm -f "$ruukoto_release_wrapper" "$ruukoto_release_sudoers" /tmp/release24-worker.mjs
}
trap cleanup EXIT
node_modules/.bin/esbuild src/agent/tool-worker/worker.ts --bundle --format=esm --platform=node --target=node24 '--external:@earendil-works/*' --outfile=/tmp/release24-worker.mjs
sudo -n install -D -m 0644 /tmp/release24-worker.mjs /usr/local/lib/ruukoto-release24-worker/worker/worker.mjs
sudo -n ln -s "$ruukoto_release_src/node_modules" /usr/local/lib/ruukoto-release24-worker/node_modules
python3 - "$ruukoto_release_src" "$ruukoto_release_wrapper" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
s=(root/'deploy/systemd/ruukoto-exec-launch.sh').read_text()
s=s.replace('WORKER="${RUUKOTO_WORKER_PATH:-/opt/ruukoto/worker/worker.mjs}"','WORKER="/usr/local/lib/ruukoto-release24-worker/worker/worker.mjs"').replace('${RUUKOTO_EXEC_UID:-1002}','986').replace('${RUUKOTO_EXEC_GID:-1002}','986')
Path(sys.argv[2]).write_text(s)
PY
sudo -n install -D -m 0700 "$ruukoto_release_wrapper" /usr/local/libexec/ruukoto-release24/ruukoto-exec-launch
sudo -n install -D -m 0700 deploy/systemd/ruukoto-exec-stop.sh /usr/local/libexec/ruukoto-release24/ruukoto-exec-stop
printf '%s\n' 'ruukoto-backend ALL=(root) NOPASSWD: /usr/local/libexec/ruukoto-release24/ruukoto-exec-launch, /usr/local/libexec/ruukoto-release24/ruukoto-exec-stop' > "$ruukoto_release_sudoers"
sudo -n visudo -cf "$ruukoto_release_sudoers"
sudo -n install -m 0440 "$ruukoto_release_sudoers" /etc/sudoers.d/ruukoto-release24-exec
sudo -n -u ruukoto-backend env RUUKOTO_EXEC_LAUNCH_SCRIPT=/usr/local/libexec/ruukoto-release24/ruukoto-exec-launch RUUKOTO_EXEC_STOP_SCRIPT=/usr/local/libexec/ruukoto-release24/ruukoto-exec-stop RUUKOTO_EXEC_UID=986 RUUKOTO_EXEC_GID=986 /usr/bin/node "$ruukoto_release_src/node_modules/.bin/tsx" "$ruukoto_release_src/.scratch/agent-direction/release-24-linux-full-access.mts"
