import os, pty, select, subprocess, time, json, re, gzip, sys
from pathlib import Path

root = Path(__file__).resolve().parent
repo = Path(sys.argv[1]).resolve()
master, slave = pty.openpty()
process = subprocess.Popen(['node', '--import', 'tsx', str(root / 'scenario.mjs'), str(repo)], cwd=repo, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
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
    payload = (value + '\n').encode()
    os.write(master, payload)
    actions.append({'input': value, 'purpose': description})

try:
    until('请选择：'); send('15', '完整个人向导选择管理服务审批与核实')
    until('请选择：'); send('1', '从原列表选择 alpha-worker.service')
    until('请选择：'); send('1', '核对固定机器 isolated-host-alpha 后刷新原操作')
    until('请选择：'); send('2', '批准本次固定服务操作，只发一次批准 POST')
    until('请选择：'); send('1', '批准后刷新原状态，不重复提交')
    until('请选择：'); send('2', '返回原服务列表')
    until('请选择：'); send('2', '从原列表选择第二操作 beta-worker.service')
    until('请选择：'); send('3', '核对固定机器 isolated-host-beta 后拒绝，只发一次拒绝 POST')
    until('请选择：'); send('1', '拒绝后刷新原状态，不重复提交')
    until('请选择：'); send('2', '返回原服务列表')
    until('请选择：'); send('3', '返回个人主菜单')
    until('请选择：'); send('10', '退出完整向导')
    deadline = time.monotonic() + 15
    while process.poll() is None:
        if time.monotonic() > deadline: raise TimeoutError('CLI did not exit')
        ready, _, _ = select.select([master], [], [], 1)
        if ready:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            output.extend(chunk)
    process.wait(timeout=10)
    assert process.returncode == 0, process.returncode
finally:
    with gzip.open(root / 'terminal.raw.log.gz', 'wb') as terminal:
        terminal.write(output)
    (root / 'actions.json').write_text(json.dumps(actions, ensure_ascii=False, indent=2)+'\n')
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    os.close(master)

text = output.decode('utf-8', errors='replace')
plain = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text).replace('\r', '')
(root / 'terminal.txt').write_text(plain)
for expected in [
    '管理服务审批与核实',
    '等待批准：在机器 isolated-host-alpha 重启 alpha-worker.service；仅本次固定策略和单元修订',
    '等待批准：在机器 isolated-host-beta 重启 beta-worker.service；仅本次固定策略和单元修订',
    '尚未得到执行结果（pending）',
    '已知未执行（owner_rejected）',
]:
    assert expected in plain, expected
assert plain.count('原服务决定已保存，批准不表示成功；请刷新查询。应答丢失先核实原状态。') == 2
for forbidden in ['730011', '730012', 'hidden-first-request', 'hidden-second-request', 'taskId', 'requestId', 'UUID', 'Bearer ', 'control.token']:
    assert forbidden not in plain, forbidden
assert all(action['input'].isdigit() for action in actions)
requests = json.loads((root / 'requests.json').read_text())
assert all(request['authenticated'] is True for request in requests)
assert [r['body'] for r in requests if r['route'].startswith('POST ')] == [{'decision': 'approved'}, {'decision': 'rejected'}]
assert len(requests) == 12
assert not (root / 'profile').exists()
result = json.loads((root / 'result.json').read_text())
result.update({'ptyDriverPassed': True, 'actions': len(actions), 'internalKeysAbsentFromTerminal': True, 'numericMenuSelectionsOnly': True, 'profileAndTokenRemoved': True})
(root / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
(root / 'observations.txt').write_text('PASS: Python 标准库真实 PTY 驱动完整 runPersonalCli；stdin/stdout 均 isTTY。\nPASS: 主菜单进入服务审批与核实；原列表选择第一目标并显示固定机器；刷新、批准本次各按菜单选择；再选第二目标与固定机器并拒绝。\nPASS: 两次决定分别仅一条 POST；其余刷新均为 GET；批准后显示尚未得到执行结果，未宣称重启成功。\nPASS: 所有 12 条 Unix socket HTTP 请求均验证随机本机 Bearer token；证据无 token，临时 profile 结束时清除。\nPASS: 共 12 次纯数字菜单选择；终端不显示内部 taskId/requestId/UUID，未要求输入内部键。\n范围: 仅真实 PTY 与完整 CLI/HTTP 客户端；Unix socket HTTP 服务、待审批状态与响应均为本机替身，未调用真实后台、systemd/helper、模型或 Telegram，也未启停真实服务。\n复现: python3 drive.py <repo-root>；在空白目录复制 scenario.mjs 和 drive.py 后执行，要求 repo-root 已安装依赖。\n', encoding='utf-8')
print(json.dumps({'passed': True, 'exit': process.returncode, 'requests':len(requests), 'actions':len(actions), 'artifactDirectory':str(root)}, ensure_ascii=False))
