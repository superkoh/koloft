import glob
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else 'plain'
BASE = '/home/u/g/' + MODE
GDIR = BASE + '/gemini'
WS = BASE + '/ws'
PORT = 8788
for d in (GDIR + '/antigravity-cli', WS):
    os.makedirs(d, exist_ok=True)
with open(GDIR + '/antigravity-cli/settings.json', 'w') as f:
    f.write(json.dumps({'modelProvider': 'gemini'}))
with open(WS + '/hello.txt', 'w') as f:
    f.write('hello from the workspace file\n')
LOG = open(BASE + '/requests.jsonl', 'a')
LOCK = threading.Lock()
STATE = {'n': 0}


def rec(obj):
    with LOCK:
        LOG.write(json.dumps(obj) + '\n')
        LOG.flush()


def usage_for(n):
    return {'promptTokenCount': 1000 * n + 100, 'candidatesTokenCount': 10 * n + 1,
            'cachedContentTokenCount': 100 * n + 7, 'thoughtsTokenCount': 20 * n + 3,
            'totalTokenCount': 1130 * n + 111}


def decide(n, model, has_tools, has_fn_response):
    if MODE == 'tool' and has_tools and not has_fn_response:
        return {'functionCall': {'name': 'view_file', 'args': {
            'AbsolutePath': WS + '/hello.txt', 'StartLine': 0, 'EndLine': 5,
            'toolSummary': 'look at hello', 'toolAction': 'read hello.txt'}}}
    return {'text': 'fake reply %d from %s' % (n, model)}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except Exception:
            req = {}
        with LOCK:
            STATE['n'] += 1
            n = STATE['n']
        m = re.search(r'/models/([^:]+):', self.path)
        model = m.group(1) if m else '?'
        has_tools = bool(req.get('tools'))
        contents = req.get('contents') or []
        has_fn_response = any(
            isinstance(p, dict) and 'functionResponse' in p
            for c in contents if isinstance(c, dict)
            for p in (c.get('parts') or []))
        part = decide(n, model, has_tools, has_fn_response)
        usage = usage_for(n)
        version = 'fake-%s-v%d' % (model, n)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('authorization', 'x-goog-api-key')}
        rec({'n': n, 'path': self.path, 'model': model, 'has_tools': has_tools, 'has_fn_response': has_fn_response,
             'part': part, 'usage': usage, 'modelVersion': version, 'headers': headers,
             'tool_names': [d.get('name') for t in (req.get('tools') or []) if isinstance(t, dict)
                            for d in (t.get('functionDeclarations') or [])][:20],
             'thinking': (req.get('generationConfig') or {}).get('thinkingConfig')})
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        ev = {'candidates': [{'content': {'role': 'model', 'parts': [part]}, 'finishReason': 'STOP', 'index': 0}],
              'usageMetadata': usage, 'modelVersion': version, 'responseId': 'resp-%d' % n}
        self.wfile.write(('data: %s\n\n' % json.dumps(ev)).encode())
        self.wfile.flush()


srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

env = dict(os.environ)
env.update({'GEMINI_API_KEY': 'FAKE-KEY', 'GOOGLE_GEMINI_BASE_URL': 'http://127.0.0.1:%d' % PORT,
            'AGY_CLI_DISABLE_AUTO_UPDATE': 'true', 'HOME': '/home/u'})
agy = '/usr/local/bin/agy'
ver = subprocess.run([agy, '--version'], capture_output=True, text=True, env=env)
print('VERSION', ver.stdout.strip(), ver.stderr.strip()[:200])
cmd = [agy, '--gemini_dir=' + GDIR, '-p', 'do ' + MODE, '--output-format', 'json']
if MODE == 'model':
    cmd += ['--model', 'gemini-3.8-flash-high']
if MODE == 'tool':
    cmd += ['--dangerously-skip-permissions']
print('CMD', ' '.join(cmd))
try:
    r = subprocess.run(cmd, cwd=WS, capture_output=True, text=True, env=env, timeout=150)
    print('EXIT', r.returncode)
    with open(BASE + '/p-stdout.txt', 'w') as f:
        f.write(r.stdout)
    with open(BASE + '/p-stderr.txt', 'w') as f:
        f.write(r.stderr)
    print('STDOUT', r.stdout[-1500:])
    print('STDERR', r.stderr[-1500:])
except subprocess.TimeoutExpired as e:
    print('TIMEOUT', (e.stdout or b'')[-800:], (e.stderr or b'')[-800:])

print('REQUESTS', STATE['n'])
app = GDIR + '/antigravity-cli'
print('TREE')
for root, dirs, files in os.walk(GDIR):
    for name in files:
        p = os.path.join(root, name)
        try:
            print('  ', os.path.getsize(p), p[len(GDIR):])
        except OSError:
            pass

needles = ['fake-gemini', 'fake-reply', 'gemini-3', 'modelVersion', 'model_version']
print('GREP for', needles)
for root, dirs, files in os.walk(GDIR):
    for name in files:
        p = os.path.join(root, name)
        try:
            data = open(p, 'rb').read()
        except OSError:
            continue
        for nd in needles:
            cnt = data.count(nd.encode())
            if cnt:
                print('  ', p[len(GDIR):], nd, cnt)

for t in sorted(glob.glob(app + '/brain/*/.system_generated/logs/transcript*.jsonl')):
    print('=== TRANSCRIPT', t[len(GDIR):])
    with open(t) as f:
        for i, line in enumerate(f):
            try:
                o = json.loads(line)
            except Exception:
                print(i, 'UNPARSED', line[:200])
                continue
            keys = sorted(o.keys())
            print(i, o.get('type'), o.get('source'), o.get('status'), 'tokens:',
                  o.get('input_tokens'), o.get('output_tokens'), o.get('cache_read_tokens'),
                  'keys:', keys)
            if o.get('type') == 'PLANNER_RESPONSE':
                print('   LINE:', line[:1200].rstrip())

for db in sorted(glob.glob(app + '/conversations/*.db')):
    print('=== DB', db[len(GDIR):])
    con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
    cur = con.cursor()
    cur.execute("select name from sqlite_master where type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print('tables', tables)
    for tb in tables:
        cur.execute('select * from "%s"' % tb)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        print(' table', tb, 'cols', cols, 'rows', len(rows))
        for row in rows[:12]:
            shown = []
            for c, v in zip(cols, row):
                if isinstance(v, bytes):
                    hits = [nd for nd in needles if nd.encode() in v]
                    texts = re.findall(rb'[\x20-\x7e]{6,}', v)
                    short = [s.decode() for s in texts if any(k in s for k in (b'gemini-', b'fake-'))][:12]
                    ctx = []
                    for mm in re.finditer(rb'fake-|gemini-3\.[0-9]+-[a-z]+-(?:low|high|preview)', v):
                        a = max(0, mm.start() - 48)
                        ctx.append(repr(v[a:mm.end() + 40]))
                    shown.append('%s=<blob %d bytes hits=%s strings=%s ctx=%s>' % (c, len(v), hits, short, ctx[:8]))
                else:
                    shown.append('%s=%r' % (c, str(v)[:120]))
            print('   ', ' | '.join(shown))
    con.close()

sdb = app + '/conversation_summaries.db'
if os.path.exists(sdb):
    print('=== SUMMARIES DB')
    con = sqlite3.connect('file:' + sdb + '?mode=ro', uri=True)
    cur = con.cursor()
    cur.execute("select name from sqlite_master where type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print('tables', tables)
    for tb in tables:
        cur.execute('select * from "%s"' % tb)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        print(' table', tb, 'cols', cols, 'rows', len(rows))
        for row in rows[:6]:
            shown = []
            for c, v in zip(cols, row):
                if isinstance(v, bytes):
                    texts = re.findall(rb'[\x20-\x7e]{6,}', v)
                    shown.append('%s=<blob %d strings=%s>' % (c, len(v), [s.decode() for s in texts][:16]))
                else:
                    shown.append('%s=%r' % (c, str(v)[:100]))
            print('   ', ' | '.join(shown))
    con.close()
srv.shutdown()
