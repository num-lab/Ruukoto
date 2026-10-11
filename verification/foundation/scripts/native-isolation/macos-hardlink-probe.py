#!/usr/bin/env python3
"""验证预存硬链接经可写目录访问只读资料；真实绕过退出 1，不改产品与系统设置。"""
import errno
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parents[2] / "results"
    if sys.platform != "darwin" or not os.access("/usr/bin/sandbox-exec", os.X_OK):
        print("[ruukoto:verification] 需要 macOS 与 sandbox-exec；当前不可验证", file=sys.stderr)
        return 2
    try:
        candidate_report = json.loads((output / "native-macos-stage1-report.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        print(f"[ruukoto:verification] 缺少可读取的 macOS 主探针候选策略；先运行主探针：{error}", file=sys.stderr)
        return 2
    root = Path(tempfile.mkdtemp(prefix="ruukoto-native-hardlink-", dir="/tmp")).resolve()
    source_root = candidate_report.get("retained_probe_materials") or candidate_report["path_normalization"]["canonical"]
    candidate = candidate_report["candidate_profile"].replace(source_root, str(root))
    workspace, readonly, git, private_tmp = (root / name for name in ("workspace", "grant-ro", "shared-git", "tmp"))
    for directory in (workspace, readonly, git, private_tmp):
        directory.mkdir()
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(private_tmp), "TMPDIR": str(private_tmp),
                   "GIT_CONFIG_NOSYSTEM": "1"}
    python = str(Path(sys.executable).resolve())
    script = str(Path(__file__).with_name("macos-probe.py").resolve())
    report = {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "platform": platform.platform(),
              "scope": "只测试本轮虚拟只读授权与共享 Git 文件，预先创建同 inode 的 workspace 硬链接。",
              "candidate_profile": candidate, "probes": [], "fixture_cleaned": False,
              "limitations": ["失败只否决按路径开放 workspace 写入的被测 Seatbelt 策略。",
                              "该探针不经过产品授权装配；产品可在启动前拒绝有多重硬链接的可写材料。",
                              "原生主探针的创建硬链接拒绝不能代替本项预存别名写入口。"]}

    def launch(path, policy=None):
        command = [python, "-I", script, "--attempt", "write", json.dumps(str(path))]
        if policy is not None:
            command = ["/usr/bin/sandbox-exec", "-p", policy, *command]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=12, cwd=workspace, env=environment)
        except (OSError, subprocess.TimeoutExpired) as error:
            return {"stage": "launch", "started": False, "detail": str(error)}
        try:
            receipts = [json.loads(line) for line in result.stdout.splitlines()]
        except json.JSONDecodeError:
            receipts = []
        started = bool(receipts and receipts[0].get("started") is True)
        if not started or result.returncode != 0 or len(receipts) != 2 or "ok" not in receipts[1]:
            return {"stage": "profile-parse" if result.returncode == 65 else "launch", "started": started,
                    "rc": result.returncode, "stderr": result.stderr.strip()[:240]}
        return {"stage": "operation", "started": True, **receipts[1]}

    try:
        for name, directory in (("readonly", readonly), ("shared-git", git)):
            source, alias = directory / "material", workspace / f"{name}-alias"
            original = "virtual-readonly-material\n"
            source.write_text(original)
            os.link(source, alias)
            same_identity = os.path.samefile(source, alias)
            identity = {"dev": source.stat().st_dev, "ino": source.stat().st_ino, "nlink": source.stat().st_nlink}
            control = launch(alias)
            control_changed_original = source.read_text() != original
            source.write_text(original)
            restricted = launch(alias, candidate)
            restricted_changed_original = source.read_text() != original
            source.write_text(original)
            explicit = launch(alias, candidate + f"\n(deny file-write* (subpath {json.dumps(str(directory))}))\n")
            explicit_changed_original = source.read_text() != original
            unavailable = not (same_identity and control.get("started") and control.get("ok") is True and control_changed_original
                               and restricted.get("stage") == "operation" and explicit.get("stage") == "operation")
            passed = not unavailable and restricted.get("ok") is False and restricted.get("errno") in (errno.EPERM, errno.EACCES)
            report["probes"].append({"probe": f"files.{name}-preexisting-hardlink-write-denied", "pass": passed,
                                     "unavailable": unavailable, "detail": {"same_identity": same_identity, "identity": identity,
                                     "control": control, "control_changed_original": control_changed_original,
                                     "restricted": restricted, "restricted_changed_original": restricted_changed_original,
                                     "explicit_readonly_deny": explicit, "explicit_deny_changed_original": explicit_changed_original}})
    finally:
        shutil.rmtree(root)
        report["fixture_cleaned"] = not root.exists()
    report["summary"] = {"total": len(report["probes"]), "passed": sum(item["pass"] for item in report["probes"]),
                         "failed": sum(not item["pass"] and not item["unavailable"] for item in report["probes"]),
                         "unavailable": sum(item["unavailable"] for item in report["probes"])}
    report["status"] = "unavailable" if report["summary"]["unavailable"] else "passed" if all(item["pass"] for item in report["probes"]) else "failed"
    json_path, md_path = output / "native-macos-preexisting-hardlink-report.json", output / "native-macos-preexisting-hardlink-report.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = ["# macOS 预存硬链接边界探针", "", f"时间：{report['timestamp']}", f"环境：{report['platform']}",
             f"结果：{report['status']}；通过 {report['summary']['passed']} / {report['summary']['total']}；虚拟材料清理 {report['fixture_cleaned']}。", "",
             report["scope"], "", *report["limitations"], "", "| 探针 | 结果 | 证据 |", "| --- | --- | --- |"]
    for item in report["probes"]:
        outcome = "UNAVAILABLE" if item["unavailable"] else "PASS" if item["pass"] else "FAIL"
        detail = json.dumps(item["detail"], ensure_ascii=False).replace("|", "\\|")
        lines.append(f"| {item['probe']} | {outcome} | {detail} |")
    md_path.write_text("\n".join(lines) + "\n")
    print(json.dumps({"status": report["status"], "summary": report["summary"], "fixture_cleaned": report["fixture_cleaned"]}))
    return 2 if report["status"] == "unavailable" or not report["fixture_cleaned"] else 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
