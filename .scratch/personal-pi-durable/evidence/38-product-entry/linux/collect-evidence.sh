set -eu
r38_dir=/tmp/r38-linux-JgNUHm
python3 - "$r38_dir" <<'PY'
from pathlib import Path
import json,os,time
work=Path(__import__('sys').argv[1]);out=[];excluded={os.getpid(),os.getppid()}
for entry in Path('/proc').iterdir():
 if not entry.name.isdigit() or int(entry.name) in excluded:continue
 try:
  if entry.stat().st_uid!=os.getuid():continue
  command=(entry/'cmdline').read_bytes().replace(b'\0',b' ').decode(errors='replace').strip()
  cwd=os.readlink(entry/'cwd')
 except (FileNotFoundError,ProcessLookupError,PermissionError):continue
 if str(work) in command or str(work) in cwd:out.append({'pid':int(entry.name),'cwd':cwd,'command':command})
(work/'logs/remaining-processes.json').write_text(json.dumps(out,indent=2)+'\n')
(work/'logs/test-temp-remaining.json').write_text(json.dumps([str(p) for p in (work/'tmp').iterdir()],indent=2)+'\n')
(work/'logs/sdk-package.json').write_text((work/'sdk/package.json').read_text())
(work/'logs/sdk-package-lock.json').write_text((work/'sdk/package-lock.json').read_text())
(work/'logs/resource-summary.json').write_text(json.dumps({'timestamp':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'scope':'仅本轮新目录；不安装完整workspace，不修改现存依赖、源码、单元或服务','rootDependencies':'/opt/ruukoto/node_modules','extraReadOnlyDependencies':'/tmp/ruukoto-agent-wait-20261014-root/node_modules','personalDependencies':str(work/'sdk/node_modules'),'dependencyMode':'共享依赖只读复用，个人最小prefix新装1.3；非干净全workspace安装','remainingProcesses':len(out)},ensure_ascii=False,indent=2)+'\n')
if out:raise SystemExit('本轮仍有未核实进程，保留现场')
PY
cp "$r38_dir/source-sha256.txt" "$r38_dir/logs/source-sha256.txt"
cp "$r38_dir/source/deploy/systemd/ruukoto-backend.service" "$r38_dir/logs/template-source.service"
cp "$r38_dir/ruukoto-backend.service" "$r38_dir/logs/template-rendered.service"
du -sk "$r38_dir" > "$r38_dir/logs/pre-cleanup-space.txt"
df -k /tmp > "$r38_dir/logs/disk-pre-cleanup.txt"
tar -czf "$r38_dir/evidence.tar.gz" -C "$r38_dir" logs setup.sh run-checks.sh fix-dependency-layout.sh collect-evidence.sh
sha256sum "$r38_dir/evidence.tar.gz"
