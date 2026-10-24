import { shq } from '@shared/shellQuote'
import { PROGRAM_STATUS_REPLY } from './programStatus'
import { REMOTE_HOOK_DIR } from './remote/paths'
import { SAID_MARKS } from './museSessionLog'
import { museHookScript } from './museHooks'
import { remoteNoticeFile } from './hooks'
import { KOLOFT_SKILL, MUSE_STOPS_WHEN_THIS_LINK_DANGLES } from './museAccounts'

export const MUSE_WRAP_FILE = 'muse-wrap.py'
export const MUSE_HOOK_FILE = 'muse-hook.sh'

export const MIRROR_SUFFIX = '.muse.jsonl'
export const RUN_POINTER_SUFFIX = '.muse.run'

const pyBytes = (s: string): string =>
  "b'" + [...s].map((c) => (c === '\x1b' ? '\\x1b' : c === '\\' ? '\\\\' : c)).join('') + "'"

// MUSE§2 MUSE§3 MUSE§4 MUSE§9 MUSE§17 PLATFORM§35
export const MUSE_WRAP_PY = `#!/usr/bin/env python3
import fcntl, json, os, pty, re, select, signal, subprocess, sys, termios, time, tty

STATUS_REPLY = ${pyBytes(PROGRAM_STATUS_REPLY)}
OPEN = b'\\x1b]7501;'
FRAME = re.compile(b'\\x1b\\\\]7501;([^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\\\\\)')
LONGEST_PARTIAL_FRAME = 4096
POLL_SECONDS = 0.5
DAY_MS = 86400000
LOG_MARKS = (b'session.name.changed', b'inbox_item_queued', b'context.compact.manual')

hook_dir, run_id = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
trust, trust_if = [], None
while args and args[0] != '--':
    if args[0] == '--trust':
        trust.append(args[1])
    elif args[0] == '--trust-if':
        trust_if = args[1]
    args = args[2:]
args = args[1:]

home = os.path.expanduser('~')
config = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.join(home, '.config'), 'muse')
data = os.path.join(os.environ.get('XDG_DATA_HOME') or os.path.join(home, '.local', 'share'), 'muse')
registries = [os.path.join(data, 'runtime', 'muse', 'sessions'), '/tmp/tbh-%d-rt/muse/sessions' % os.getuid()]
trust_file = os.path.join(config, 'trust.json')
tabs = os.path.join(os.path.dirname(hook_dir), 'tabs')
in_tmux = bool(os.environ.get('TMUX'))


def read_json(path):
    try:
        with open(path, encoding='utf-8') as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def readable_or_missing(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        value = json.load(f)
    return value if isinstance(value, dict) else None


def write_whole(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.koloft', 'w') as f:
        f.write(text)
    os.replace(path + '.koloft', path)


def projects_of(doc):
    projects = doc.get('projects')
    return projects if isinstance(projects, dict) else {}


def trusted(folder):
    entry = projects_of(read_json(trust_file)).get(os.path.realpath(folder))
    return isinstance(entry, dict) and entry.get('decision') == 'trusted'


try:
    doc = readable_or_missing(trust_file) if trust else None
except Exception:
    doc = None
if doc is not None:
    projects = projects_of(doc)
    for folder in trust:
        projects[os.path.realpath(folder)] = {'decision': 'trusted'}
    out = {'schema_version': 1}
    out.update(doc)
    out['projects'] = projects
    write_whole(os.path.realpath(trust_file), json.dumps(out, indent=2))
if trust_if and trusted(trust_if):
    args = args[:1] + ['--trust-workspace'] + args[1:]

os.makedirs(hook_dir, exist_ok=True)
mirror = os.open(os.path.join(hook_dir, run_id + '${MIRROR_SUFFIX}'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)


def put(record):
    os.write(mirror, (json.dumps(record, separators=(',', ':')) + '\\n').encode())


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

seq = 0


def translate(chunk):
    global seq
    out, last = [], 0
    for m in FRAME.finditer(chunk):
        out.append(chunk[last:m.start()])
        last = m.end()
        body = m.group(1)
        if body == b'?':
            write_all(fd, STATUS_REPLY)
            continue
        fields = dict(part.split(b'=', 1) for part in body.split(b':') if b'=' in part)
        if b'state' not in fields:
            continue
        seq += 1
        kind = fields.get(b'kind')
        put({'t': 'state', 'seq': seq, 'state': fields[b'state'].decode(), 'kind': kind.decode() if kind else None})
        frame = OPEN + body + (':seq=%d' % seq).encode() + b'\\x1b\\\\'
        out.append(b'\\x1bPtmux;' + frame.replace(b'\\x1b', b'\\x1b\\x1b') + b'\\x1b\\\\' if in_tmux else frame)
    out.append(chunk[last:])
    return b''.join(out)


bound = None
log = {'path': None, 'offset': 0, 'rest': b''}


def log_path(sid):
    try:
        ms = int(sid.replace('-', '')[:12], 16)
    except ValueError:
        return None
    for shift in (0, -DAY_MS, DAY_MS):
        t = time.localtime((ms + shift) / 1000.0)
        path = os.path.join(data, 'sessions', '%04d' % t.tm_year, '%02d' % t.tm_mon, '%02d' % t.tm_mday, sid, 'session.jsonl')
        if os.path.exists(path):
            return path
    return None


def forward(line):
    if not any(mark in line for mark in LOG_MARKS):
        return
    try:
        record = json.loads(line.decode('utf-8', 'replace'))
    except ValueError:
        return
    if isinstance(record, dict) and isinstance(record.get('payload_type'), str):
        put({'t': 'log', 'seq': seq, 'payloadType': record['payload_type'], 'payload': record.get('payload')})


def follow_log():
    if not bound:
        return
    if not log['path']:
        log['path'] = log_path(bound)
        if not log['path']:
            return
    try:
        size = os.path.getsize(log['path'])
        if size <= log['offset']:
            return
        with open(log['path'], 'rb') as f:
            f.seek(log['offset'])
            chunk = f.read(size - log['offset'])
    except OSError:
        return
    log['offset'] += len(chunk)
    lines = (log['rest'] + chunk).split(b'\\n')
    log['rest'] = lines.pop()
    for line in lines:
        forward(line)


def bind(sid):
    global bound
    bound = sid
    path = log_path(sid)
    log.update(path=path, offset=os.path.getsize(path) if path else 0, rest=b'')
    put({'t': 'bound', 'sessionId': sid})
    name = 'k-' + sid
    write_whole(os.path.join(hook_dir, name + '${RUN_POINTER_SUFFIX}'), run_id)
    write_whole(os.path.join(tabs, run_id + '.tmux'), name)
    if in_tmux:
        with open(os.devnull, 'w') as quiet:
            subprocess.call(['tmux', 'rename-session', '-t', os.environ.get('TMUX_PANE', ''), name], stdout=quiet, stderr=quiet)


registry_seen = [None]


def follow_registry():
    mine = 'pid=%d' % pid
    best = None
    there = [folder for folder in registries if os.path.isdir(folder)]
    try:
        changed = max(os.stat(folder).st_mtime for folder in there) if there else None
    except OSError:
        return
    if changed is None or (bound and changed == registry_seen[0]):
        return
    registry_seen[0] = changed
    paths = []
    for folder in there:
        try:
            paths += [os.path.join(folder, name) for name in os.listdir(folder) if name.endswith('.json')]
        except OSError:
            pass
    for path in paths:
        entry = read_json(path)
        sid = entry.get('session_id')
        if entry.get('process_generation_hint') != mine or not isinstance(sid, str):
            continue
        try:
            at = os.stat(path).st_mtime
        except OSError:
            continue
        if best is None or at > best[0]:
            best = (at, sid)
    if best and best[1] != bound:
        bind(best[1])


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
next_poll = 0.0
while True:
    now = time.time()
    if now >= next_poll:
        follow_registry()
        follow_log()
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

// MUSE§9 MUSE§17 ADR-0031
export const REMOTE_MUSE_HOOK_SH = museHookScript(
  `f="${REMOTE_HOOK_DIR}/$1${MIRROR_SUFFIX}"
event="$2"
said="$HOME/.koloft/tabs/$1.said"
notice="${remoteNoticeFile('$1')}"`,
  `p="$(mktemp 2>/dev/null)" || exit 0
printf '{"t":"hook","event":"%s","input":%s}\\n' "$event" "$input" > "$p" && cat "$p" >> "$f"
rm -f "$p"`
)

const SAID_LINES_A_FILE_HANDS_BACK = 20

// MUSE§2
export const MUSE_LOG_GREP = `t="$1"; shift
for f in "$@"; do
  grep -F ${SAID_MARKS.map((m) => `-e ${shq(m)}`).join(' ')} "$f" 2>/dev/null | grep -i -F -- "$t" | head -n ${SAID_LINES_A_FILE_HANDS_BACK} | while IFS= read -r l; do printf '%s\\t%s\\n' "$f" "$l"; done
done
exit 0`

// MUSE§10
export const MUSE_TRUSTED_SH = `cd "$1" 2>/dev/null || exit 1
d="$(pwd -P)"
for f in "\${XDG_CONFIG_HOME:-$HOME/.config}/muse/trust.json" "$HOME"/.koloft/muse-homes/*/muse/trust.json; do
  [ -f "$f" ] && python3 -c 'import json, sys; p = json.load(open(sys.argv[1])).get("projects") or {}; sys.exit(0 if (p.get(sys.argv[2]) or {}).get("decision") == "trusted" else 1)' "$f" "$d" 2>/dev/null && exit 0
done
exit 1`

export interface MuseRunSpec {
  tabId: string
  account: string
  args: string[]
  trust: string[]
  trustIf?: string
}

const MUSE_WRITES_THROUGH_THESE_LINKS = ['settings.json', 'trust.json']

// MUSE§2 MUSE§13 MUSE§16 MUSE§17
export function museRunLines(s: MuseRunSpec): string {
  const options = [
    ...s.trust.flatMap((dir) => ['--trust', dir]),
    ...(s.trustIf ? ['--trust-if', s.trustIf] : [])
  ]
  return `  O="\${XDG_CONFIG_HOME:-$HOME/.config}/muse"
  A="$HOME/.koloft/muse-homes/"${shq(s.account)}
  mkdir -p "$A/muse" "$O" && chmod 700 "$HOME/.koloft/muse-homes" "$A" "$A/muse"
  [ -f "$T.auth.json" ] && mv -f "$T.auth.json" "$A/muse/auth.json"
  for f in ${MUSE_WRITES_THROUGH_THESE_LINKS.join(' ')}; do
    [ -e "$A/muse/$f" ] || [ -L "$A/muse/$f" ] || ln -s "$O/$f" "$A/muse/$f"
  done
  G="$A/muse/${MUSE_STOPS_WHEN_THIS_LINK_DANGLES}"
  [ -L "$G" ] && [ ! -e "$G" ] && rm -f "$G"
  [ -e "$G" ] || [ ! -e "$O/${MUSE_STOPS_WHEN_THIS_LINK_DANGLES}" ] || ln -s "$O/${MUSE_STOPS_WHEN_THIS_LINK_DANGLES}" "$G"
  S="$A/muse/skills"; mkdir -p "$S"; rm -rf "$S/${KOLOFT_SKILL}"
  [ -f "$T.skill.md" ] && mkdir -p "$S/${KOLOFT_SKILL}" && mv -f "$T.skill.md" "$S/${KOLOFT_SKILL}/SKILL.md"
  for s in "$O/skills"/*; do
    [ -e "$s" ] && [ ! -e "$S/\${s##*/}" ] && [ ! -L "$S/\${s##*/}" ] && ln -s "$s" "$S/"
  done
  XDG_CONFIG_HOME="$A"; TBH_CREDENTIAL_BACKEND=file; TBH_MANAGED_HOOKS_PATH="$T.hooks.json"
  export XDG_CONFIG_HOME TBH_CREDENTIAL_BACKEND TBH_MANAGED_HOOKS_PATH
  exec python3 "$M/${MUSE_WRAP_FILE}" "${REMOTE_HOOK_DIR}" ${s.tabId} ${options.map(shq).join(' ')} -- muse ${s.args.map(shq).join(' ')}
`
}
