import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty

log_path = sys.argv[1]
args = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[0], args)


def copy_size(*_):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8))
    except OSError:
        pass


copy_size()
signal.signal(signal.SIGWINCH, copy_size)
try:
    tty.setraw(0)
except Exception:
    pass
out = open(log_path, "wb")
inp = open(log_path + ".in", "wb")
t0 = time.monotonic()
reading = [0, fd]
while True:
    try:
        r, _, _ = select.select(reading, [], [], 1)
    except InterruptedError:
        continue
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        out.write(struct.pack("<dI", time.monotonic() - t0, len(d)) + d)
        out.flush()
        while d:
            d = d[os.write(1, d):]
    if 0 in r:
        k = os.read(0, 65536)
        if not k:
            reading = [fd]
            continue
        inp.write(struct.pack("<dI", time.monotonic() - t0, len(k)) + k)
        inp.flush()
        while k:
            k = k[os.write(fd, k):]
os.waitpid(pid, 0)
