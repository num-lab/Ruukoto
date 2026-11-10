"""Exclusive, fd-relative directory publication and identity-bound lock removal."""
import ctypes
import fcntl
import hashlib
import json
import os
import stat
import sys
import uuid

parent = 3
request = json.load(sys.stdin)
action = request["action"]


def name(value):
    if not isinstance(value, str) or value in ("", ".", "..") or "/" in value:
        raise ValueError("invalid entry name")
    return value


def identity(value, expected):
    return value.st_dev == expected["dev"] and value.st_ino == expected["ino"]


def install(stage, target):
    library = ctypes.CDLL(None, use_errno=True)
    rename = library.renameatx_np if sys.platform == "darwin" else library.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    flag = 4 if sys.platform == "darwin" else 1
    if rename(parent, os.fsencode(stage), parent, os.fsencode(target), flag) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.fsync(parent)


def remove_lock(target, expected):
    try:
        actual = os.stat(target, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(actual.st_mode) or not identity(actual, expected):
        return False
    directory = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        held = os.fstat(directory)
        if not identity(held, expected) or held.st_uid != os.getuid():
            return False
        os.fchmod(directory, 0o500)
        if os.listdir(directory) != ["owner.json"]:
            return False
        owner = os.open("owner.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            info = os.fstat(owner)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
                return False
            os.fchmod(owner, 0o400)
            os.fsync(owner)
            with os.fdopen(owner, "rb", closefd=False) as stream:
                digest = hashlib.sha256(stream.read(16385)).hexdigest()
        finally:
            os.close(owner)
        if digest != expected["ownerHash"]:
            return False
        if not identity(os.stat(target, dir_fd=parent, follow_symlinks=False), expected):
            return False
        retired = "." + target + ".released-" + str(uuid.uuid4())
        install(target, retired)
        os.fchmod(directory, 0o700)
        os.unlink("owner.json", dir_fd=directory)
        os.fsync(directory)
        os.rmdir(retired, dir_fd=parent)
        os.fsync(parent)
        return True
    finally:
        os.close(directory)


if not identity(os.fstat(parent), request["parent"]):
    raise ValueError("parent identity changed")

if action in ("install", "install-file"):
    stage, target = name(request["stage"]), name(request["target"])
    source = os.stat(stage, dir_fd=parent, follow_symlinks=False)
    valid_kind = stat.S_ISDIR(source.st_mode) if action == "install" else stat.S_ISREG(source.st_mode) and source.st_nlink == 1
    if not valid_kind or not identity(source, request["identity"]):
        raise ValueError("staging identity changed")
    install(stage, target)
    print(json.dumps({"status": "installed"}))
elif action in ("claim", "release"):
    # Every new publisher and releaser serializes on the same persistent parent inode.
    fcntl.flock(parent, fcntl.LOCK_EX)
    target = name(request["target"])
    expected = request.get("expected")
    if expected is not None:
        removed = remove_lock(target, expected)
        if not removed:
            print(json.dumps({"status": "changed"}))
            sys.exit(0)
    if action == "release":
        print(json.dumps({"status": "released"}))
    else:
        stage = name(request["stage"])
        source = os.stat(stage, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(source.st_mode) or not identity(source, request["identity"]):
            raise ValueError("staging identity changed")
        try:
            install(stage, target)
            print(json.dumps({"status": "installed"}))
        except FileExistsError:
            print(json.dumps({"status": "exists"}))
elif action == "mkdir":
    target = name(request["target"])
    try:
        os.mkdir(target, 0o700, dir_fd=parent)
    except FileExistsError:
        print(json.dumps({"status": "exists"}))
    else:
        directory = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        os.fsync(parent)
        print(json.dumps({"status": "installed"}))
elif action == "write-file":
    target = name(request["target"])
    temporary = ".profile-stage-record-" + str(uuid.uuid4())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(request["content"].encode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())
    if request["exclusive"]:
        install(temporary, target)
    else:
        os.replace(temporary, target, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    print(json.dumps({"status": "installed"}))
else:
    raise ValueError("unsupported filesystem operation")
