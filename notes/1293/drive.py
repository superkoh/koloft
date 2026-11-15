import codecs
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

sys.path.insert(0, os.environ["PYTE_DIR"])
import pyte

CODEX = os.environ["CODEX_BIN"]
base, mode, port = sys.argv[1], sys.argv[2], sys.argv[3]
WORDS = codecs.decode(sys.argv[4], "unicode_escape") if len(sys.argv) > 4 else "fix the readme typo"
codex_home = os.path.join(base, "codexhome-" + mode)
home = os.path.join(base, "home-" + mode)
repo = os.path.join(base, "repo")
os.makedirs(codex_home, exist_ok=True)
os.makedirs(home, exist_ok=True)
with open(os.path.join(codex_home, "auth.json"), "w") as f:
    f.write('{"auth_mode":"apikey","OPENAI_API_KEY":"sk-probe-not-real"}')
with open(os.path.join(codex_home, "config.toml"), "w") as f:
    f.write("")

env = {
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": home,
    "CODEX_HOME": codex_home,
    "TERM": "xterm-256color",
    "LANG": "en_US.UTF-8",
    "RUST_LOG": "info",
}
url = "ws://127.0.0.1:" + port
out = open(os.path.join(base, "out-" + mode + ".txt"), "w")
server_log = open(os.path.join(base, "server-" + mode + ".log"), "w")
server = subprocess.Popen([CODEX, "app-server", "--listen", url], env=env, stdout=server_log, stderr=server_log)
time.sleep(2)

COLS, ROWS = 120, 40
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(repo)
    os.execve(CODEX, [CODEX, "--remote", url, "-C", repo, "-c", "check_for_update_on_startup=false"], env)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
start = time.time()
typed = False
last = None


def answer(data):
    if b"\x1b[6n" in data:
        os.write(fd, ("\x1b[%d;%dR" % (screen.cursor.y + 1, screen.cursor.x + 1)).encode())
    if b"\x1b[c" in data or b"\x1b[0c" in data:
        os.write(fd, b"\x1b[?62;22c")
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
    global last
    t = text()
    if t == last and not label.startswith("!"):
        return
    last = t
    out.write("===== %.2fs %s =====\n%s\n" % (time.time() - start, label, t))
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
            snap("screen")
            maybe_type()
    return True


def maybe_type():
    global typed
    if not mode.startswith("early") or typed or "Ask Codex" not in text():
        return
    typed = True
    snap("! composer showed, typing now")
    if mode.endswith("chunk"):
        pump(0.05)
        os.write(fd, WORDS.encode())
        pump(0.5)
        snap("! after one write of all of it")
        return
    for ch in WORDS:
        os.write(fd, ch.encode())
        pump(0.03)
        snap("! after key " + repr(ch))
    os.write(fd, b"\r")
    pump(0.3)
    snap("! after Enter")


deadline = start + 25
while time.time() < deadline:
    if not pump(0.1):
        break
snap("! end")
out.write("===== config.toml =====\n" + open(os.path.join(codex_home, "config.toml")).read() + "\n")
for _ in range(2):
    try:
        os.write(fd, b"\x03")
    except OSError:
        pass
    pump(0.5)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
server.terminate()
time.sleep(0.5)
server.kill()
out.close()
