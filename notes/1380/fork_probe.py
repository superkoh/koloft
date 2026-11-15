import fcntl, glob, json, os, pty, re, select, shutil, signal, sqlite3, struct, subprocess, sys, termios, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

H = os.path.expanduser('~')
BIN = sys.argv[1]
G = H + '/g'
A = G + '/antigravity-cli'
WS = H + '/ws'
shutil.rmtree(G, ignore_errors=True)
os.makedirs(A + '/cache')
os.makedirs(WS, exist_ok=True)
with open(A + '/settings.json', 'w') as f:
    json.dump({'modelProvider': 'gemini', 'trustedWorkspaces': [WS]}, f)
with open(A + '/cache/onboarding.json', 'w') as f:
    json.dump({'onboardingComplete': True, 'consumerOnboardingComplete': True}, f)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length') or 0))
        data = {'candidates': [{'content': {'role': 'model', 'parts': [{'text': 'done'}]}, 'finishReason': 'STOP'}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}
        out = ('data: %s\n\n' % json.dumps(data)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', 8788), Handler).serve_forever, daemon=True).start()

env = {'HOME': H, 'USER': 'u', 'SHELL': '/bin/bash', 'PATH': '/usr/local/bin:/usr/bin:/bin', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
       'GEMINI_API_KEY': 'made-up', 'GOOGLE_GEMINI_BASE_URL': 'http://127.0.0.1:8788', 'PWD': WS}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.execve(BIN, [BIN, '--gemini_dir=' + G], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
ANSWERS = [
    (b'\x1b]7501;?', b'\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'),
    (b'\x1b[6n', b'\x1b[1;1R'),
    (b'\x1b[c', b'\x1b[?62;22c'),
    (b'\x1b[>q', b'\x1bP>|xterm.js(5.5.0)\x1b\\'),
    (b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'),
    (b'\x1b[?u', b'\x1b[?0u'),
]
out = bytearray()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            out.extend(chunk)
            for q, a in ANSWERS:
                if q in chunk:
                    os.write(fd, a)
            for m in re.finditer(rb'\x1b\[\?(\d+)\$p', chunk):
                os.write(fd, b'\x1b[?' + m.group(1) + b';2$y')


def held_lock():
    for p in glob.glob(A + '/presence/*.lock'):
        try:
            f = open(p, 'rb')
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(f, fcntl.LOCK_UN)
            f.close()
        except OSError:
            return os.path.basename(p)[:-5]
    return None


def rows():
    db = A + '/conversation_summaries.db'
    if not os.path.exists(db):
        return {}
    try:
        c = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
        got = {r[0]: {'title': r[1], 'step_count': r[2], 'parent': r[3], 'last_user_input_time': r[4], 'status': r[5]}
               for r in c.execute('select conversation_id, title, step_count, parent_conversation_id, last_user_input_time, status from conversation_summaries')}
        c.close()
        return got
    except Exception as e:
        return {'error': str(e)}


def transcript_lines(cid):
    p = '%s/brain/%s/.system_generated/logs/transcript.jsonl' % (A, cid)
    if not os.path.exists(p):
        return None
    return [json.loads(l).get('type') for l in open(p).read().splitlines() if l.strip()]


def db_steps(cid):
    p = '%s/conversations/%s.db' % (A, cid)
    if not os.path.exists(p):
        return None
    try:
        c = sqlite3.connect('file:%s?mode=ro' % p, uri=True)
        n = c.execute('select count(*) from steps').fetchone()[0]
        refs = c.execute('select count(*) from parent_references').fetchone()[0]
        c.close()
        return {'steps': n, 'parent_references': refs}
    except Exception as e:
        return {'error': str(e)}


def history_tail():
    p = A + '/history.jsonl'
    if not os.path.exists(p):
        return []
    return [json.loads(l) for l in open(p).read().splitlines()[-3:] if l.strip()]


def snapshot(cid):
    return {'held': cid, 'row': rows().get(cid), 'db': db_steps(cid), 'transcript': transcript_lines(cid),
            'pbtxt': os.path.exists('%s/annotations/%s.pbtxt' % (A, cid)), 'history_tail': history_tail(),
            'last_conversations': open(A + '/cache/last_conversations.json').read() if os.path.exists(A + '/cache/last_conversations.json') else None}


def type_line(text):
    os.write(fd, text.encode())
    pump(0.4)
    os.write(fd, b'\r')


def watch_switch(before, label, seconds=8):
    t0 = time.time()
    first = None
    while time.time() - t0 < seconds:
        pump(0.05)
        now = held_lock()
        if now and now != before and first is None:
            first = snapshot(now)
            first['ms_after_enter'] = round((time.time() - t0) * 1000)
    later = snapshot(held_lock())
    return {'label': label, 'at_lock_swap': first, 'after_%ds' % seconds: later}


pump(10)
type_line('hello one')
pump(6)
type_line('hello two')
pump(6)
original = held_lock()
report = {'version': subprocess.run([BIN, '--version'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env).stdout.decode().strip(),
          'original': original, 'original_snapshot': snapshot(original)}
type_line('/fork')
report['fork'] = watch_switch(original, '/fork')
forked = held_lock()
report['original_after_fork'] = {'row': rows().get(original), 'db': db_steps(original), 'transcript': transcript_lines(original)}
type_line('hello three')
pump(6)
report['fork_after_a_turn'] = snapshot(forked)
type_line('/clear')
report['clear'] = watch_switch(forked, '/clear')
report['screen_has_forked_line'] = b'Forked conversation' in out
m = re.search(rb'Forked conversation[^\r\n]{0,120}', bytes(out))
report['forked_line'] = m and re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]', b'', m.group(0)).decode('utf-8', 'replace')
os.kill(pid, signal.SIGKILL)
print(json.dumps(report, indent=1, default=str))
