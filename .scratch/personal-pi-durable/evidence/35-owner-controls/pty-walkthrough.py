"""用真实PTY核对隔离菜单；仅使用虚构模型配置，不发模型或IM请求。"""
import fcntl
import gzip
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

repo = Path(__file__).resolve().parents[4]
directory = tempfile.mkdtemp(prefix="rk-owner-pty-")
env = dict(os.environ, RUUKOTO_PERSONAL_DIR=directory, OWNER_WALKTHROUGH_KEY="test-only")
log_path = Path(__file__).parent / "logs" / "pty.log.gz"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    os.execvpe("node", ["node", "--import", "tsx", "apps/ruukoto/src/personal-entry.ts"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
pending = b""
log = gzip.open(log_path, "wb")


def expect(text):
    global pending
    wanted = text.encode()
    deadline = time.monotonic() + 20
    while wanted not in pending:
        assert time.monotonic() < deadline, f"未出现预期提示：{text}"
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        data = os.read(fd, 65536)
        assert data, f"终端提前退出：{text}"
        log.write(data)
        log.flush()
        pending += data
    pending = pending.split(wanted, 1)[1]


def send(value):
    os.write(fd, (value + "\n").encode())


def choose(title, value):
    expect(title)
    expect("请选择：")
    send(str(value))


def answer(prompt, value):
    expect(prompt)
    send(value)


passed = False
try:
    choose("个人实例", 5)
    choose("配置能力（后台须停止）", 1)
    choose("模型接口", 1)
    answer("服务地址（完整 HTTPS URL）：", "https://model.invalid/v1")
    answer("模型名称：", "walkthrough-model")
    answer("凭据环境变量名：", "OWNER_WALKTHROUGH_KEY")
    answer("上下文窗口（默认 128000）：", "")
    answer("最大输出（默认 4096）：", "")
    choose("此模型支持图片输入吗？", 1)
    expect("模型配置已保存")
    choose("个人实例", 6)
    choose("实例状态与启停", 2)
    expect("隔离后台已启动")
    choose("个人实例", 6)
    choose("实例状态与启停", 1)
    expect("后台在线；模型：walkthrough-model")
    choose("个人实例", 4)
    choose("权限、授权与个人资料", 1)
    choose("权限与授权", 1)
    choose("选择新输入来源", 1)
    choose("默认模式只影响", 3)
    choose("完全访问使用后台账户权限", 2)
    expect("默认模式已保存")
    choose("权限与授权", 1)
    choose("选择新输入来源", 1)
    choose("默认模式只影响", 1)
    expect("默认模式已保存")
    choose("权限与授权", 2)
    choose("长期服务授权", 1)
    choose("权限与授权", 3)
    choose("个人实例", 5)
    choose("配置能力（后台须停止）", 1)
    expect("profile_busy")
    choose("个人实例", 6)
    choose("实例状态与启停", 3)
    choose("停止后台会暂停处理", 2)
    expect("已请求停止")
    choose("个人实例", 7)
    deadline = time.monotonic() + 20
    while True:
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            break
        assert time.monotonic() < deadline, "向导选择退出后未结束"
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError as error:
                if error.errno != 5:
                    raise
                data = b""
            log.write(data)
            log.flush()
    assert os.waitstatus_to_exitcode(status) == 0
    passed = True
finally:
    log.close()
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.close(fd)
    if (Path(directory) / "control.sock").exists():
        subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", 'import {personalControl} from "./apps/ruukoto/src/personal-control.ts"; await personalControl(process.env.RUUKOTO_PERSONAL_DIR,"POST","/stop");'], cwd=repo, env=env, check=True, capture_output=True)
    deadline = time.monotonic() + 10
    while True:
        lock = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", 'import {lockPersonalProfile} from "./apps/ruukoto/src/personal-profile.ts"; lockPersonalProfile(process.env.RUUKOTO_PERSONAL_DIR).release();'], cwd=repo, env=env, capture_output=True)
        if lock.returncode == 0:
            shutil.rmtree(directory)
            break
        assert time.monotonic() < deadline, f"未核实停止，保留档案：{directory}"
        time.sleep(0.1)
print(json.dumps({"passed": passed, "terminal": "PTY 160x50", "real_model_requests": 0, "real_im_requests": 0, "profile_removed_after_lock_verified": True}, ensure_ascii=False))
