#!/usr/bin/env python3
"""scripts/install-test/person.py — the person at the terminal of an install test.

It runs a command in a terminal of its own (a pty) and types an answer when a text shows:

    person.py --answer 'Log in to Claude now=>y' --answer 'Press Enter to start it=>' -- sh install.sh

Each --answer is '<text to wait for>=><what to type>' (Enter is added). Each one is used one
time, in the order given. With no answer left, the person types nothing more: a question that
comes then gets "end of input", as from a terminal with nobody there.
"""
import os
import pty
import select
import sys

args = sys.argv[1:]
answers = []
while args and args[0] == "--answer":
    seen, _, keys = args[1].partition("=>")
    answers.append((seen.encode(), keys.encode() + b"\n"))
    args = args[2:]
if not args or args[0] != "--":
    sys.exit("usage: person.py [--answer '<text>=><keys>']... -- <command> [args]")
cmd = args[1:]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

tail = b""
closed = False
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 1.0)
    except (OSError, ValueError):
        break
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
        tail = (tail + data)[-4096:]
        if answers and answers[0][0] in tail:
            os.write(fd, answers.pop(0)[1])
            tail = b""
    elif not answers and not closed:
        # Nobody is at the terminal any more: a question that waits gets the end of input.
        try:
            os.write(fd, b"\x04")
        except OSError:
            pass
        closed = True
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
