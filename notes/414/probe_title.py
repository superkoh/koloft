import json
import os
import pty
import re
import select
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CLAUDE = os.path.join(HOME, "bin", "claude")
HOOK = os.path.join(HOME, "hook.sh")
LOG = os.path.join(HOME, ".koloft", "hook-sessions", "probe.jsonl")
BIG_FILES = int(os.environ.get("BIG_FILES", "60000"))
ENV = dict(os.environ, TERM="xterm-256color", DISABLE_AUTOUPDATER="1", LANG="C.UTF-8")

KOLOFT_TMUX_CONF = """set -g default-shell /bin/sh
set -g status off
set -g prefix None
set -g prefix2 None
set -sg escape-time 0
set -g default-terminal tmux-256color
set -asq terminal-features ',xterm*:RGB:hyperlinks'
set -gq exit-empty on
set -g mouse off
set -gq allow-passthrough on
"""
TITLE_LINES = """set -g set-titles on
set -g set-titles-string '#{pane_title}'
set -asq terminal-features ',xterm*:title'
"""
OSC_TITLE = re.compile(rb"\x1b\][012];[^\x07\x1b]*(\x07|\x1b\\\\)")


def run(*args, cwd=None, check=True):
    return subprocess.run(args, cwd=cwd, env=ENV, check=check, capture_output=True, text=True).stdout


def hook_started():
    return os.path.exists(LOG) and '"start"' in open(LOG).read()


def variant(name, conf_text):
    print(f"\n=== {name}")
    repo = os.path.join(HOME, f"trepo-{name}")
    os.makedirs(repo)
    run("git", "init", "-q", "-b", "main", cwd=repo)
    open(os.path.join(repo, ".gitignore"), "w").write("big/\n")
    open(os.path.join(repo, "README.md"), "w").write("probe\n")
    run("git", "add", ".", cwd=repo)
    run("git", "-c", "user.name=p", "-c", "user.email=p@p", "commit", "-q", "-m", "init", cwd=repo)
    cj = os.path.join(HOME, ".claude.json")
    data = json.load(open(cj)) if os.path.exists(cj) else {}
    data["hasCompletedOnboarding"] = True
    data.setdefault("projects", {})[repo] = {"hasTrustDialogAccepted": True}
    json.dump(data, open(cj, "w"))
    settings = os.path.join(HOME, f"tsettings-{name}.json")
    json.dump(
        {
            "apiKeyHelper": "echo sk-ant-api03-fake-probe-key",
            "hooks": {
                ev: [{"hooks": [{"type": "command", "command": f"sh {HOOK} {tag}"}]}]
                for ev, tag in [("SessionStart", "start"), ("SessionEnd", "end"), ("UserPromptSubmit", "prompt")]
            },
        },
        open(settings, "w"),
    )
    mcp = os.path.join(HOME, "mcp.json")
    json.dump({"mcpServers": {}}, open(mcp, "w"))
    conf = os.path.join(HOME, f"tmux-{name}.conf")
    open(conf, "w").write(conf_text)
    if os.path.exists(LOG):
        os.remove(LOG)

    sock = f"k{name}"
    tm = lambda *a: run("tmux", "-L", sock, "-f", conf, *a, check=False)
    launch = f"cd {repo} && exec {CLAUDE} -w wt --settings {settings} --strict-mcp-config --mcp-config {mcp}"
    tm("new-session", "-d", "-s", "s", "-x", "120", "-y", "40", launch)

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe("tmux", ["tmux", "-L", sock, "-f", conf, "attach", "-t", "s"], ENV)
    import fcntl
    import struct
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    chunks = []

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.02)
            if r:
                try:
                    b = os.read(fd, 65536)
                except OSError:
                    return False
                if not b:
                    return False
                chunks.append((time.time(), b))
        return True

    end = time.time() + 60
    while not hook_started() and time.time() < end:
        pump(0.1)
    tree = os.path.join(repo, ".claude", "worktrees", "wt")
    big = os.path.join(tree, "big")
    os.makedirs(big)
    for i in range(BIG_FILES):
        d = os.path.join(big, str(i // 1000))
        if i % 1000 == 0:
            os.makedirs(d)
        open(os.path.join(d, str(i)), "w").close()
    pump(1.5)
    if name.endswith("-msg"):
        tm("send-keys", "-t", "s", "-l", "hello")
        pump(0.6)
        tm("send-keys", "-t", "s", "Enter")
        end = time.time() + 30
        while '"prompt"' not in open(LOG).read() and time.time() < end:
            pump(0.1)
        pump(3)
    tm("send-keys", "-t", "s", "-l", "/exit")
    pump(0.6)
    t0 = time.time()
    tm("send-keys", "-t", "s", "Enter")
    gone_at = None
    while time.time() < t0 + 60:
        alive = pump(0.02)
        if gone_at is None and not os.path.exists(tree):
            gone_at = time.time() - t0
        if not alive:
            break
    print(f"  worktree folder gone at +{gone_at:.3f}s" if gone_at else "  worktree folder not gone")
    end_t = None
    if os.path.exists(LOG):
        for line in open(LOG):
            rec = json.loads(line)
            if rec["event"] == "end":
                end_t = rec["t"] - t0
    print(f"  SessionEnd hook ran at +{end_t:.3f}s" if end_t is not None else "  no SessionEnd")

    stream = b"".join(b for _, b in chunks)
    open(os.path.join(HOME, f"stream-{name}.bin"), "wb").write(stream)
    offsets = []
    pos = 0
    for t, b in chunks:
        offsets.append((pos, t))
        pos += len(b)

    def time_at(off):
        t_found = chunks[0][0]
        for o, t in offsets:
            if o <= off:
                t_found = t
        return t_found - t0

    titles = [(m.start(), m.group(0)) for m in OSC_TITLE.finditer(stream)]
    print(f"  title codes seen by the outer terminal: {len(titles)}")
    for off, code in titles[-6:]:
        print(f"    +{time_at(off):7.3f}s {code!r}")
    rem = stream.find("Removing worktree".encode())
    if rem < 0:
        print("  'Removing worktree' never reached the outer terminal")
        return
    print(f"  'Removing worktree' reached the outer terminal at +{time_at(rem):.3f}s")
    before = [t for t in titles if t[0] < rem]
    if before:
        off, code = before[-1]
        between = stream[off + len(code) : rem]
        print(f"  last title before it: {code!r}, {len(between)} bytes between: {between[:600]!r}")
    print(f"  bytes around the line: {stream[max(0, rem - 200): rem + 40]!r}")


print("claude", run(CLAUDE, "--version").strip(), "| tmux", run("tmux", "-V").strip())
for arg in sys.argv[1:]:
    variant(arg, KOLOFT_TMUX_CONF + (TITLE_LINES if arg.startswith("titles") else ""))
