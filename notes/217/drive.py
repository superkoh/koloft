import os
import pty
import re
import select
import signal
import sys
import time

out_file = sys.argv[1]
text_file = sys.argv[2]
question = sys.argv[3]
cwd = sys.argv[4]
cmd = sys.argv[5:]

paste = open(text_file).read()
log = open(out_file, "wb")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLUMNS"] = "120"
    os.environ["LINES"] = "40"
    os.execvp(cmd[0], cmd)

import fcntl
import struct
import termios

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

seen = b""


def pump(seconds):
    global seen
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            log.write(data)
            log.flush()
            seen += data
            if b"\x1b[6n" in data:
                os.write(fd, b"\x1b[1;1R")
            if b"\x1b]10;?" in data:
                os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
            if b"\x1b]11;?" in data:
                os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
            if b"\x1b[?u" in data:
                os.write(fd, b"\x1b[?0u")
            if b"\x1b[c" in data:
                os.write(fd, b"\x1b[?62;22c")
    return True


def plain():
    return ANSI.sub(b"", seen).decode("utf8", "replace")


def send(s):
    os.write(fd, s.encode("utf8"))


pump(12)
low = plain().lower()
if "trust" in low:
    if "no,exit" in low.replace(" ", ""):
        send("\x1b[B")
        pump(1)
    send("\r")
    pump(10)
send("\x1b[200~" + paste + "\x1b[201~")
pump(2)
send(question)
pump(1)
send("\r")
start = len(plain())
deadline = time.time() + 180
asked = 0
while time.time() < deadline:
    if not pump(3):
        break
    tail = plain()[start:]
    if asked < 3 and re.search(r"(?i)do you want to|allow (once|this)|approve|1\. yes", tail[-1500:]):
        asked += 1
        print("PERMISSION_ASKED", asked)
        send("\r")
        pump(2)
        start = len(plain())
        continue
    if "ZEBRA" in tail.upper() and re.search(r"(?i)\bzebra\b", tail):
        pump(4)
        break
log.close()
try:
    os.kill(pid, signal.SIGTERM)
except OSError:
    pass
print("ANSWER_HAS_ZEBRA" if re.search(r"(?i)\bzebra\b", plain()[start:]) else "NO_ZEBRA")
