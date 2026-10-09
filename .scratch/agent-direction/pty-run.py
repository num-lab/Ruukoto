#!/usr/bin/env python3
# 冒烟用 pty 运行器：给命令一个真实伪终端（isTTY 为真），GRACE 秒后发 SIGTERM
# （TUI 的 SIGTERM 处理即 app.quit 优雅退出），转发输出并以子进程退出码退出。
import os, pty, select, signal, sys, time

bin_path = sys.argv[1]
grace = float(os.environ.get("GRACE", "8"))

pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", bin_path, *sys.argv[2:]])

out = b""
deadline = time.time() + grace
signaled = False
code = 1
while True:
    try:
        wpid, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        break
    if wpid == pid:
        code = os.waitstatus_to_exitcode(status)
        # 子进程已退出：抽干剩余输出
        while True:
            r, _, _ = select.select([fd], [], [], 0.2)
            if not r:
                break
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        break
    if not signaled and time.time() >= deadline:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        signaled = True
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            chunk = b""
        if not chunk:
            # pty 对端关闭但还没 reap 到：继续等
            pass
        else:
            out += chunk

sys.stdout.buffer.write(out)
sys.stdout.buffer.flush()
sys.exit(code)
