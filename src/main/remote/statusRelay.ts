import { PROGRAM_STATUS_REPLY } from '../programStatus'

export const STATUS_RELAY_FILE = 'status-relay.py'

export const pyBytes = (s: string): string =>
  "b'" + [...s].map((c) => (c === '\x1b' ? '\\x1b' : c === '\\' ? '\\\\' : c)).join('') + "'"

// MUSE§3 MUSE§6 MUSE§17
export const STATUS_RELAY_DEFS_PY = `STATUS_REPLY = ${pyBytes(PROGRAM_STATUS_REPLY)}
OPEN = b'\\x1b]7501;'
FRAME = re.compile(b'\\x1b\\\\]7501;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\\\\\)')
LONGEST_PARTIAL_FRAME = 4096
in_tmux = bool(os.environ.get('TMUX'))


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def through_tmux(frame):
    return b'\\x1bPtmux;' + frame.replace(b'\\x1b', b'\\x1b\\x1b') + b'\\x1b\\\\' if in_tmux else frame


def held_back(chunk):
    cut = chunk.rfind(OPEN)
    if cut >= 0 and not FRAME.search(chunk, cut) and len(chunk) - cut < LONGEST_PARTIAL_FRAME:
        return cut
    for n in range(len(OPEN) - 1, 0, -1):
        if chunk.endswith(OPEN[:n]):
            return len(chunk) - n
    return len(chunk)
`

export const CHILD_IN_A_PTY_PY = `pid, fd = pty.fork()
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
`

export const RELAY_LOOP_PY = `reading = [0, fd]
pending = b''
next_poll = 0.0
while True:
    now = time.time()
    if now >= next_poll:
        poll()
        next_poll = now + POLL_SECONDS
    try:
        ready, _, _ = select.select(reading, [], [], POLL_SECONDS)
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
        write_all(1, translate(chunk))
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

// CC§12
export const STATUS_RELAY_PY = `#!/usr/bin/env python3
import fcntl, os, pty, re, select, signal, sys, termios, time, tty

${STATUS_RELAY_DEFS_PY}
A_WRITE_HAS_ENDED_AFTER_SECONDS = 0.1
POLL_SECONDS = A_WRITE_HAS_ENDED_AFTER_SECONDS
STATE_SENT_AGAIN_EVERY_SECONDS = 2
args = sys.argv[1:]
last_state = None
sent_at = 0.0
wrote_at = 0.0

${CHILD_IN_A_PTY_PY}

def passed_on(m):
    global last_state, sent_at
    body = m.group(1)
    if body == b'?':
        write_all(fd, STATUS_REPLY)
        return b''
    if not any(part.startswith(b'id=') for part in body.split(b':')):
        last_state = m.group(0)
        sent_at = time.time()
    return through_tmux(m.group(0))


def translate(chunk):
    global wrote_at
    wrote_at = time.time()
    return FRAME.sub(passed_on, chunk)


def poll():
    global sent_at
    now = time.time()
    quiet = not pending and now - wrote_at >= A_WRITE_HAS_ENDED_AFTER_SECONDS
    if last_state and quiet and now - sent_at >= STATE_SENT_AGAIN_EVERY_SECONDS:
        sent_at = now
        write_all(1, through_tmux(last_state))


${RELAY_LOOP_PY}`
