#!/usr/bin/env python3
"""验证 launchd bootout 是否回收脱离进程组的真实后代；仅操作临时唯一 job。"""

import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=5)


def alive(pid):
    state = run(["/bin/ps", "-p", str(pid), "-o", "stat="]).stdout.strip()
    return bool(state) and not state.startswith("Z")


def heartbeat(directory):
    for _ in range(10):
        try:
            return int((directory / "heartbeat").read_text())
        except (FileNotFoundError, ValueError):
            time.sleep(0.01)
    raise RuntimeError("心跳文件未生成或不可核实")


def probe(case, root, node, jobs, directories):
    directory = root / case
    directory.mkdir()
    directories.append(directory)
    label = f"dev.ruukoto.native-audit.{os.getpid()}.{case}"
    target = f"gui/{os.getuid()}/{label}"
    jobs.append(target)
    child = directory / "heartbeat.py"
    child.write_text(
        "import json,os,pathlib,signal,time\n"
        f"p=pathlib.Path({str(directory)!r})\n"
        "p.joinpath('child.json').write_text(json.dumps({'pid':os.getpid(),"
        "'pgid':os.getpgrp(),'sid':os.getsid(0)}))\n"
        "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
        "end=time.monotonic()+20\n"
        "n=0\n"
        "while time.monotonic()<end:\n"
        " p.joinpath('heartbeat').write_text(str(n));n+=1;time.sleep(.05)\n"
    )
    if case == "python-setsid":
        main = directory / "main.py"
        main.write_text(
            "import json,os,pathlib,subprocess,time\n"
            f"p=pathlib.Path({str(directory)!r})\n"
            "p.joinpath('main.json').write_text(json.dumps({'pid':os.getpid(),"
            "'pgid':os.getpgrp(),'sid':os.getsid(0)}))\n"
            f"child=subprocess.Popen(['/usr/bin/python3',{str(child)!r}],start_new_session=True)\n"
            "p.joinpath('spawn.json').write_text(json.dumps({'pid':child.pid}))\n"
            "time.sleep(20)\n"
        )
        args = ["/usr/bin/python3", str(main)]
    else:
        main = directory / "main.js"
        main.write_text(
            "const fs=require('node:fs'),cp=require('node:child_process');"
            f"fs.writeFileSync({json.dumps(str(directory / 'main.json'))},"
            "JSON.stringify({pid:process.pid}));"
            f"const child=cp.spawn('/usr/bin/python3',[{json.dumps(str(child))}],"
            "{detached:true,stdio:'ignore'});"
            f"fs.writeFileSync({json.dumps(str(directory / 'spawn.json'))},"
            "JSON.stringify({pid:child.pid??null}));setTimeout(()=>{},20000);"
        )
        args = [node, str(main)]
    plist = directory / "job.plist"
    plist.write_bytes(plistlib.dumps({
        "Label": label,
        "ProgramArguments": ["/usr/bin/sandbox-exec", "-p",
                             "(version 1)(allow default)(deny network*)"] + args,
        "RunAtLoad": True,
        "KeepAlive": False,
        "ExitTimeOut": 1,
        "AbandonProcessGroup": False,
        "StandardOutPath": str(directory / "out"),
        "StandardErrorPath": str(directory / "err"),
    }))
    started = run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(plist)])
    if started.returncode:
        raise RuntimeError(f"临时 job 未启动：{started.stderr.strip()}")
    deadline = time.monotonic() + 5
    while not (directory / "child.json").exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not (directory / "child.json").exists():
        raise RuntimeError(f"后代未启动：{(directory / 'err').read_text().strip()}")
    parent = json.loads((directory / "main.json").read_text())
    descendant = json.loads((directory / "child.json").read_text())
    before = heartbeat(directory)
    time.sleep(0.25)
    control = heartbeat(directory)
    if control <= before or descendant["pgid"] != descendant["pid"]:
        raise RuntimeError("运行对照无效：后代未持续写入或未脱离父进程组")
    stopped = run(["/bin/launchctl", "bootout", target])
    missing = run(["/bin/launchctl", "print", target])
    time.sleep(0.25)
    after = heartbeat(directory)
    time.sleep(0.4)
    later = heartbeat(directory)
    parent_alive = alive(parent["pid"])
    descendant_alive = alive(descendant["pid"])
    if stopped.returncode or missing.returncode != 113 or parent_alive:
        raise RuntimeError("bootout 未成功停止并移除父 job，不能判断后代回收")
    if descendant_alive == (later <= after):
        raise RuntimeError("后代存活状态与心跳不一致，停止结果无法核实")
    return {
        "case": case,
        "status": "FAIL" if descendant_alive else "PASS",
        "parent": parent,
        "descendant": descendant,
        "running_control": [before, control],
        "bootout_exit_code": stopped.returncode,
        "job_print_exit_code": missing.returncode,
        "parent_alive_after_bootout": parent_alive,
        "heartbeat_after_bootout": [after, later],
        "descendant_alive_after_bootout": descendant_alive,
    }


def cleanup(root, jobs, directories):
    errors = []
    for target in jobs:
        run(["/bin/launchctl", "bootout", target])
        if run(["/bin/launchctl", "print", target]).returncode != 113:
            errors.append(f"临时 job 移除失败：{target}")
    for directory in directories:
        pids = []
        if (directory / "main.json").exists() and not (directory / "spawn.json").exists():
            errors.append("父进程已启动但子进程 spawn 回执缺失，无法确认所有后代")
        for name in ("main.json", "spawn.json", "child.json"):
            record = directory / name
            if record.exists():
                pid = json.loads(record.read_text())["pid"]
                if pid is not None:
                    pids.append(pid)
        pids = set(pids)
        for pid in pids:
            command = run(["/bin/ps", "-p", str(pid), "-o", "args="]).stdout.strip()
            if command and str(root) in command:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif command and alive(pid):
                errors.append(f"捕获 PID {pid} 的 argv 不匹配临时目录，拒绝发送信号")
        deadline = time.monotonic() + 2
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.05)
        if any(alive(pid) for pid in pids):
            errors.append("捕获进程未确认退出")
        if (directory / "heartbeat").exists():
            before = heartbeat(directory)
            time.sleep(0.15)
            if heartbeat(directory) != before:
                errors.append("清理后后代心跳仍增长")
    if not errors:
        shutil.rmtree(root)
    return {"verified": not errors, "temporary_directory_removed": not errors, "errors": errors}


def main():
    report = {"platform": platform.platform(), "macos": platform.mac_ver()[0],
              "tested_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cases": []}
    jobs, directories = [], []
    root = None
    try:
        if sys.platform != "darwin":
            raise RuntimeError("该探针只用于真实 macOS")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("缺少宿主 Node")
        node_check = run([node, "-p", "process.execPath"])
        if node_check.returncode:
            raise RuntimeError("宿主 Node 未能启动")
        node = node_check.stdout.strip()
        report["node_version"] = run([node, "--version"]).stdout.strip()
        root = Path(tempfile.mkdtemp(prefix="ruukoto-native-launchd-audit-", dir="/private/tmp"))
        for case in ("python-setsid", "node-posix-spawn"):
            report["cases"].append(probe(case, root, node, jobs, directories))
        report["status"] = "FAIL" if any(c["status"] == "FAIL" for c in report["cases"]) else "PASS"
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        report["status"] = "UNVERIFIED"
        report["error"] = str(error)
    finally:
        try:
            report["cleanup"] = cleanup(root, jobs, directories) if root else {"verified": True}
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            report["cleanup"] = {"verified": False, "errors": [str(error)], "temporary_directory": str(root)}
        if not report["cleanup"]["verified"]:
            report["status"] = "UNVERIFIED"
    output = Path(__file__).resolve().parents[2] / "results"
    output.mkdir(exist_ok=True)
    (output / "native-macos-launchd.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    rows = ["| 路径 | 运行对照 | bootout | job 查询 | 停止后心跳 | 结果 |",
            "| --- | --- | --- | --- | --- | --- |"]
    for case in report["cases"]:
        rows.append(f"| {case['case']} | {case['running_control']} | {case['bootout_exit_code']} | "
                    f"{case['job_print_exit_code']} | {case['heartbeat_after_bootout']} | {case['status']} |")
    text = (f"# macOS launchd 后代回收验证\n\n状态：{report['status']}\n\n"
            f"环境：{report['platform']}；Node {report.get('node_version', '不可用')}。"
            f"时间：{report['tested_at']}。\n\n" + "\n".join(rows) + "\n\n"
            "临时 job 使用 sandbox-exec（仅禁止网络），RunAtLoad=true、KeepAlive=false、"
            "ExitTimeOut=1、AbandonProcessGroup=false。后代忽略 SIGTERM，并持续写入临时虚拟心跳。"
            "该探针只验证生命周期候选机制，不验证完整文件、凭据或 IPC 策略。\n\n"
            f"清理核实：{json.dumps(report['cleanup'], ensure_ascii=False)}。捕获 PID 的 argv 必须包含"
            "本次临时目录才允许发送 SIGKILL；同时核实 PID 退出与心跳冻结。\n\n"
            "复跑：`python3 verification/foundation/scripts/native-isolation/macos-launchd-probe.py`。"
            "PASS=0、真实边界失败=1、基础设施缺失或运行/清理对照无效=2。\n\n"
            "Apple 的 [launchd.plist 说明](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)"
            "将 AbandonProcessGroup 的清理范围限定为与 job 相同的进程组；本报告用真实后代确认了该限制。"
            "[XNU coalition 系统调用](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c)"
            "要求调用者属于 privileged coalition；"
            "[coalition_request_terminate_internal](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)"
            "请求在成员归零后通知，不能据此声称已停止所有当前成员。"
            "未验证其他特权原生管理机制，不能把本报告扩写为所有原生方案均不可行。\n")
    if report.get("error"):
        text += f"\n未核实原因：{report['error']}。\n"
    (output / "native-macos-launchd.md").write_text(text)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return {"PASS": 0, "FAIL": 1, "UNVERIFIED": 2}[report["status"]]


if __name__ == "__main__":
    sys.exit(main())
