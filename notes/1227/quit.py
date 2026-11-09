import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tarfile
import termios
import fcntl
import time

KIT = "/Volumes/My Shared Files/kit"
ROWS, COLS = 40, 120
QUERY = re.compile(rb"\x1b\[(\?|>)?([0-9;]*)(\$?)([a-zA-Z])")
WORK = os.path.realpath("/tmp/w1227")
GD = os.path.realpath("/tmp/gd1227")
AGY = os.path.realpath("/tmp/agy1227/agy")
PORT = 47811


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
        elif fin == b"u" and pre == b"?":
            os.write(fd, b"\x1b[?0u")
        elif fin == b"p" and pre == b"?" and dollar == b"$":
            mode = int(args or b"0")
            os.write(fd, b"\x1b[?%d;%d$y" % (mode, 2 if mode in (1, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004, 2026) else 0))
    for m in re.finditer(rb"\x1b\](10|11);\?(\x07|\x1b\\)", data):
        os.write(fd, b"\x1b]" + m.group(1) + b";rgb:1a1a/1a1a/1e1e\x1b\\")


def setup():
    os.makedirs(WORK, exist_ok=True)
    if not os.path.exists(AGY):
        os.makedirs(os.path.dirname(AGY), exist_ok=True)
        with tarfile.open(os.path.join(KIT, "agy.tar.gz")) as t:
            t.extractall(os.path.dirname(AGY))
        os.rename(os.path.join(os.path.dirname(AGY), "antigravity"), AGY)
        os.chmod(AGY, 0o755)
    app = os.path.join(GD, "antigravity-cli")
    os.makedirs(os.path.join(app, "cache"), exist_ok=True)
    json.dump({"onboardingComplete": True, "consumerOnboardingComplete": True}, open(os.path.join(app, "cache", "onboarding.json"), "w"))
    json.dump({"trustedWorkspaces": [WORK], "modelProvider": "gemini"}, open(os.path.join(app, "settings.json"), "w"))


def cmd(agent):
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", LANG="en_US.UTF-8")
    if agent == "muse":
        env["MUSE_NO_AUTO_UPDATE"] = "1"
        return [os.path.expanduser("~/.local/bin/muse"), "--provider", "echo", "--trust-workspace"], env
    env.update({
        "GEMINI_API_KEY": "AIzaSyFakeProbeKey0000000000000000000",
        "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{PORT}",
        "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
        "UNLEASH_URL": "http://127.0.0.1:9",
        "WSL_INTEROP": "probe",
    })
    return [AGY, f"--gemini_dir={GD}"], env


KEYS = {
    "exit": [b"/exit", 0.5, b"\r"],
    "quit": [b"/quit", 0.5, b"\r"],
    "ctrlc-0.3": [b"\x03", 0.3, b"\x03"],
    "ctrlc-0.8": [b"\x03", 0.8, b"\x03"],
    "ctrld-0.3": [b"\x04", 0.3, b"\x04"],
}


def run(agent, how):
    argv, env = cmd(agent)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(WORK)
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    out = bytearray()

    def pump(sec):
        end = time.monotonic() + sec
        while time.monotonic() < end:
            r, _, _ = select.select([fd], [], [], 0.02)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return False
                if not d:
                    return False
                out.extend(d)
                answer(fd, d)
        return True

    pump(10)
    for k in KEYS[how]:
        if isinstance(k, float):
            pump(k)
        else:
            os.write(fd, k)
    status = None
    end = time.monotonic() + 15
    while time.monotonic() < end:
        pump(0.2)
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            status = st
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        code = "still running after 15 s"
    elif os.WIFEXITED(status):
        code = os.WEXITSTATUS(status)
    else:
        code = f"signal {os.WTERMSIG(status)}"
    return {"agent": agent, "how": how, "exit": code}


if __name__ == "__main__":
    setup()
    server = subprocess.Popen(["/opt/homebrew/bin/node", os.path.join(KIT, "fake-gemini.mjs"), str(PORT)])
    try:
        agents = sys.argv[1].split(",")
        reps = int(sys.argv[2])
        for agent in agents:
            for how in KEYS:
                for _ in range(reps):
                    print(json.dumps(run(agent, how)), flush=True)
    finally:
        server.kill()
