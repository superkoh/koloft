import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

argv = json.loads(sys.argv[1])
steps = json.loads(sys.argv[2])
out = sys.argv[3]

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    os.execvp(argv[0], argv)

raw = b''
answered = 0
ANSI = re.compile(rb'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78DEHMc]')


def answer_queries(chunk):
    if b'\x1b[6n' in chunk:
        os.write(fd, b'\x1b[1;1R')
    if b'\x1b[c' in chunk or b'\x1b[0c' in chunk:
        os.write(fd, b'\x1b[?62;22c')
    if b'\x1b[?u' in chunk:
        os.write(fd, b'\x1b[?0u')
    if b'\x1b]10;?' in chunk:
        os.write(fd, b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\')
    if b'\x1b]11;?' in chunk:
        os.write(fd, b'\x1b]11;rgb:0000/0000/0000\x1b\\')


def pump(seconds):
    global raw
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            raw += chunk
            answer_queries(chunk)
    return True


def text():
    return ANSI.sub(b'', raw).decode('utf-8', 'replace')


alive = True
for step in steps:
    if not alive:
        break
    if 'wait' in step:
        alive = pump(step['wait'])
    elif 'send' in step:
        os.write(fd, step['send'].encode())
        alive = pump(0.3)
    elif 'until' in step:
        end = time.time() + step.get('timeout', 30)
        start = len(text())
        while alive and time.time() < end and step['until'] not in text()[start - 2000 if start > 2000 else 0:]:
            alive = pump(0.5)
    elif 'mark' in step:
        raw += ('\n=== ' + step['mark'] + ' ===\n').encode()

try:
    os.kill(pid, 15)
except OSError:
    pass
pump(1)
with open(out, 'wb') as f:
    f.write(raw)
with open(out + '.txt', 'w') as f:
    f.write(text())
