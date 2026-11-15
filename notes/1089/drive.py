import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

sys.path.insert(0, os.environ["PYTE_DIR"])
import pyte

B = os.path.dirname(os.path.abspath(__file__))
RUN_SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 150
PROMPT = (
    "Launch exactly one Agent (subagent_type general-purpose) with run_in_background set to true. "
    "Its task, word for word: 'Run these Bash commands one at a time, each in the foreground as its own tool call: "
    "perl -e \"sleep 6\"; echo one; perl -e \"sleep 6\"; echo two; perl -e \"sleep 6\"; echo three. "
    "Then start perl -e \"sleep 25\" with run_in_background true, and at once reply DONE.' "
    "After launching it, reply only with the word started and end your turn. "
    "Whenever you are told it finished or anything else, reply only with ok."
)


class Screen(pyte.Screen):
    def report_device_status(self, mode, **kwargs):
        pass


COLS, ROWS = 120, 40
screen = Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.execv("/bin/sh", ["/bin/sh", os.path.join(B, "run.sh")])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
start = time.time()
out = open(os.path.join(B, "screen.txt"), "w")
samples = open(os.path.join(B, "samples.jsonl"), "w")


def answer(data):
    if b"\x1b[6n" in data:
        os.write(fd, ("\x1b[%d;%dR" % (screen.cursor.y + 1, screen.cursor.x + 1)).encode())
    if b"\x1b[c" in data or b"\x1b[0c" in data:
        os.write(fd, b"\x1b[?62;22c")
    if b"\x1b[>c" in data or b"\x1b[>0c" in data:
        os.write(fd, b"\x1b[>0;276;0c")
    if b"\x1b]11;?" in data:
        os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
    if b"\x1b]10;?" in data:
        os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
    if b"\x1b[?u" in data:
        os.write(fd, b"\x1b[?0u")
    if b"\x1b[>q" in data:
        os.write(fd, b"\x1bP>|xterm(1)\x1b\\")


def text():
    return "\n".join(line.rstrip() for line in screen.display).rstrip()


def snap(label):
    out.write("===== %.2fs %s =====\n%s\n" % (time.time() - start, label, text()))
    out.flush()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            stream.feed(data)
            answer(data)
    return True


sizes = {}


def sample():
    root = os.path.join(B, "config", "projects")
    for dirpath, _, files in os.walk(root):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            p = os.path.join(dirpath, name)
            try:
                size = os.path.getsize(p)
            except OSError:
                continue
            if sizes.get(p) != size:
                sizes[p] = size
                samples.write(json.dumps({"t": time.time(), "file": p[len(root):], "size": size}) + "\n")
                samples.flush()


ready = False
while time.time() - start < 60:
    if not pump(0.2):
        break
    t = text()
    if "for shortcuts" in t or "bypass permissions" in t.lower():
        ready = True
        break
snap("ready" if ready else "not ready")
if not ready:
    os.kill(pid, signal.SIGKILL)
    sys.exit(1)
pump(1.0)
os.write(fd, PROMPT.encode())
pump(0.8)
os.write(fd, b"\r")
snap("sent")
last_snap = time.time()
while time.time() - start < RUN_SECONDS:
    if not pump(0.5):
        break
    sample()
    if time.time() - last_snap > 15:
        snap("tick")
        last_snap = time.time()
snap("end")
os.write(fd, b"/exit\r")
pump(3)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
