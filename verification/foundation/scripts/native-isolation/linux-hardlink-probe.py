#!/usr/bin/env python3
"""验证创建与预存硬链接的只读边界；真实绕过退出 1，仅使用临时虚拟资料。"""
import datetime
import errno
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile


def attempt(operation, source, alias):
    print(json.dumps({"started": True}), flush=True)
    try:
        if operation == "create":
            os.link(source, alias)
        Path(alias).write_text("mutated-by-workspace-alias\n")
        result = {"stage": "operation", "ok": True, "errno": None}
    except OSError as error:
        result = {"stage": "operation", "ok": False, "errno": error.errno}
    print(json.dumps(result), flush=True)


def main(output):
    output.mkdir(parents=True, exist_ok=True)
    script = Path(__file__).resolve()
    module_spec = importlib.util.spec_from_file_location("linux_native_probes", script.with_name("linux-native-probes.py"))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    root = Path(tempfile.mkdtemp(prefix="ruukoto-linux-hardlink-", dir="/tmp")).resolve()
    workspace, readonly, git = (root / name for name in ("workspace", "grant-ro", "shared-git"))
    for directory in (workspace, readonly, git):
        directory.mkdir()
    descriptor = os.memfd_create("ruukoto-hardlink-network-filter", os.MFD_CLOEXEC)
    os.write(descriptor, module.seccomp_filter(platform.machine()))
    args = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--cap-drop", "ALL",
            "--ro-bind", "/usr", "/usr", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for alias in ("/bin", "/sbin", "/lib", "/lib64"):
        if Path(alias).is_symlink():
            args += ["--symlink", os.readlink(alias), alias]
    if Path("/etc/ld.so.cache").exists():
        args += ["--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache"]
    args += ["--ro-bind", str(script), "/probe.py", "--bind", str(workspace), str(workspace),
             "--ro-bind", str(readonly), str(readonly), "--ro-bind", str(git), str(git),
             "--remount-ro", "/", "--remount-ro", "/tmp", "--remount-ro", "/dev", "--chdir", str(workspace),
             "--seccomp", str(descriptor), "/usr/bin/python3", "-I", "/probe.py"]
    report = {"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(), "platform": platform.platform(),
              "scope": "只读授权与共享 Git 各测试沙箱内创建 alias、启动前预存 alias；全部资料为临时虚拟文件。",
              "candidate": "bubblewrap 完整 namespace、只读 bind 与当前网络 seccomp；不经过产品硬链接输入拒绝。",
              "probes": [], "fixture_cleaned": False,
              "limitations": ["预存 alias 绕过只否决按路径挂载的候选，不代表有输入拒绝的产品仍允许此材料。",
                              "该探针不修改系统设置，也不访问真实资料与凭据。"]}

    def launch(operation, source, alias, restricted):
        command = [*args] if restricted else ["/usr/bin/python3", "-I", str(script)]
        command += ["--attempt", operation, str(source), str(alias)]
        os.lseek(descriptor, 0, os.SEEK_SET)
        result = subprocess.run(command, capture_output=True, text=True, timeout=12, cwd=workspace,
                                env={"PATH": "/usr/bin:/bin"}, pass_fds=(descriptor,) if restricted else ())
        try:
            receipts = [json.loads(line) for line in result.stdout.splitlines()]
        except json.JSONDecodeError:
            receipts = []
        started = bool(receipts and receipts[0].get("started") is True)
        if not started or result.returncode != 0 or len(receipts) != 2 or "ok" not in receipts[1]:
            return {"stage": "launch", "started": started, "rc": result.returncode, "stderr": result.stderr.strip()[:240]}
        return {"started": True, **receipts[1]}

    try:
        for name, directory in (("readonly", readonly), ("shared-git", git)):
            for operation in ("create", "preexisting"):
                source, alias = directory / f"{operation}-material", workspace / f"{name}-{operation}-alias"
                original = f"virtual-{name}-{operation}-material\n"
                source.write_text(original)
                if operation == "preexisting":
                    os.link(source, alias)
                control = launch(operation, source, alias, False)
                control_content = source.read_text()
                if operation == "create":
                    alias.unlink(missing_ok=True)
                source.write_text(original)
                restricted = launch(operation, source, alias, True)
                restricted_content = source.read_text()
                identity = {"dev": source.stat().st_dev, "ino": source.stat().st_ino, "nlink": source.stat().st_nlink}
                same_identity = alias.exists() and os.path.samefile(source, alias)
                unavailable = not (control.get("started") and control.get("ok") is True and control_content != original
                                   and restricted.get("stage") == "operation")
                expected = (errno.EXDEV, errno.EROFS, errno.EPERM, errno.EACCES)
                passed = not unavailable and restricted.get("ok") is False and restricted.get("errno") in expected and restricted_content == original
                report["probes"].append({"probe": f"files.{name}-{operation}-hardlink-write-denied", "pass": passed,
                    "unavailable": unavailable, "detail": {"control": control, "original_content": original,
                    "control_content": control_content, "restricted": restricted, "restricted_content": restricted_content,
                    "same_identity_after_attempt": same_identity, "identity": identity}})
    finally:
        os.close(descriptor)
        shutil.rmtree(root)
        report["fixture_cleaned"] = not root.exists()
    report["summary"] = {"total": len(report["probes"]), "passed": sum(item["pass"] for item in report["probes"]),
                         "failed": sum(not item["pass"] and not item["unavailable"] for item in report["probes"]),
                         "unavailable": sum(item["unavailable"] for item in report["probes"])}
    report["status"] = "unavailable" if report["summary"]["unavailable"] else "passed" if all(item["pass"] for item in report["probes"]) else "failed"
    (output / "native-linux-preexisting-hardlink-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# Linux 创建与预存硬链接边界探针", "", f"时间：{report['timestamp']}", f"环境：{report['platform']}",
             f"结果：{report['status']}；通过 {report['summary']['passed']} / {report['summary']['total']}；虚拟材料清理 {report['fixture_cleaned']}。", "",
             report["scope"], "", report["candidate"], "", *report["limitations"], "", "| 探针 | 结果 | 证据 |", "| --- | --- | --- |"]
    for item in report["probes"]:
        outcome = "UNAVAILABLE" if item["unavailable"] else "PASS" if item["pass"] else "FAIL"
        lines.append(f"| {item['probe']} | {outcome} | {json.dumps(item['detail'], ensure_ascii=False).replace('|', chr(92) + '|')} |")
    (output / "native-linux-preexisting-hardlink-report.md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"status": report["status"], "summary": report["summary"], "fixture_cleaned": report["fixture_cleaned"]}))
    return 2 if report["status"] == "unavailable" or not report["fixture_cleaned"] else 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--attempt":
        attempt(*sys.argv[2:])
    else:
        sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "results"))
