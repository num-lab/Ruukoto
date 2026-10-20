import os, pty, select, subprocess, time, json, re
from pathlib import Path
root = Path('/tmp/rk20-pty')
master, slave = pty.openpty()
process = subprocess.Popen(['node', '--import', 'tsx', str(root / 'scenario.mjs')], cwd='/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable', stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
os.set_blocking(master, False)
output = bytearray()
pending = bytearray()
actions = []
def until(needle, timeout=30):
    global pending
    target = needle.encode()
    end = time.monotonic() + timeout
    while target not in pending:
        if time.monotonic() > end:
            raise TimeoutError(f'Timeout awaiting {needle!r}; tail={pending[-700:]!r}')
        ready, _, _ = select.select([master], [], [], min(1, max(0.01, end-time.monotonic())))
        if ready:
            try: chunk = os.read(master, 65536)
            except OSError: chunk = b''
            if not chunk: raise RuntimeError(f'PTY closed awaiting {needle!r}; exit={process.poll()}')
            output.extend(chunk)
            pending.extend(chunk)
    cut = pending.index(target) + len(target)
    pending = pending[cut:]
def send(value, description):
    global pending
    payload = (value + '\n').encode()
    while payload:
        ready_r, ready_w, _ = select.select([master], [master], [], 2)
        if ready_r:
            chunk = os.read(master, 65536)
            output.extend(chunk)
            pending.extend(chunk)
        if ready_w:
            try: count = os.write(master, payload[:256])
            except BlockingIOError: continue
            payload = payload[count:]
    actions.append({'input': value if len(value) < 100 else f'<evidence: {len(value)} characters>', 'purpose': description})
try:
    until('请选择：'); send('15', '完整个人向导选择管理服务效果核实')
    until('请选择：'); send('9', '原操作列表翻至第二页')
    until('请选择：'); send('1', '选择 example.service，无需输入内部标识')
    until('请选择：'); send('1', '刷新原操作，不发写请求')
    until('请选择：'); send('2', '选择确认已生效')
    until('独立核实后的证据说明（最多 8192 字符，不填凭据；/back 返回）：')
    evidence = (root / 'evidence-input.txt').read_text()
    send(evidence, '保存独立核实说明')
    until('请选择：'); send('3', '读取核实说明第二页')
    until('请选择：'); send('2', '单独登记原写操作停止重核')
    until('请选择：'); send('1', '停止登记后刷新原状态，不重复 POST')
    until('请选择：'); send('4', '返回服务列表')
    until('请选择：'); send('10', '返回个人主菜单')
    until('请选择：'); send('10', '退出向导')
    exit_deadline = time.monotonic() + 15
    while process.poll() is None:
        if time.monotonic() > exit_deadline: raise TimeoutError('CLI did not exit after exit selection')
        ready, _, _ = select.select([master], [], [], 1)
        if ready:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            output.extend(chunk)
    process.wait(timeout=10)
    assert process.returncode == 0, process.returncode
finally:
    (root / 'terminal.log').write_bytes(output)
    (root / 'actions.json').write_text(json.dumps(actions, ensure_ascii=False, indent=2)+'\n')
    if process.poll() is None: process.terminate(); process.wait(timeout=10)
    os.close(master)
text = output.decode('utf-8', errors='replace')
assert '第一页开始；' in text
assert '第二页末尾。' in text
assert '原效果核实及证据已保存，不可覆盖' in text
assert '登记不表示已停止，也不确认写入效果' in text
assert '最近停止重核：重核进行中' in text
assert '未知效果须效果和停止均核实后才释放占用；不会重新执行 restart' in text
for forbidden in ['120012', 'hidden-request-pty', 'taskId', 'requestId', 'UUID']:
    assert forbidden not in text, forbidden
assert text.count('确认已生效') == 2
requests = json.loads((root / 'requests.json').read_text())
assert sum(r['route'].startswith('POST ') for r in requests) == 2
(root / 'observations.txt').write_text('PASS: Python 标准库真实 PTY 驱动完整 runPersonalCli；stdin/stdout 均 isTTY。\nPASS: 选择主菜单、原服务列表分页、详情刷新、保存已生效证据、说明分页、独立停止登记、刷新、逐层返回及退出。\nPASS: 每条 Unix socket HTTP 请求均验证本机 Bearer token；仅各一次效果核实 POST 与停止 POST。\nPASS: 停止替身只返回 requested，详情继续显示停止未核实与重核进行中；向导未把登记说成停止通过。\nPASS: 终端没有 taskId/requestId/UUID 或内部值；所有标识由原菜单固定。\n范围: Unix HTTP 与服务状态使用本机替身；未接真实 systemd/helper、模型或 Telegram。\n', encoding='utf-8')
print(json.dumps({'passed': True, 'exit': process.returncode, 'requests':len(requests), 'actions':len(actions), 'artifactDirectory':str(root)}, ensure_ascii=False))
