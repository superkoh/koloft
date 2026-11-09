import glob, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, threading, time, fcntl, termios
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CASE = json.loads(sys.argv[1])
TOOL = CASE['tool']
ARGS = CASE['args']
FLAGS = CASE.get('flags', ['--approval-judge', 'off', '--sandbox-network', 'enabled'])
WAIT = float(CASE.get('wait', 20))
H = os.path.expanduser('~')
RUN = H + '/run'
shutil.rmtree(RUN, ignore_errors=True)
os.makedirs(RUN + '/ws')
os.makedirs(RUN + '/config')
os.makedirs(RUN + '/data')
for path, text in CASE.get('files', {}).items():
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        f.write(text)
LOG = []
MODEL = 'fake-model'
calls = {'n': 0}


def sse(handler, events):
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream')
    handler.end_headers()
    for ev in events:
        handler.wfile.write(('event: %s\ndata: %s\n\n' % (ev['type'], json.dumps(ev))).encode())
        handler.wfile.flush()


def response_events(item):
    rid = 'resp_%d' % int(time.time() * 1000)
    base = {'id': rid, 'object': 'response', 'created_at': int(time.time()), 'model': MODEL, 'status': 'in_progress', 'output': []}
    done = dict(base, status='completed', output=[item], usage={'input_tokens': 10, 'output_tokens': 10, 'total_tokens': 20, 'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}})
    events = [{'type': 'response.created', 'sequence_number': 0, 'response': base},
              {'type': 'response.output_item.added', 'sequence_number': 1, 'output_index': 0, 'item': dict(item, status='in_progress')}]
    if item['type'] == 'message':
        text = item['content'][0]['text']
        events.append({'type': 'response.output_text.delta', 'sequence_number': 2, 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': text})
        events.append({'type': 'response.output_text.done', 'sequence_number': 3, 'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'text': text})
    else:
        events.append({'type': 'response.function_call_arguments.delta', 'sequence_number': 2, 'item_id': item['id'], 'output_index': 0, 'delta': item['arguments']})
        events.append({'type': 'response.function_call_arguments.done', 'sequence_number': 3, 'item_id': item['id'], 'output_index': 0, 'arguments': item['arguments']})
    events.append({'type': 'response.output_item.done', 'sequence_number': 4, 'output_index': 0, 'item': item})
    events.append({'type': 'response.completed', 'sequence_number': 5, 'response': done})
    return events


def message(text):
    return {'type': 'message', 'id': 'msg_%d' % time.time_ns(), 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/muse-code/models'):
            return self.reply(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'name': MODEL, 'display_name': MODEL, 'context_window': 200000, 'max_output_tokens': 8192}]})
        if self.path.startswith('/muse-code/config'):
            return self.reply(200, {})
        self.reply(404, {'error': {'message': 'not found'}})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        tools = []
        for t in body.get('tools') or []:
            if isinstance(t, dict):
                tools.append(t)
                tools += [s for s in t.get('tools') or [] if isinstance(s, dict)]
        names = [t.get('name') for t in tools]
        if CASE.get('dump') and 'bash' in names:
            with open(RUN + '/tools.json', 'w') as f:
                json.dump(tools, f, indent=1)
        outputs = [i for i in (body.get('input') or []) if isinstance(i, dict) and i.get('type') == 'function_call_output']
        if 'bash' not in names:
            item = message('none')
        elif outputs:
            LOG.append({'tool_output': outputs[-1].get('output', '')[:400] if isinstance(outputs[-1].get('output'), str) else outputs[-1].get('output')})
            item = message('fake model saw the tool output')
        else:
            calls['n'] += 1
            item = {'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1', 'name': TOOL, 'arguments': json.dumps(ARGS), 'status': 'completed'}
        sse(self, response_events(item))


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', 8787), Handler).serve_forever, daemon=True).start()

env = dict(os.environ, TERM='xterm-256color', LANG='C.UTF-8', MUSE_NO_AUTO_UPDATE='1', META_API_KEY='made-up', MUSE_MODEL=MODEL,
           XDG_CONFIG_HOME=RUN + '/config', XDG_DATA_HOME=RUN + '/data')
argv = ['muse', '--base-url', 'http://127.0.0.1:8787', '--trust-workspace'] + FLAGS + ['go']
pid, fd = pty.fork()
if pid == 0:
    os.chdir(RUN + '/ws')
    os.execvpe('muse', argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))

ANSWERS = [
    (b'\x1b]7501;?', b'\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'),
    (b'\x1b[6n', b'\x1b[1;1R'),
    (b'\x1b[c', b'\x1b[?62;22c'),
    (b'\x1b[>c', b'\x1b[>0;276;0c'),
    (b'\x1b]10;?', b'\x1b]10;rgb:ffff/ffff/ffff\x1b\\'),
    (b'\x1b]11;?', b'\x1b]11;rgb:0000/0000/0000\x1b\\'),
]
out = bytearray()
frames = []
pending = None
t0 = time.time()
seen = 0


def serve_list_pending():
    sid = None
    for p in glob.glob(RUN + '/data/muse/runtime/muse/sessions/*.json'):
        sid = os.path.basename(p)[:-5]
    if not sid:
        return {'error': 'no session id'}
    p = subprocess.Popen(['muse', 'serve', '--provider', 'echo'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)

    def send(obj):
        p.stdin.write((json.dumps(obj) + '\n').encode())
        p.stdin.flush()

    def wait(i):
        while True:
            line = p.stdout.readline()
            if not line:
                return None
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get('id') == i:
                return msg

    send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'probe', 'version': '1'}}})
    wait(1)
    send({'jsonrpc': '2.0', 'method': 'initialized'})
    send({'jsonrpc': '2.0', 'id': 2, 'method': 'approval/listPending', 'params': {'sessionId': sid}})
    r = wait(2)
    p.kill()
    return {'sessionId': sid, 'reply': r}


while time.time() - t0 < WAIT:
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
    for m in re.finditer(rb'\x1b\]7501;(state=[^\x07\x1b]*)', bytes(out[seen:])):
        frames.append([round(time.time() - t0, 2), m.group(1).decode()])
    seen = max(seen, len(out) - 64)
    frames = [f for i, f in enumerate(frames) if f not in frames[:i]]
    if pending is None and any('blocked' in f[1] for f in frames):
        time.sleep(1.0)
        pending = serve_list_pending()
        os.write(fd, b'\x1b')
    if pending is not None and any(f[1].startswith('state=done') for f in frames):
        break

text = re.sub(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>78DEHM])', b'', bytes(out)).decode('utf-8', 'replace')
os.kill(pid, signal.SIGKILL)
version = subprocess.run(['muse', '--version'], stdout=subprocess.PIPE, env=env).stdout.decode().strip()
print(json.dumps({'version': version, 'case': CASE, 'model_calls': calls['n'], 'frames': frames, 'listPending': pending, 'log': LOG,
                  'screen_tail': text[-1500:] if CASE.get('screen') else None}, indent=1))
