import fcntl, glob, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, threading, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CASE = json.loads(sys.argv[1])
H = os.path.expanduser('~')
G = H + '/g'
WS = H + '/ws'
shutil.rmtree(G, ignore_errors=True)
shutil.rmtree(WS, ignore_errors=True)
os.makedirs(G + '/antigravity-cli/cache')
os.makedirs(WS)
with open(G + '/antigravity-cli/settings.json', 'w') as f:
    json.dump({'modelProvider': 'gemini', 'trustedWorkspaces': [WS]}, f)
with open(G + '/antigravity-cli/cache/onboarding.json', 'w') as f:
    json.dump({'onboardingComplete': True, 'consumerOnboardingComplete': True}, f)
for path, text in CASE.get('files', {}).items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
LOG = []
state = {'called': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        body = json.loads(raw or b'{}')
        decls = []
        for t in body.get('tools') or []:
            decls += t.get('functionDeclarations') or []
        names = [d.get('name') for d in decls]
        if CASE.get('schema'):
            for d in decls:
                if d.get('name') == CASE['tool']:
                    LOG.append({'schema': d.get('parameters') or d.get('parametersJsonSchema')})
        contents = body.get('contents') or []
        responded = any('functionResponse' in p for c in contents for p in c.get('parts') or [])
        if not decls:
            part = {'text': 'probe title'}
        elif responded:
            last = [p['functionResponse'] for c in contents for p in c.get('parts') or [] if 'functionResponse' in p][-1]
            LOG.append({'function_response': json.dumps(last)[:400]})
            part = {'text': 'done'}
        else:
            state['called'] += 1
            LOG.append({'tools': names})
            part = {'functionCall': {'name': CASE['tool'], 'args': CASE['args']}}
        data = {'candidates': [{'content': {'role': 'model', 'parts': [part]}, 'finishReason': 'STOP'}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}
        out = ('data: %s\n\n' % json.dumps(data)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', 8788), Handler).serve_forever, daemon=True).start()

TOKEN = 'probetoken'
env = dict(os.environ, TERM='xterm-256color', LANG='C.UTF-8', GEMINI_API_KEY='made-up', GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:8788', PWD=WS)
BIN = CASE.get('bin', '/home/u/agy153/antigravity')
argv = [BIN, '--gemini_dir=' + G, '--csrf_token=' + TOKEN] + CASE.get('flags', [])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.execvpe(BIN, argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))

ANSWERS = [
    (b'\x1b]7501;?', b'\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'),
    (b'\x1b[6n', b'\x1b[1;1R'),
    (b'\x1b[c', b'\x1b[?62;22c'),
    (b'\x1b[>q', b'\x1bP>|xterm.js(5.5.0)\x1b\\'),
    (b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'),
    (b'\x1b[?u', b'\x1b[?0u'),
]


def api_ports():
    inodes = set()
    for p in glob.glob('/proc/%d/fd/*' % pid):
        try:
            link = os.readlink(p)
        except OSError:
            continue
        m = re.match(r'socket:\[(\d+)\]', link)
        if m:
            inodes.add(m.group(1))
    ports = []
    for line in open('/proc/net/tcp').read().splitlines()[1:]:
        cols = line.split()
        if cols[3] == '0A' and cols[9] in inodes:
            ports.append(int(cols[1].split(':')[1], 16))
    return ports


def call(port, method, body):
    req = urllib.request.Request('http://127.0.0.1:%d/exa.language_server_pb.LanguageServerService/%s' % (port, method),
                                 data=json.dumps(body).encode(), headers={'content-type': 'application/json', 'x-codeium-csrf-token': TOKEN})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())


def waiting_step():
    ids = [os.path.basename(p)[:-3] for p in glob.glob(G + '/antigravity-cli/conversations/*.db')]
    if not ids:
        return {'error': 'no conversation'}
    for port in api_ports():
        try:
            t = call(port, 'GetCascadeTrajectory', {'cascadeId': ids[0]})
        except Exception as e:
            continue
        steps = (t.get('trajectory') or t).get('steps') or []
        last = steps[-1] if steps else {}
        return {'status': last.get('status'), 'type': last.get('type'), 'requestedInteraction': last.get('requestedInteraction')}
    return {'error': 'no api port answered'}


out = bytearray()
frames = []
pending = None
t0 = time.time()
seen = 0
while time.time() - t0 < float(CASE.get('wait', 30)):
    r, _, _ = select.select([fd], [], [], 0.05)
    if fd in r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        for q, a in ANSWERS:
            if q in chunk:
                os.write(fd, a)
        for m in re.finditer(rb'\x1b\[\?(\d+)\$p', chunk):
            os.write(fd, b'\x1b[?' + m.group(1) + b';2$y')
    for m in re.finditer(rb'\x1b\]7501;(state=[^\x07\x1b]*)', bytes(out[seen:])):
        f = m.group(1).decode('utf-8', 'replace')
        if not frames or frames[-1][1] != f:
            frames.append([round(time.time() - t0, 2), f])
    seen = max(seen, len(out) - 300)
    if not state.get('typed') and any(f[1].startswith('state=idle') for f in frames):
        state['typed'] = True
        time.sleep(1.0)
        os.write(fd, b'go')
        time.sleep(0.4)
        os.write(fd, b'\r')
        continue
    if pending is None and any('blocked' in f[1] and 'Trust' not in f[1] and 'setup' not in f[1] for f in frames):
        time.sleep(1.5)
        pending = waiting_step()
        screen = re.sub(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>78DEHM])', b'', bytes(out)).decode('utf-8', 'replace')
        os.write(fd, CASE.get('key', '\x1b').encode())
        if CASE.get('key'):
            time.sleep(3)
            screen = re.sub(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>78DEHM])', b'', bytes(out)).decode('utf-8', 'replace')
            break
    if pending is not None and frames[-1][1].startswith(('state=done', 'state=idle')):
        break
if pending is None:
    screen = re.sub(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>78DEHM])', b'', bytes(out)).decode('utf-8', 'replace')
os.kill(pid, signal.SIGKILL)
version = subprocess.run([BIN, '--version'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env).stdout.decode().strip()
print(json.dumps({'version': version, 'case': CASE, 'frames': frames, 'pending': pending, 'log': LOG,
                  'screen_tail': re.sub(r'─+', '---', screen)[-900:]}, indent=1))
