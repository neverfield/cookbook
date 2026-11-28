#!/usr/bin/env python3
"""
Minimal Linux Landlock LSM write-confinement launcher (ABI v1–v6).

Confines the target command and all of its descendants so filesystem writes,
creations, removals, renames/hardlinks (ABI v2+), and truncations (ABI v3+)
are permitted ONLY under explicitly allowlisted paths.

Reads remain permitted everywhere so system runtimes (Node, npm, git shared
alternates) function without enumerating every library directory.

Zero third-party dependencies — uses Linux syscalls via ctypes.
"""

import argparse
import ctypes
import errno
import os
import stat
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446

LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1

PR_SET_NO_NEW_PRIVS = 38

# Landlock filesystem access flags (include/uapi/linux/landlock.h)
ACCESS_FS_WRITE_FILE = 1 << 1
ACCESS_FS_REMOVE_DIR = 1 << 4
ACCESS_FS_REMOVE_FILE = 1 << 5
ACCESS_FS_MAKE_CHAR = 1 << 6
ACCESS_FS_MAKE_DIR = 1 << 7
ACCESS_FS_MAKE_REG = 1 << 8
ACCESS_FS_MAKE_SOCK = 1 << 9
ACCESS_FS_MAKE_FIFO = 1 << 10
ACCESS_FS_MAKE_BLOCK = 1 << 11
ACCESS_FS_MAKE_SYM = 1 << 12
ACCESS_FS_REFER = 1 << 13      # ABI >= 2 (Linux 5.19+)
ACCESS_FS_TRUNCATE = 1 << 14   # ABI >= 3 (Linux 6.2+)


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ("allowed_access", ctypes.c_uint64),
        ("parent_fd", ctypes.c_int32),
    ]


def load_libc():
    return ctypes.CDLL("libc.so.6", use_errno=True)


def probe_abi(libc) -> int:
    abi = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET,
        None,
        0,
        LANDLOCK_CREATE_RULESET_VERSION,
    )
    if abi < 0:
        err = ctypes.get_errno()
        return -err
    return int(abi)


def write_masks_for_abi(abi: int):
    dir_mask = (
        ACCESS_FS_WRITE_FILE
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM
    )
    file_mask = ACCESS_FS_WRITE_FILE
    if abi >= 2:
        dir_mask |= ACCESS_FS_REFER
    if abi >= 3:
        dir_mask |= ACCESS_FS_TRUNCATE
        file_mask |= ACCESS_FS_TRUNCATE
    return dir_mask, file_mask


def apply_landlock(allow_rw_paths):
    libc = load_libc()
    abi = probe_abi(libc)
    if abi < 1:
        err = -abi
        raise OSError(err, f"Landlock unavailable (errno={err}: {os.strerror(err)})")

    dir_mask, file_mask = write_masks_for_abi(abi)
    attr = RulesetAttr(handled_access_fs=dir_mask)
    ruleset_fd = libc.syscall(
        SYS_LANDLOCK_CREATE_RULESET,
        ctypes.byref(attr),
        ctypes.sizeof(attr),
        0,
    )
    if ruleset_fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, f"landlock_create_ruleset failed: {os.strerror(err)}")

    try:
        for raw_path in allow_rw_paths:
            resolved = os.path.realpath(raw_path)
            st = os.stat(resolved)
            mask = dir_mask if stat.S_ISDIR(st.st_mode) else file_mask
            path_fd = os.open(resolved, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = PathBeneathAttr(allowed_access=mask, parent_fd=path_fd)
                rc = libc.syscall(
                    SYS_LANDLOCK_ADD_RULE,
                    ruleset_fd,
                    LANDLOCK_RULE_PATH_BENEATH,
                    ctypes.byref(rule),
                    0,
                )
                if rc != 0:
                    err = ctypes.get_errno()
                    raise OSError(
                        err,
                        f"landlock_add_rule failed for {resolved}: {os.strerror(err)}",
                    )
            finally:
                os.close(path_fd)

        rc = libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        if rc != 0:
            err = ctypes.get_errno()
            raise OSError(err, f"prctl(PR_SET_NO_NEW_PRIVS) failed: {os.strerror(err)}")

        rc = libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0)
        if rc != 0:
            err = ctypes.get_errno()
            raise OSError(err, f"landlock_restrict_self failed: {os.strerror(err)}")
    finally:
        os.close(ruleset_fd)


def main():
    parser = argparse.ArgumentParser(
        description="Execute a command under Linux Landlock write confinement."
    )
    parser.add_argument(
        "--probe",
        action="store_true",
        help="Print supported Landlock ABI version and exit 0 (or non-zero if unsupported).",
    )
    parser.add_argument(
        "--allow-rw",
        action="append",
        default=[],
        help="Directory or file path where writes are allowed (repeatable).",
    )
    parser.add_argument(
        "--cwd",
        default=None,
        help="Working directory to chdir into before exec.",
    )
    parser.add_argument(
        "cmd",
        nargs=argparse.REMAINDER,
        help="Command to execute after '--'.",
    )
    args = parser.parse_args()

    if args.probe:
        libc = load_libc()
        abi = probe_abi(libc)
        if abi >= 1:
            print(abi)
            sys.exit(0)
        else:
            print(f"unavailable:{errno.errorcode.get(-abi, -abi)}", file=sys.stderr)
            sys.exit(1)

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        print("landlock-exec: missing command after '--'", file=sys.stderr)
        sys.exit(2)

    allow_paths = list(args.allow_rw)
    if "/dev/null" not in allow_paths and os.path.exists("/dev/null"):
        allow_paths.append("/dev/null")

    apply_landlock(allow_paths)

    if args.cwd:
        os.chdir(args.cwd)

    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
