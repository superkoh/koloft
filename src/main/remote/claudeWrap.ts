import { PROGRAM_STATUS_REPLY } from '../programStatus'

export const CLAUDE_WRAP_FILE = 'claude-wrap.py'

const pyBytes = (s: string): string =>
  "b'" + [...s].map((c) => (c === '\x1b' ? '\\x1b' : c === '\\' ? '\\\\' : c)).join('') + "'"

// CC§12 MUSE§6 MUSE§17
export const CLAUDE_WRAP_PY = `#!/usr/bin/env python3
import fcntl, os, pty, re, select, signal, sys, termios, tty

STATUS_REPLY = ${pyBytes(PROGRAM_STATUS_REPLY)}
OPEN = b'\\x1b]7501;'
FRAME = re.compile(b'\\x1b\\\\]7501;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\\\\\)')
LONGEST_PARTIAL_FRAME = 4096
args = sys.argv[1:]


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(args[0], args)
    except OSError as e:
        sys.stderr.write('[Koloft] could not start %s: %s\\n' % (args[0], e))
    os._exit(127)


def copy_size(*_):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\0' * 8))
    except OSError:
        pass


copy_size()
signal.signal(signal.SIGWINCH, copy_size)
try:
    saved_tty = termios.tcgetattr(0)
    tty.setraw(0)
except Exception:
    saved_tty = None


def passed_on(m):
    if m.group(1) == b'?':
        write_all(fd, STATUS_REPLY)
        return b''
    return b'\\x1bPtmux;' + m.group(0).replace(b'\\x1b', b'\\x1b\\x1b') + b'\\x1b\\\\'


def held_back(chunk):
    cut = chunk.rfind(OPEN)
    if cut >= 0 and not FRAME.search(chunk, cut) and len(chunk) - cut < LONGEST_PARTIAL_FRAME:
        return cut
    for n in range(len(OPEN) - 1, 0, -1):
        if chunk.endswith(OPEN[:n]):
            return len(chunk) - n
    return len(chunk)


reading = [0, fd]
pending = b''
while True:
    try:
        ready, _, _ = select.select(reading, [], [])
    except InterruptedError:
        continue
    if fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunk = pending + chunk
        cut = held_back(chunk)
        pending, chunk = chunk[cut:], chunk[:cut]
        write_all(1, FRAME.sub(passed_on, chunk))
    if 0 in ready:
        try:
            keys = os.read(0, 65536)
        except OSError:
            keys = b''
        if keys:
            write_all(fd, keys)
        else:
            reading = [fd]

write_all(1, pending)
if saved_tty is not None:
    termios.tcsetattr(0, termios.TCSAFLUSH, saved_tty)
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`
