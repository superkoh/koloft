import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ROWS, COLS = 40, 120
N = 160
OSC8 = re.compile(rb"\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)")
QUERY = re.compile(rb"\x1b\[(\?|>)?([0-9;]*)(\$?)([a-zA-Z])")

PRINTER = r'''
import sys, time
w = sys.stdout.buffer.write
pt = len(sys.argv) > 1 and sys.argv[1] == "pt"
def osc(body):
    if pt:
        return b"\x1bPtmux;\x1b\x1b]8;" + body + b"\x07\x1b\\"
    return b"\x1b]8;" + body + b"\x07"
for i in range(1, %d + 1):
    w(b"%%d. see " %% i + osc(b";http://127.0.0.1:47811/link-%%d" %% i) + b"doc %%d" %% i + osc(b";") + b" end\r\n")
    sys.stdout.flush()
    time.sleep(0.005)
w(b"END-OF-REPLY\r\n")
sys.stdout.flush()
time.sleep(30)
''' % N


def answer(fd, data):
    for m in QUERY.finditer(data):
        pre, args, dollar, fin = m.group(1) or b"", m.group(2), m.group(3), m.group(4)
        if fin == b"c" and pre == b"" and args in (b"", b"0"):
            os.write(fd, b"\x1b[?1;2c")
        elif fin == b"c" and pre == b">" and args in (b"", b"0"):
            os.write(fd, b"\x1b[>0;276;0c")
        elif fin == b"n" and pre == b"" and args == b"6":
            os.write(fd, b"\x1b[1;1R")
        elif fin == b"n" and pre == b"" and args == b"5":
            os.write(fd, b"\x1b[0n")
        elif fin == b"q" and pre == b">":
            os.write(fd, b"\x1bP>|xterm.js(5.5.0)\x1b\\")
        elif fin == b"p" and pre == b"?" and dollar == b"$":
            mode = int(args or b"0")
            os.write(fd, b"\x1b[?%d;%d$y" % (mode, 2 if mode in (1, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004, 2026) else 0))
    for m in re.finditer(rb"\x1b\](10|11);\?(\x07|\x1b\\)", data):
        os.write(fd, b"\x1b]" + m.group(1) + b";rgb:1a1a/1a1a/1e1e\x1b\\")


def run(label, conf, where, mode):
    base = f"/tmp/lab-{label}"
    subprocess.run(["rm", "-rf", base])
    os.makedirs(base)
    printer = os.path.join(base, "printer.py")
    open(printer, "w").write(PRINTER)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "xterm-256color", "LANG": "C.UTF-8", "HOME": base}
    sock = f"k-{label}"
    pid, fd = pty.fork()
    if pid == 0:
        if where == "direct":
            os.execvpe("python3", ["python3", printer, mode], env)
        os.execvpe("tmux", ["tmux", "-L", sock, "-u", "-f", conf, "new-session", "-x", str(COLS), "-y", str(ROWS), f"python3 {printer} {mode}"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    out = b""
    end = time.monotonic() + 20
    while time.monotonic() < end:
        r, _, _ = select.select([fd], [], [], 0.01)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            out += d
            answer(fd, d)
        if b"END-OF-REPLY" in out:
            end = min(end, time.monotonic() + 1.5)
    info = {}
    if where == "tmux":
        for key, args in {
            "terminalFeatures": ["show", "-s", "terminal-features"],
            "clientTermfeatures": ["display", "-p", "#{client_termfeatures}"],
        }.items():
            p = subprocess.run(["tmux", "-L", sock] + args, capture_output=True, text=True, env=env)
            info[key] = (p.stdout + p.stderr).strip()
        subprocess.run(["tmux", "-L", sock, "kill-server"], env=env)
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except OSError:
        pass
    os.makedirs("/tmp/out", exist_ok=True)
    open(f"/tmp/out/{label}.bin", "wb").write(out)
    links = OSC8.findall(out)
    opens = [m for m in links if m[1]]
    around = 0
    for m in OSC8.finditer(out):
        g = re.search(rb"link-(\d+)$", m.group(2))
        if not g:
            continue
        close = OSC8.search(out, m.end())
        while close and close.group(2):
            close = OSC8.search(out, close.end())
        text = out.find(b"doc " + g.group(1), m.end())
        if close and 0 <= text and text + 4 + len(g.group(1)) <= close.start():
            around += 1
    return {
        "linksAroundTheirWords": around,
        "label": label,
        "where": where,
        "conf": conf,
        "tmux": subprocess.run(["tmux", "-V"], capture_output=True, text=True).stdout.strip(),
        "replyShown": b"END-OF-REPLY" in out,
        "outerOsc8Opens": len(opens),
        "outerOsc8Closes": len(links) - len(opens),
        "sampleOpen": opens[0][0].decode() + ";" + opens[0][1].decode() if opens else None,
        "outerPassthrough": out.count(b"\x1bPtmux;"),
        **info,
    }


if __name__ == "__main__":
    label, conf, where, mode = sys.argv[1:5]
    print(json.dumps(run(label, conf, where, mode)), flush=True)
