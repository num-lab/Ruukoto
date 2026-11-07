"""Prepare and exclusively install a directory through the host's pinned parent fd."""
import ctypes
import json
import os
import sys

parent = 3
action, stage = sys.argv[1:3]
if action == "stage":
    os.mkdir(stage, mode=0o700, dir_fd=parent)
    directory = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        os.fsync(directory)
        stat = os.fstat(directory)
    finally:
        os.close(directory)
    os.fsync(parent)
    print(json.dumps({"dev": stat.st_dev, "ino": stat.st_ino}))
elif action == "install":
    target = sys.argv[3]
    source = os.stat(stage, dir_fd=parent, follow_symlinks=False)
    if source.st_dev != int(sys.argv[4]) or source.st_ino != int(sys.argv[5]):
        raise ValueError("staging directory identity changed")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameatx_np if sys.platform == "darwin" else libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    flag = 4 if sys.platform == "darwin" else 1
    if rename(parent, os.fsencode(stage), parent, os.fsencode(target), flag) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    os.fsync(parent)
else:
    raise ValueError("unsupported directory operation")
