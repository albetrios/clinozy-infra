#!/usr/bin/env python3
"""
Run `pnpm setup:infra` under a pseudo-TTY with auto-responses for known prompts.

Usage:
  python3 tooling/setup/_run-setup-infra-pty.py

Notes:
  - Do NOT pipe through `tee` if you want to type answers yourself — the pipe breaks
    keyboard → child forwarding. This script auto-answers common prompts instead.
  - Sets SETUP_INFRA_SKIP_IDENTITY_REVIEW=1 when setup.config.json already exists.
  - Requires Node 24 on PATH (nvm use first) or edit NODE_BIN below.
"""
from __future__ import annotations

import os
import pty
import re
import select
import sys
import time

CWD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE_BIN = os.path.expanduser("~/.nvm/versions/node/v24.13.0/bin")
CONFIG_PATH = os.path.join(CWD, "tooling", "setup", "setup.config.json")

# Track buffer offset so each prompt is handled once.
_last_handled_len = 0
_sent_recently = False


def _write(fd: int, data: bytes) -> None:
    global _sent_recently
    os.write(fd, data)
    _sent_recently = True
    time.sleep(0.15)


def auto_respond(fd: int, buffer: bytes) -> None:
    global _last_handled_len, _sent_recently
    if _sent_recently:
        _sent_recently = False
        return

    if len(buffer) <= _last_handled_len:
        return

    chunk = buffer[_last_handled_len:].lower()

    def handle(pattern: bytes, response: bytes) -> bool:
        global _last_handled_len
        if pattern in chunk:
            _write(fd, response)
            _last_handled_len = len(buffer)
            return True
        return False

    # Identity + confirmations (default = yes / keep).
    if handle(b"keep these values?", b"Y\n"):
        return
    if handle(b"proceed with these branches/environments?", b"y\n"):
        return
    if handle(b"are these settings correct?", b"y\n"):
        return
    if handle(b"final confirmation: proceed with provisioning?", b"y\n"):
        return
    if handle(b"(y/n):", b"y\n"):
        return

    # Guide + credential collection — Enter keeps default / continues.
    if handle(b"press enter when done", b"\n"):
        return

    # Per-step orchestrator prompts.
    if b"proceed? (c)ontinue / (s)kip / (a)bort" in chunk:
        response = b"s\n" if b"already present" in buffer[-8000:].lower() else b"c\n"
        _write(fd, response)
        _last_handled_len = len(buffer)
        return
    if handle(b"(u)pdate / (s)kip", b"s\n"):
        return

    # Interactive credential prompts — blank line accepts default.
    if re.search(rb"(client id|client secret|redirect uri|api token|account id|workspace id|personal api key|auth token|api key).{0,40}:\s*$", chunk):
        _write(fd, b"\n")
        _last_handled_len = len(buffer)


def main() -> int:
    env = os.environ.copy()
    env["PATH"] = f"{NODE_BIN}:{env.get('PATH', '')}"
    env["TERM"] = env.get("TERM", "xterm-256color")
    if os.path.isfile(CONFIG_PATH):
        env["SETUP_INFRA_SKIP_IDENTITY_REVIEW"] = "1"

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(CWD)
        os.execvpe("pnpm", ["pnpm", "setup:infra"], env)

    buffer = b""
    stdin_fd = sys.stdin.fileno()
    stdin_is_tty = sys.stdin.isatty()

    while True:
        readers = [fd]
        if stdin_is_tty:
            readers.append(stdin_fd)
        readable, _, _ = select.select(readers, [], [], 0.5)

        if fd in readable:
            try:
                chunk = os.read(fd, 8192)
            except OSError:
                break
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            buffer += chunk
            if len(buffer) > 500_000:
                buffer = buffer[-200_000:]
            auto_respond(fd, buffer)

        if stdin_is_tty and stdin_fd in readable:
            user = os.read(stdin_fd, 1024)
            if user:
                os.write(fd, user)

        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                while True:
                    readable, _, _ = select.select([fd], [], [], 0.05)
                    if fd not in readable:
                        break
                    chunk = os.read(fd, 8192)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
                break
        except ChildProcessError:
            break

    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
