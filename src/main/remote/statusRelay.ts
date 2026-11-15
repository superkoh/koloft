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
    for n in range(max(map(len, HELD_STARTS)) - 1, 0, -1):
        if any(len(start) > n and chunk.endswith(start[:n]) for start in HELD_STARTS):
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
            write_all(fd, heard(keys))
        else:
            reading = [fd]

write_all(1, pending)
if saved_tty is not None:
    termios.tcsetattr(0, termios.TCSAFLUSH, saved_tty)
_, status = os.waitpid(pid, 0)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`

// CC§12 PLATFORM§35
export const STATUS_RELAY_PY = `#!/usr/bin/env python3
import atexit, fcntl, os, pty, re, select, signal, sys, termios, time, tty

${STATUS_RELAY_DEFS_PY}
SYNC_ASK = b'\\x1b[?2026$p'
SYNC_ON = b'\\x1b[?2026h'
SYNC_OFF = b'\\x1b[?2026l'
HELD_STARTS = (OPEN, SYNC_ASK, SYNC_ON, SYNC_OFF)
A_WRITE_HAS_ENDED_AFTER_SECONDS = 0.1
POLL_SECONDS = A_WRITE_HAS_ENDED_AFTER_SECONDS
BLOCKED_SENT_AGAIN_EVERY_SECONDS = 2
SYNC_SUPPORTED = b'\\x1b[?2026;2$y'
SYNC_PART = re.compile(b'\\x1b\\\\[\\\\?2026(\\\\$p|h|l)')
TMUX_TAKES_SYNC = re.compile(b'\\x1b\\\\[\\\\?2026;[12]\\\\$y')
TMUX_ANSWER = re.compile(b'(\\x1b\\\\[0n|\\x1b\\\\[\\\\?2026;\\\\d\\\\$y)')
TMUX_READ_ALL_BEFORE = b'\\x1b[5n'
TMUX_HAS_READ = b'\\x1b[0n'
ASKED_TMUX = 'asked'
DREW_A_FRAME = 'drew'
BY_TMUX = 'tmux'
BY_RELAY = 'relay'
args = sys.argv[1:]
blocked = None
sent_at = 0.0
wrote_at = 0.0
frames_by = None
drawing = False
frame_open = False
reads_owed = []

${CHILD_IN_A_PTY_PY}

def synced(m):
    global drawing, frame_open
    part = m.group(1)
    if part == b'$p':
        reads_owed.append(ASKED_TMUX)
        return m.group(0) + TMUX_READ_ALL_BEFORE
    if frames_by != BY_RELAY:
        return m.group(0)
    if part == b'h':
        drawing = True
        if frame_open:
            return b''
        frame_open = True
        return through_tmux(SYNC_ON)
    drawing = False
    reads_owed.append(DREW_A_FRAME)
    return TMUX_READ_ALL_BEFORE


def close_frame():
    global frame_open
    if frame_open:
        frame_open = False
        write_all(1, through_tmux(SYNC_OFF))


atexit.register(close_frame)


def tmux_said(part):
    global frames_by
    if part != TMUX_HAS_READ or not reads_owed:
        if TMUX_TAKES_SYNC.match(part):
            frames_by = frames_by or BY_TMUX
        return part
    why = reads_owed.pop(0)
    if why == DREW_A_FRAME:
        if not drawing and DREW_A_FRAME not in reads_owed:
            close_frame()
        return b''
    if frames_by == BY_TMUX:
        return b''
    frames_by = BY_RELAY
    return SYNC_SUPPORTED


def heard(keys):
    return b''.join(map(tmux_said, TMUX_ANSWER.split(keys)))


def passed_on(m):
    global blocked, sent_at
    body = m.group(1)
    if body == b'?':
        write_all(fd, STATUS_REPLY)
        return b''
    parts = body.split(b':')
    if not any(part.startswith(b'id=') for part in parts):
        blocked = m.group(0) if b'state=blocked' in parts else None
        sent_at = time.time()
    return through_tmux(m.group(0))


def translate(chunk):
    global wrote_at
    wrote_at = time.time()
    return SYNC_PART.sub(synced, FRAME.sub(passed_on, chunk))


def poll():
    global sent_at
    now = time.time()
    quiet = not pending and now - wrote_at >= A_WRITE_HAS_ENDED_AFTER_SECONDS
    if blocked and quiet and now - sent_at >= BLOCKED_SENT_AGAIN_EVERY_SECONDS:
        sent_at = now
        write_all(1, through_tmux(blocked))


${RELAY_LOOP_PY}`
