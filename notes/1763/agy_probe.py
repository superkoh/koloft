import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

H = os.path.expanduser('~')
LOGIN_SHELL = sys.argv[1]
BIN = sys.argv[2]
G = H + '/g'
WS = H + '/ws'
shutil.rmtree(G, ignore_errors=True)
os.makedirs(G + '/antigravity-cli/cache')
os.makedirs(WS, exist_ok=True)
with open(G + '/antigravity-cli/settings.json', 'w') as f:
    json.dump({'modelProvider': 'gemini', 'trustedWorkspaces': [WS]}, f)
with open(G + '/antigravity-cli/cache/onboarding.json', 'w') as f:
    json.dump({'onboardingComplete': True, 'consumerOnboardingComplete': True}, f)
CMD = 'command -v rconly-tool || echo NOT-FOUND; echo "PATH=$PATH"; echo "SHELL=$SHELL"; ps -o comm= -p $$'
state = {'response': None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        body = json.loads(raw or b'{}')
        decls = []
        for t in body.get('tools') or []:
            decls += t.get('functionDeclarations') or []
        contents = body.get('contents') or []
        responses = [p['functionResponse'] for c in contents for p in c.get('parts') or [] if 'functionResponse' in p]
        if not decls:
            part = {'text': 'probe title'}
        elif responses:
            state['response'] = responses[-1]
            part = {'text': 'done'}
        else:
            part = {'functionCall': {'name': 'run_command', 'args': {'CommandLine': CMD, 'WaitMsBeforeAsync': 5000, 'toolSummary': 'probe'}}}
        data = {'candidates': [{'content': {'role': 'model', 'parts': [part]}, 'finishReason': 'STOP'}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'totalTokenCount': 15}}
        out = ('data: %s\n\n' % json.dumps(data)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', 8788), Handler).serve_forever, daemon=True).start()

FIXED = ':'.join([H + '/.local/bin', H + '/.koloft/node/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/games'])
if os.environ.get('APPEND'):
    FIXED += ':' + os.environ['APPEND']
env = {'HOME': H, 'USER': 'u', 'LOGNAME': 'u', 'SHELL': LOGIN_SHELL, 'PATH': FIXED, 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
       'GEMINI_API_KEY': 'made-up', 'GOOGLE_GEMINI_BASE_URL': 'http://127.0.0.1:8788', 'PWD': WS}
argv = [BIN, '--gemini_dir=' + G, '--dangerously-skip-permissions']
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WS)
    os.execve(BIN, argv, env)
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
t0 = time.time()
typed = False
done_at = None
while time.time() - t0 < 60:
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
    if not typed and (b'state=idle' in out or time.time() - t0 > 12):
        typed = True
        time.sleep(1.0)
        os.write(fd, b'go')
        time.sleep(0.4)
        os.write(fd, b'\r')
    if state['response'] is not None and done_at is None:
        done_at = time.time()
    if done_at and time.time() - done_at > 2:
        break
os.kill(pid, signal.SIGKILL)
version = subprocess.run([BIN, '--version'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env).stdout.decode().strip()
print(json.dumps({'version': version, 'login_shell': LOGIN_SHELL, 'path_handed_to_agy': FIXED,
                  'run_command_result': state['response'],
                  'screen_tail': out.decode('utf-8', 'replace')[-400:] if state['response'] is None else None}, indent=1))
