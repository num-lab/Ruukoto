import datetime
import json
import os
import pathlib
import select
import signal
import sqlite3
import subprocess
import time


root = pathlib.Path('/tmp/ruukoto-live-37')
expected_pid, expected_start = 3604199, '1175915100'


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def snapshot():
    database = sqlite3.connect('file:' + str(root / 'profile/personal.sqlite') + '?mode=ro', uri=True)
    try:
        database.execute('BEGIN')
        entries = [json.loads(row[0]) for row in database.execute('SELECT record FROM entries')]
        tasks = [json.loads(row[0]) for row in database.execute('SELECT record FROM tasks')]
        return entries, tasks
    finally:
        database.close()


def process_state():
    process = pathlib.Path('/proc/' + str(expected_pid))
    fields = (process / 'stat').read_text().rsplit(') ', 1)[1].split()
    check(fields[19] == expected_start and fields[0] not in ('Z', 'X'), '原测试后台身份已失效')
    check((process / 'cwd').resolve() == root / 'repo', '后台目录不符')
    check((process / 'cmdline').read_bytes().split(b'\0') == [b'node', b'--import', b'tsx', b'apps/ruukoto/src/personal-entry.ts', b'serve', b''], '后台参数不符')
    return fields[0]


def window():
    entries, tasks = snapshot()
    admissions = [e for e in entries if e.get('kind') == 'ruukoto.command-admission' and 'CRASH37' in e['data']['command']]
    check(len(admissions) <= 1, '同场景出现多个命令接纳')
    if not admissions:
        return None
    admission = admissions[0]
    command = admission['data']
    ref, execution = command['ref'], command['execution']['executionId']
    directory = root / 'profile/commands' / ('command-' + execution)
    native = root / 'profile/commands' / execution
    count = root / 'workspace/crash-count'
    check(not (directory / 'receipt.json').exists(), '已有回执，不能计无回执崩溃场景')
    check(not [e for e in entries if e.get('kind') == 'ruukoto.command-observation' and e['data']['ref'] == ref], '原结果已提交')
    if not count.exists() or not (directory / 'stdout').exists() or not (native / 'observation.json').exists():
        return None
    check(count.read_bytes() == b'CRASH37\n', '原效果必须恰好一行')
    if 'CRASH37_STARTED' not in (directory / 'stdout').read_text(errors='replace'):
        return None
    starts = [e for e in entries if e.get('kind') == 'ruukoto.command-start' and e['data']['ref'] == ref]
    check(len(starts) == 1, '原命令开始意图不唯一')
    work = command['work']['ref']
    members = [e for e in entries if e.get('kind') == 'ruukoto.analysis-admission' and e['data'].get('work') == work]
    check(len(members) == 1, '原工作所属委托不唯一')
    delegation = members[0]['data']['delegation']
    reports = [e for e in entries if e.get('kind') == 'ruukoto.report-admission' and e['data']['delegation'] == delegation]
    if not reports:
        return None
    check(len(reports) == 1 and reports[0]['id'] < starts[0]['id'], '原报告须唯一且在命令开始前接纳')
    by_id = {t['id']: t for t in tasks}
    wid, cid, rid = work['taskId'], ref['taskId'], reports[0]['data']['taskId']
    gid, tid = command['work']['generation'], command['work']['tool']
    check(by_id[cid]['kind'] == 'ruukoto.command' and by_id[cid].get('owner') == wid, '命令归属不符')
    check(by_id[tid]['kind'] == 'pi.tool' and by_id[tid].get('owner') == gid, '工具归属不符')
    check(by_id[gid]['kind'] == 'pi.generation' and by_id[gid]['conversationId'] == work['agentId'], '子会话生成归属不符')
    check(by_id[wid]['kind'] == 'ruukoto.background-work' and by_id[wid]['input']['agentId'] == work['agentId'], '原工作不符')
    check(by_id[rid]['kind'] == 'ruukoto.delegation-report' and by_id[rid]['input']['delegation'] == delegation, '原报告不符')
    check(all(by_id[x]['state']['status'] != 'terminal' for x in (wid, cid, rid)), '原工作、命令或报告已结束')
    allowed = {wid, cid, gid, tid, rid}
    while True:
        expanded = allowed | {t['id'] for t in tasks if t.get('owner') in allowed}
        if expanded == allowed:
            break
        allowed = expanded
    if [t for t in tasks if t.get('background') is True and t['state']['status'] != 'terminal' and t['id'] not in allowed]:
        return None
    scope = 'ruukoto-' + execution + '.scope'
    show = subprocess.run(['systemctl', '--user', 'show', scope, '--property=LoadState,ActiveState,SubState,ControlGroup,InvocationID,Description'], capture_output=True, text=True, check=True, timeout=5)
    props = dict(line.split('=', 1) for line in show.stdout.splitlines() if '=' in line)
    claim = json.loads((native / 'claim.json').read_text())
    observation = json.loads((native / 'observation.json').read_text())
    request = json.loads((directory / 'request.json').read_text())
    prepared = starts[0]['data']['prepared']
    data = {'command': command['command'], 'spec': prepared['spec'], 'input': prepared['input']}
    hashes = json.loads(subprocess.run(['node', '-e', 'const fs=require("fs"),c=require("crypto"),p=JSON.parse(fs.readFileSync(0,"utf8"));const h=x=>c.createHash("sha256").update(JSON.stringify(x)).digest("hex");process.stdout.write(JSON.stringify({command:h({command:p.command,spec:p.spec,input:p.input}),launch:h({input:p.input,spec:p.spec})}));'], input=json.dumps(data), text=True, capture_output=True, check=True, timeout=5).stdout)
    check(request['ref'] == command['execution'] and request['request'] == data and request['fingerprint'] == prepared['fingerprint'] == hashes['command'], '宿主请求指纹不符')
    check(claim['version'] == 1 and claim['claimedBy'] == 'launch' and claim['ref'] == command['execution'] and claim['scope'] == scope and claim['fingerprint'] == hashes['launch'], '原执行认领不符')
    check(claim['bootId'] == pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'boot不符')
    check(props.get('LoadState') == 'loaded' and props.get('ActiveState') == 'active' and props.get('Description') == 'ruukoto-execution-' + claim['token'], '原scope不符')
    check(props.get('InvocationID') == observation['invocationId'], 'InvocationID不符')
    group = pathlib.Path(observation['group'])
    check(str(group).startswith('/sys/fs/cgroup/') and group.name == scope and str(group) == os.path.normpath(str(group)) and group == pathlib.Path('/sys/fs/cgroup' + props['ControlGroup']), '原cgroup路径不符')
    group_stat = group.stat()
    check((group_stat.st_dev, group_stat.st_ino) == (observation['dev'], observation['ino']), '原cgroup对象不符')
    events = (group / 'cgroup.events').read_text()
    check(dict(line.split() for line in events.splitlines()).get('populated') == '1', '原cgroup已空')
    return {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'commandAdmission': admission, 'commandStart': starts[0], 'memberAdmission': members[0], 'reportAdmission': reports[0], 'tasks': [by_id[x] for x in sorted(allowed)], 'count': count.read_text(), 'receiptExists': False, 'observationCommitted': False, 'scope': scope, 'scopeShow': show.stdout, 'nativeClaim': claim, 'nativeObservation': observation, 'cgroupEvents': events, 'cgroupProcs': (group / 'cgroup.procs').read_text()}


def main():
    server = json.loads((root / 'records/server-3.json').read_text())
    check(server['pid'] == expected_pid and server['procStartTime'] == expected_start and server['profile'] == str(root / 'profile'), 'server3记录不符')
    pidfd = os.pidfd_open(expected_pid)
    stopped = kill_sent = False
    try:
        process_state()
        deadline = time.monotonic() + 300
        print('等待原报告、命令效果和无回执窗口。', flush=True)
        record = None
        while time.monotonic() < deadline:
            record = window()
            if record:
                break
            time.sleep(.1)
        check(record is not None, '未进入已核实窗口，未终止后台')
        process_state()
        signal.pidfd_send_signal(pidfd, signal.SIGSTOP)
        stopped = True
        deadline = time.monotonic() + 2
        while process_state() != 'T':
            check(time.monotonic() < deadline, '未确认测试后台暂停')
            time.sleep(.01)
        record = window()
        check(record is not None, '暂停后窗口已失效，恢复测试后台')
        record['server'] = server
        with (root / 'records/crash-before.json').open('x') as output:
            output.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
        kill_sent = True
        check(bool(select.select([pidfd], [], [], 5)[0]), '测试后台退出尚未证明')
        entries, _ = snapshot()
        command = record['commandAdmission']['data']
        check(not [e for e in entries if e.get('kind') == 'ruukoto.command-observation' and e['data']['ref'] == command['ref']], '中断前已有结果提交')
        check(not (root / 'profile/commands' / ('command-' + command['execution']['executionId']) / 'receipt.json').exists(), '中断前已有回执')
        check((root / 'workspace/crash-count').read_bytes() == b'CRASH37\n', '中断后效果计数改变')
        record['killedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        record['exitVerified'] = True
        with (root / 'records/crash-injected.json').open('x') as output:
            output.write(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'injected': True, 'pid': expected_pid, 'executionId': command['execution']['executionId'], 'report': record['reportAdmission']['data']['taskId'], 'count': record['count']}), flush=True)
    finally:
        if stopped and not kill_sent:
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGCONT)
            except ProcessLookupError:
                pass  # 原目标已经退出，pidfd不会命中新进程。
        os.close(pidfd)


if __name__ == '__main__':
    main()
