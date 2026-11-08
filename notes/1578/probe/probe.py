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
PATH = "/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin"
MUSE = "/home/u/.local/bin/muse-bin-1.4.11-R6667.1"
AGY = "/probe/agy"
PORT = 47811
SYNC_ON = b"\x1b[?2026h"
SYNC_OFF = b"\x1b[?2026l"
OSC8 = re.compile(rb"\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)")
QUERY = re.compile(rb"\x1b\[(\?|>)?([0-9;]*)(\$?)([a-zA-Z])")
XTVERSION_ASK = re.compile(rb"\x1b\[>0?q")


def long_prompt():
    lines = ["Here is the long answer.", ""]
    for i in range(1, 161):
        lines.append(f"{i}. Line {i}: see [doc {i}](http://127.0.0.1:{PORT}/link-{i}) and also http://127.0.0.1:{PORT}/bare-{i} for part {i}.")
    lines += ["", "END-OF-REPLY"]
    return "\n".join(lines)


def answer(fd, data, asked):
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
            asked.append(mode)
            os.write(fd, b"\x1b[?%d;%d$y" % (mode, 2 if mode in (1, 25, 1000, 1002, 1003, 1004, 1006, 1049, 2004, 2026) else 0))
    for m in re.finditer(rb"\x1b\](10|11);\?(\x07|\x1b\\)", data):
        os.write(fd, b"\x1b]" + m.group(1) + b";rgb:1a1a/1a1a/1e1e\x1b\\")


def chunks_of(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, "rb") as f:
        while True:
            h = f.read(12)
            if len(h) < 12:
                break
            t, n = struct.unpack("<dI", h)
            out.append((t, f.read(n)))
    return out


TOKEN = re.compile(rb"\x1b\[\?2026[hl]")
ESC_SEQ = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x1b[78=>]")
PAINTS = re.compile(rb"\x1b\[[0-9;]*[@JKLMPSTX]$")


def painted_outside(stream, on):
    painted = 0
    pos = 0
    segs = []
    for m in TOKEN.finditer(stream):
        if not on:
            segs.append(stream[pos:m.start()])
        on = m.group(0) == SYNC_ON
        pos = m.end()
    if not on:
        segs.append(stream[pos:])
    for seg in segs:
        for m in ESC_SEQ.finditer(seg):
            if PAINTS.match(m.group(0)):
                painted += 1
        rest = ESC_SEQ.sub(b"", seg)
        painted += sum(1 for b in rest if b >= 0x20 and b != 0x7F or b == 0x0A)
    return painted, on


def painted_bursts(chunks):
    bursts, cur, last = [], None, None
    for t, d in chunks:
        if cur is None or t - last > 0.004:
            cur = [b""]
            bursts.append(cur)
        cur[0] += d
        last = t
    on = False
    n = 0
    for (data,) in bursts:
        p, on = painted_outside(data, on)
        if p:
            n += 1
    return [n, len(bursts)]


def agent_cmd(agent, base, work):
    if agent == "muse":
        env = {
            "HOME": os.path.join(base, "home"),
            "XDG_CONFIG_HOME": os.path.join(base, "home", ".config"),
            "XDG_DATA_HOME": os.path.join(base, "home", ".local", "share"),
            "MUSE_NO_AUTO_UPDATE": "1",
            "META_API_KEY": "FAKE",
            "MUSE_MODEL": "fake-model",
        }
        argv = [MUSE, "--base-url", "http://127.0.0.1:8787", "--trust-workspace", "go"]
        if os.environ.get("MUSE_ECHO"):
            argv = [MUSE, "--provider", "echo", "--trust-workspace", long_prompt()]
        return env, argv
    gem = os.path.join(base, "agyhome")
    os.makedirs(os.path.join(gem, "antigravity-cli", "cache"), exist_ok=True)
    json.dump({"onboardingComplete": True, "consumerOnboardingComplete": True}, open(os.path.join(gem, "antigravity-cli", "cache", "onboarding.json"), "w"))
    json.dump({"trustedWorkspaces": [work], "modelProvider": "gemini", "altScreenMode": "always"}, open(os.path.join(gem, "antigravity-cli", "settings.json"), "w"))
    env = {
        "HOME": os.path.join(base, "home"),
        "GEMINI_API_KEY": "AIzaSyFakeProbeKey0000000000000000000",
        "GOOGLE_GEMINI_BASE_URL": f"http://127.0.0.1:{PORT}",
        "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
        "UNLEASH_URL": "http://127.0.0.1:9",
    }
    return env, [AGY, f"--gemini_dir={gem}"]


def run(label, agent, where, tp, relay):
    base = f"/tmp/lab-{label}"
    subprocess.run(["rm", "-rf", base])
    work = os.path.join(base, "work")
    os.makedirs(work)
    os.makedirs(os.path.join(base, "home"))
    agent_env, argv = agent_cmd(agent, base, work)
    inner = os.path.join(base, "inner.bin")
    asked = []
    outer_env = {"PATH": PATH, "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": "C.UTF-8", "HOME": os.path.join(base, "home")}
    if where == "direct":
        env = dict(outer_env, **agent_env)
        if tp != "unset":
            env["TERM_PROGRAM"] = tp
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(work)
            os.execvpe(argv[0], argv, env)
    else:
        argfile = os.path.join(base, "argv.json")
        json.dump(argv, open(argfile, "w"))
        if tp != "x":
            agent_env["TERM_PROGRAM"] = tp
        envs = " ".join(f"{k}={v}" for k, v in agent_env.items())
        relay_part = f"python3 {relay} " if relay != "-" else ""
        cmd = f"cd {work} && env {envs} {relay_part}python3 /probe/teelog.py {inner} python3 /probe/execjson.py {argfile}"
        conf = "/probe/tmux.conf"
        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe("tmux", ["tmux", "-L", f"k-{label}", "-u", "-f", conf, "new-session", "-x", str(COLS), "-y", str(ROWS), cmd], outer_env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    chunks = []
    t0 = time.monotonic()

    def pump(sec):
        end = time.monotonic() + sec
        while time.monotonic() < end:
            r, _, _ = select.select([fd], [], [], 0.005)
            if r:
                try:
                    d = os.read(fd, 65536)
                except OSError:
                    return
                if not d:
                    return
                chunks.append((time.monotonic() - t0, d))
                answer(fd, d, asked)

    def seen(word):
        return word in b"".join(d for _, d in chunks)

    pump(6)
    if agent == "agy":
        os.write(fd, b"go")
        pump(0.3)
        os.write(fd, b"\r")
    end = time.monotonic() + 25
    while time.monotonic() < end and not seen(b"END-OF-REPLY"):
        pump(0.2)
    pump(2)
    cut = len(chunks)
    for _ in range(30):
        os.write(fd, b"\x1b[<64;60;20M")
        pump(0.05)
    for _ in range(30):
        os.write(fd, b"\x1b[<65;60;20M")
        pump(0.05)
    for _ in range(4):
        os.write(fd, b"\x1b[5~")
        pump(0.2)
    for _ in range(4):
        os.write(fd, b"\x1b[6~")
        pump(0.2)
    pump(1.5)
    tmux_version = subprocess.run(["tmux", "-V"], capture_output=True, text=True).stdout.strip()
    if where == "tmux":
        subprocess.run(["tmux", "-L", f"k-{label}", "kill-server"], env=outer_env)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    outdir = f"/tmp/out/{label}"
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, "outer.bin"), "wb") as f:
        for t, d in chunks:
            f.write(struct.pack("<dI", t, len(d)) + d)
    outer_all = b"".join(d for _, d in chunks)
    outer_scroll = b"".join(d for _, d in chunks[cut:])
    if where == "tmux":
        own = b"".join(d for _, d in chunks_of(inner))
        own_in = b"".join(d for _, d in chunks_of(inner + ".in"))
        subprocess.run(["cp", inner, os.path.join(outdir, "inner.bin")])
    else:
        own = outer_all
        own_in = b""
    res = {
        "label": label,
        "agent": agent,
        "where": where,
        "termProgram": tp if where == "direct" else open(os.path.join(base, "argv.json.term_program")).read(),
        "paintBurstsOutsideSync": painted_bursts(chunks[cut:]),
        "relay": relay,
        "tmux": tmux_version if where == "tmux" else None,
        "replyShown": b"END-OF-REPLY" in outer_all,
        "ownBytes": len(own),
        "ownSyncOn": own.count(SYNC_ON),
        "ownSyncOff": own.count(SYNC_OFF),
        "ownAsksDecrqm": sorted(set(int(m) for m in re.findall(rb"\x1b\[\?(\d+)\$p", own))),
        "ownAsksXtversion": len(XTVERSION_ASK.findall(own)),
        "ownOsc8Links": len(OSC8.findall(own)),
        "ownGot2026Answer": [m.decode() for m in re.findall(rb"\x1b\[\?2026;(\d)\$y", own_in)],
        "ownGotXtversion": [m.decode("utf-8", "replace") for m in re.findall(rb"\x1bP>\|([^\x1b]*)", own_in)],
        "outerBytes": len(outer_all),
        "outerSyncOn": outer_all.count(SYNC_ON),
        "outerSyncOff": outer_all.count(SYNC_OFF),
        "outerScrollBytes": len(outer_scroll),
        "outerScrollSyncOn": outer_scroll.count(SYNC_ON),
        "outerOsc8Links": len(OSC8.findall(outer_all)),
        "outerPassthrough": outer_all.count(b"\x1bPtmux;"),
        "outerAsksDecrqmSeen": sorted(set(asked)),
    }
    return res


if __name__ == "__main__":
    label, agent, where, tp, relay = sys.argv[1:6]
    r = run(label, agent, where, tp, relay)
    print(json.dumps(r), flush=True)
    json.dump(r, open(f"/tmp/out/{label}/result.json", "w"), indent=1)
