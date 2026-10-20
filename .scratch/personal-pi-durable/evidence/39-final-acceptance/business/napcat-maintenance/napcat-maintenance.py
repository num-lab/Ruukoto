#!/usr/bin/env python3
"""本次 NapCat 升级与程序回滚；不启动、退出或向 QQ 发送动作。"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

BASE = Path(__file__).resolve().parent
ZIP_SHA = '735f2e633247df3ffd6e8ee8b84d7039c315b2655f5807e5f0029f93d2c30016'
MANIFEST_SHA = 'e5dc2308beb476aad240479952b83fbf010a29039a61e381226e90e105e70459'
OLD_BUNDLE_SHA = 'e7e903fe063394b45c1d4feac5eac29a992991795b1025a458f8c3d94cf13b55'
NEW_BUNDLE_SHA = 'f80e4be3e8640369d23846cf3e8bcfd2a5b6dc5920f50d7ad733d7cca18179e6'
LOADER_SHA = '30dc6c548f9a307b0484f4f560555f6ac718710ed9cf952921ad020e6c2d3ee7'
KEEP = {'config', 'cache', 'logs', 'plugins', 'data'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def qq_stopped():
    # 只看可执行文件名，避免读取其他进程命令行中的凭据；不发信号。
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
    for row in rows.splitlines():
        parts = row.strip().split(None, 1)
        if len(parts) == 2 and (parts[1].startswith('/Applications/QQ.app/') or parts[1] in {'QQ', 'QQ Helper'}):
            raise RuntimeError('QQ 或其 Helper 仍在运行；请正常退出 QQ 后重跑，不要强杀。')


def check_directory(path):
    require(path.is_absolute() and path.is_dir() and not path.is_symlink(), '目录不存在或为符号链接；请先核实实际路径。')
    require(os.access(path, os.R_OK | os.W_OK | os.X_OK), '目录当前不可读写；请在有目录授权的本人终端运行。')
    # 仅创建并立即删除随机权限探针，不修改账号配置或现有文件。
    with tempfile.TemporaryFile(dir=path):
        pass


def inventory(root):
    result = {}
    for parent, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            p = Path(parent) / name
            rel = p.relative_to(root).as_posix()
            mode = stat.S_IMODE(p.lstat().st_mode)
            if p.is_symlink():
                target = os.readlink(p)
                require(not Path(target).is_absolute() and p.resolve().is_relative_to(root.resolve()), '发现目录外符号链接，无法证明完整备份；请先人工核实。')
                result[rel] = ['link', target, mode]
            elif p.is_dir():
                result[rel] = ['dir', mode]
            elif p.is_file():
                result[rel] = ['file', digest(p), mode]
            else:
                raise RuntimeError('目录中含非常规文件，无法制作本次一致备份。')
    return result



def state_inventory(program):
    result = {}
    for name in KEEP:
        p = program / name
        if p.is_symlink():
            result[name] = ['link', os.readlink(p)]
        elif p.is_dir():
            result[name] = ['dir', stat.S_IMODE(p.stat().st_mode), inventory(p)]
        elif p.is_file():
            result[name] = ['file', stat.S_IMODE(p.stat().st_mode), digest(p)]
        else:
            result[name] = None
    return result


def live_paths():
    app_package = Path('/Applications/QQ.app/Contents/Resources/app/package.json')
    package = read_json(app_package)
    require(package.get('version') == '6.9.96-49738', 'QQ 版本已改变，请重新检查支持关系。')
    loader = (app_package.parent / package['main']).resolve(strict=True)
    expected = Path.home() / 'Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js'
    require(loader == expected and digest(loader) == LOADER_SHA, '原 loader 引用或字节与已审副本不同；停止，不能猜安装位置。')
    program = loader.parent / 'napcat'
    check_directory(program.parent)
    check_directory(program)
    return program, loader


def verify_ready():
    require(digest(BASE / 'NapCat.Shell.zip') == ZIP_SHA, '官方 zip 校验失败。')
    manifest_path = BASE / 'ready-manifest.json'
    require(digest(manifest_path) == MANIFEST_SHA, '候选 manifest 与已审版本不同。')
    expected = read_json(manifest_path)['files']
    ready = BASE / 'ready'
    actual = {p.relative_to(ready).as_posix() for p in ready.rglob('*') if p.is_file()}
    require(actual == set(expected) and not any(p.is_symlink() for p in ready.rglob('*')), '候选树成员已变化。')
    require(all(digest(ready / rel) == sha for rel, sha in expected.items()), '候选文件校验失败。')
    require(read_json(ready / 'package.json').get('version') == '4.18.38', '候选 package 版本不符。')
    return ready, expected


def write_record(backup, record):
    p = backup / 'maintenance.json'
    with tempfile.NamedTemporaryFile(mode='w', dir=backup, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(record, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    try:
        os.replace(temporary, p)
    finally:
        if temporary.exists():
            temporary.unlink()


def swap_program(program, staged, record, backup):
    qq_stopped()
    previous = program.with_name('.napcat-preserved-' + uuid.uuid4().hex)
    os.replace(program, previous)
    try:
        os.replace(staged, program)
        previous.chmod(0o700)
        record.update({'previousProgramSibling': str(previous), 'phase': 'committed'})
        write_record(backup, record)
    except BaseException:
        if program.exists():
            incomplete = program.with_name('.napcat-incomplete-' + uuid.uuid4().hex)
            os.replace(program, incomplete)
            incomplete.chmod(0o700)
        os.replace(previous, program)
        raise


def upgrade(workdir_arg):
    qq_stopped()
    ready, files = verify_ready()
    program, loader = live_paths()
    require(read_json(program / 'package.json').get('version') == '4.18.30' and digest(program / 'napcat.mjs') == OLD_BUNDLE_SHA, '原程序不是已审 4.18.30 字节，停止覆盖。')
    workdir = Path(workdir_arg).expanduser()
    require(workdir.is_absolute(), '--workdir 必须是已确认的 QQ 进程实际绝对数据目录。')
    workdir = workdir.resolve(strict=True)
    configured = os.environ.get('NAPCAT_WORKDIR')
    require(not configured or Path(configured).expanduser().resolve() == workdir, '本终端 NAPCAT_WORKDIR 与参数不同，停止猜测。')
    require(not workdir.is_relative_to(program) and not program.is_relative_to(workdir), '程序目录和数据工作目录必须分离。')
    check_directory(workdir)
    require((workdir / 'config').is_dir() and any(re.fullmatch(r'onebot11_\d+\.json', x.name) for x in (workdir / 'config').iterdir()), '此目录没有登录后的账号 OneBot 配置；请确认 QQ 的 HOME/NAPCAT_WORKDIR，不能拿提供副本代替。')
    old_program = inventory(program)
    keep_before = state_inventory(program)
    old_data = inventory(workdir)
    backup = Path(tempfile.mkdtemp(prefix='napcat39-private-backup-', dir=BASE.parent))
    backup.chmod(0o700)
    record = {'operation': 'upgrade', 'phase': 'backing_up', 'program': str(program), 'workdir': str(workdir), 'loader': str(loader), 'loaderSha256': LOADER_SHA, 'oldVersion': '4.18.30', 'newVersion': '4.18.38', 'dataRestoreAutomatic': False}
    write_record(backup, record)
    print('私有备份目录：' + str(backup), flush=True)
    shutil.copytree(program, backup / 'program', symlinks=True)
    shutil.copytree(workdir, backup / 'workdir', symlinks=True)
    shutil.copy2(loader, backup / 'loadNapCat.js')
    require(inventory(program) == old_program == inventory(backup / 'program'), '程序备份期间变化，停止。')
    require(inventory(workdir) == old_data == inventory(backup / 'workdir'), '数据备份期间变化，停止。')
    for name, value in [('program-manifest.json', old_program), ('workdir-manifest.json', old_data)]:
        manifest = backup / name
        manifest.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + '\n')
        manifest.chmod(0o600)
    record['programManifestSha256'] = digest(backup / 'program-manifest.json')
    record['workdirManifestSha256'] = digest(backup / 'workdir-manifest.json')
    write_record(backup, record)
    qq_stopped()
    staged = Path(tempfile.mkdtemp(prefix='.napcat-ready-', dir=program.parent))
    try:
        shutil.copytree(program, staged, symlinks=True, dirs_exist_ok=True)
        # 无 --delete：仅覆盖发行包程序成员，账号配置、缓存、插件及未知旧成员保留。
        for rel in files:
            if Path(rel).parts[0] in KEEP:
                continue
            target = staged / rel
            require(not target.is_symlink() and not any(x.is_symlink() for x in target.parents if x != staged.parent), '程序成员经过符号链接，停止覆盖。')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ready / rel, target)
            require(target.is_file() and digest(target) == files[rel], '暂存发行成员校验失败。')
        require(state_inventory(program) == keep_before == state_inventory(staged), '程序树内状态成员被改变，停止。')
        require(digest(staged / 'napcat.mjs') == NEW_BUNDLE_SHA, '暂存程序校验失败。')
        require(inventory(workdir) == old_data and digest(loader) == LOADER_SHA, '原数据或 loader 已变化，停止。')
        record['phase'] = 'backed_up'
        write_record(backup, record)
        swap_program(program, staged, record, backup)
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    require(inventory(workdir) == old_data and state_inventory(program) == keep_before, '程序已替换，但检测到状态变化，请保持 QQ 退出并核查。')
    print('程序已更新为 4.18.38；原 loader 和数据工作目录保留。请本人按原方式启动 QQ，再核版本和 PacketBackend。')
    print('程序回滚：' + str(BASE / 'napcat-maintenance.sh') + ' rollback ' + json.dumps(str(backup)))


def rollback(backup_arg):
    qq_stopped()
    backup = Path(backup_arg).expanduser().resolve(strict=True)
    require(backup.is_dir() and backup.stat().st_uid == os.getuid() and not stat.S_IMODE(backup.stat().st_mode) & 0o077, '备份不是本人私有 0700 目录。')
    record = read_json(backup / 'maintenance.json')
    require(record.get('operation') == 'upgrade' and record.get('phase') == 'committed', '不是已完成的本次升级备份。')
    program, loader = live_paths()
    require(str(program) == record['program'] and digest(program / 'napcat.mjs') == NEW_BUNDLE_SHA, '当前程序已变化，停止自动回滚。')
    require(digest(backup / 'program/napcat.mjs') == OLD_BUNDLE_SHA and digest(backup / 'loadNapCat.js') == LOADER_SHA, '旧程序或 loader 备份不符。')
    require(digest(backup / 'program-manifest.json') == record['programManifestSha256'] and inventory(backup / 'program') == read_json(backup / 'program-manifest.json'), '旧程序备份成员已变化，停止回滚。')
    workdir = Path(record['workdir'])
    check_directory(workdir)
    data_before = inventory(workdir)
    keep_before = state_inventory(program)
    staged = Path(tempfile.mkdtemp(prefix='.napcat-rollback-', dir=program.parent))
    try:
        shutil.copytree(backup / 'program', staged, symlinks=True, dirs_exist_ok=True)
        require(inventory(staged) == inventory(backup / 'program'), '回滚程序暂存不完整。')
        for name in KEEP:
            current = program / name
            target = staged / name
            if target.is_symlink() or target.is_file():
                target.unlink()
            elif target.is_dir():
                shutil.rmtree(target)
            if current.is_symlink():
                target.symlink_to(os.readlink(current))
            elif current.is_dir():
                shutil.copytree(current, target, symlinks=True)
            elif current.is_file():
                shutil.copy2(current, target)
        require(state_inventory(program) == keep_before == state_inventory(staged), '回滚暂存时当前状态成员变化，停止。')
        rollback_record = dict(record)
        rollback_record['operation'] = 'rollback'
        swap_program(program, staged, rollback_record, backup)
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    require(inventory(workdir) == data_before and state_inventory(program) == keep_before and digest(loader) == LOADER_SHA, '回滚后检测到状态变化，请保持 QQ 退出核查。')
    print('程序已回滚到 4.18.30；当前账号配置和数据保留，私有数据备份未覆盖回现有工作目录。请本人按原方式启动 QQ。')


def main():
    parser = argparse.ArgumentParser(description='仅在 QQ 已正常退出且实际目录已确认时维护；不自动停止或启动 QQ。')
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('upgrade')
    p.add_argument('--workdir', required=True, help='QQ 进程实际工作目录；若曾设置 NAPCAT_WORKDIR，必须传实际覆盖目录。')
    p = sub.add_parser('rollback')
    p.add_argument('backup')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == 'upgrade':
            upgrade(args.workdir)
        else:
            rollback(args.backup)
    except Exception as error:
        print('维护停止：' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
