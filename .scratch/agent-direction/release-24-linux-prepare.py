"""在隔离上传副本执行；保留现役部署，仅改验收资源路径。"""
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
if not root.name.startswith("ruukoto-release24-src-") or (root / ".git").exists():
    raise SystemExit("仅允许无 .git 的 ruukoto-release24-src-* 隔离上传副本")
def replace_file(rel, replacements):
    p = root / rel
    text = p.read_text()
    for old, new in replacements:
        if new in text:
            continue
        if old not in text:
            raise RuntimeError(f'{rel}: 缺少预期片段 {old!r}')
        text = text.replace(old, new)
    p.write_text(text)

# 新版 smoke04 已按本次 taskIds 清理；旧版才应用限定清理补丁。
smoke04 = (root / '.scratch/agent-direction/smoke-04-desktop-execution.mts').read_text()
if '"name=ruukoto-task-"' in smoke04:
    replace_file('.scratch/agent-direction/smoke-04-desktop-execution.mts', [
        ('let t: TestRuntime | null = null;', 'const submittedTaskIds: string[] = [];\nlet t: TestRuntime | null = null;'),
        ('return client.request<any>("submit", {', 'const task = await client.request<any>("submit", {'),
        ('    });\n  };\n\n  // ---- 1.', '    });\n    submittedTaskIds.push(task.id);\n    return task;\n  };\n\n  // ---- 1.'),
        ('docker(["ps", "-aq", "--filter", "name=ruukoto-task-"])\n    .split("\\n")', 'submittedTaskIds.flatMap((taskId) => docker(["ps", "-aq", "--filter", `name=ruukoto-task-${taskId}`]).split("\\n"))'),
    ])
# helper 协议与实现保持原样，只替换可信部署路径。
replace_file('deploy/systemd/ruukoto-service.mjs', [
    ('/etc/ruukoto/services.json', '/etc/ruukoto-release24/services.json'),
    ('/var/lib/ruukoto/service-ops', '/var/lib/ruukoto-release24/service-ops'),
])
replace_file('deploy/systemd/ruukoto-service-test.sh', [('/var/lib/ruukoto-service-test', '/var/lib/ruukoto-service-release24-test')])
replace_file('deploy/systemd/ruukoto-service-test.service', [
    ('/usr/local/libexec/ruukoto/ruukoto-service-test.sh', '/usr/local/libexec/ruukoto-release24/ruukoto-service-test.sh'),
    ('/var/lib/ruukoto-service-test', '/var/lib/ruukoto-service-release24-test'),
])
for number in ('09', '10'):
    replace_file(f'.scratch/agent-direction/smoke{number}-remote.mts', [
    (f'/var/lib/ruukoto-smoke{number}', f'/var/lib/ruukoto-release24-smoke{number}'),
    (f'/tmp/smoke{number}-backend.log', f'/tmp/release24-linux-{number}-backend.log'),
    ('/usr/local/libexec/ruukoto/ruukoto-service', '/usr/local/libexec/ruukoto-release24/ruukoto-service'),
    ('/etc/ruukoto/services.json', '/etc/ruukoto-release24/services.json'),
    ('/var/lib/ruukoto/service-ops', '/var/lib/ruukoto-release24/service-ops'),
    ('/etc/sudoers.d/ruukoto"', '/etc/sudoers.d/ruukoto-release24-service"'),
    ('ruukoto-service-test.service', 'ruukoto-service-release24-test.service'),
    ('${SRC}/deploy/systemd/ruukoto-service-release24-test.service', '${SRC}/deploy/systemd/ruukoto-service-test.service'),
    ('/var/lib/ruukoto-service-test', '/var/lib/ruukoto-service-release24-test'),
    ('const repoSudoers = fs.readFileSync(`${SRC}/deploy/systemd/sudoers.d.ruukoto`, "utf8");', 'const repoSudoers = `ruukoto-backend ALL=(root) NOPASSWD: ${HELPER}\\n`;'),
    ('  if (homeCreated) await rec("删隔离目录", () => sudo(["rm", "-rf", SMOKE_HOME]).then(() => {}));', '  if (homeCreated) await rec("删隔离目录", () => sudo(["rm", "-rf", SMOKE_HOME]).then(() => {}));\n  await rec("删除本次隔离 helper/policy/ops/sudoers", () => sudo(["rm", "-rf", "/usr/local/libexec/ruukoto-release24", "/etc/ruukoto-release24", "/var/lib/ruukoto-release24", SUDOERS]).then(() => {}));'),
    ('console.log(`按真实部署保留：${HELPER}', 'console.log(`本次独立部署资源已清理：${HELPER}'),
])
print('隔离路径与限定容器清理已准备')
