import glob
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else 'tool'
BASE = '/home/u/w/' + MODE
DATA = BASE + '/data'
CFG = BASE + '/cfg'
WS = BASE + '/ws'
PORT = 8787
for d in (DATA, CFG, WS):
    os.makedirs(d, exist_ok=True)
with open(WS + '/hello.txt', 'w') as f:
    f.write('hello from the workspace file\n')
LOG = open(BASE + '/requests.jsonl', 'a')
LOCK = threading.Lock()
STATE = {'n': 0}
CATALOG = {'object': 'list', 'data': [{'id': 'fake-model', 'object': 'model', 'owned_by': 'koloft'}]}


def rec(obj):
    with LOCK:
        LOG.write(json.dumps(obj) + '\n')
        LOG.flush()


def usage_for(n):
    return {
        'input_tokens': 1000 * n + 100,
        'output_tokens': 10 * n + 1,
        'total_tokens': 1010 * n + 101,
        'input_tokens_details': {'cached_tokens': 100 * n + 7},
        'output_tokens_details': {'reasoning_tokens': n},
    }


def decide(n, has_output, tool_names):
    if MODE == 'tool':
        if n == 1 and not has_output:
            name = 'muse.read_file' if 'muse.read_file' in tool_names else 'read_file'
            return {'type': 'function_call', 'name': name, 'call_id': 'call_%d' % n, 'id': 'fc_%d' % n,
                    'arguments': json.dumps({'path': 'hello.txt'})}
        return {'type': 'message', 'role': 'assistant', 'id': 'msg_%d' % n,
                'content': [{'type': 'output_text', 'text': 'fake model done %d' % n}]}
    if MODE == 'spawn':
        if n == 1 and not has_output:
            name = 'muse.subagent_spawn' if 'muse.subagent_spawn' in tool_names else 'subagent_spawn'
            return {'type': 'function_call', 'name': name, 'call_id': 'call_%d' % n, 'id': 'fc_%d' % n,
                    'arguments': json.dumps({'command_id': 'cmd-spawn-1', 'role': 'researcher',
                                             'objective': 'Say CHILD-HELLO and stop', 'task_name': 'koloft-child'})}
        return {'type': 'message', 'role': 'assistant', 'id': 'msg_%d' % n,
                'content': [{'type': 'output_text', 'text': 'CHILD-HELLO %d' % n if not has_output else 'parent done %d' % n}]}
    return {'type': 'message', 'role': 'assistant', 'id': 'msg_%d' % n,
            'content': [{'type': 'output_text', 'text': 'plain %d' % n}]}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        rec({'get': self.path})
        if self.path.startswith('/muse-code/models'):
            self._json(200, CATALOG)
        elif self.path.startswith('/muse-code/config'):
            self._json(200, {})
        else:
            self._json(404, {'error': {'message': 'no such path', 'type': 'invalid_request_error'}})

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
        inputs = req.get('input') if isinstance(req.get('input'), list) else []
        has_output = any(isinstance(i, dict) and i.get('type') == 'function_call_output' for i in inputs)
        tool_names = []
        sub_params = {}
        for t in (req.get('tools') or []):
            if not isinstance(t, dict):
                continue
            if t.get('type') == 'namespace':
                for s in (t.get('tools') or []):
                    if isinstance(s, dict):
                        tool_names.append('%s.%s' % (t.get('name'), s.get('name')))
                        if s.get('name') in ('subagent_spawn', 'read_file'):
                            sub_params[s.get('name')] = s.get('parameters')
            else:
                tool_names.append(t.get('name'))
        if n == 1:
            rec({'sub_params': json.dumps(sub_params)[:4000]})
        item = decide(n, has_output, tool_names)
        usage = usage_for(n)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('authorization', 'x-api-key')}
        rec({'n': n, 'path': self.path, 'model': req.get('model'), 'has_output': has_output,
             'tool_names': tool_names, 'item': item, 'usage': usage, 'headers': headers,
             'input_types': [i.get('type') if isinstance(i, dict) else str(type(i)) for i in inputs][-6:],
             'stream': req.get('stream')})
        if n == 1:
            rec({'tool_names': tool_names})
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        seq = {'i': 0}

        def send(t, d):
            d = dict(d)
            d['type'] = t
            d['sequence_number'] = seq['i']
            seq['i'] += 1
            self.wfile.write(('event: %s\ndata: %s\n\n' % (t, json.dumps(d))).encode())
            self.wfile.flush()

        rid = 'resp_%d' % n
        base = {'id': rid, 'object': 'response', 'created_at': 1792413000 + n, 'status': 'in_progress',
                'model': 'fake-model', 'output': []}
        send('response.created', {'response': dict(base)})
        send('response.in_progress', {'response': dict(base)})
        item0 = dict(item, status='in_progress')
        if item['type'] == 'function_call':
            args = item['arguments']
            item0['arguments'] = ''
            send('response.output_item.added', {'output_index': 0, 'item': item0})
            send('response.function_call_arguments.delta', {'item_id': item['id'], 'output_index': 0, 'delta': args})
            send('response.function_call_arguments.done', {'item_id': item['id'], 'output_index': 0, 'arguments': args})
            done_item = dict(item, status='completed')
        else:
            text = item['content'][0]['text']
            item0['content'] = []
            send('response.output_item.added', {'output_index': 0, 'item': item0})
            part = {'type': 'output_text', 'text': '', 'annotations': []}
            send('response.content_part.added', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'part': part})
            send('response.output_text.delta', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': text, 'logprobs': []})
            send('response.output_text.done', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'text': text, 'logprobs': []})
            part = {'type': 'output_text', 'text': text, 'annotations': []}
            send('response.content_part.done', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'part': part})
            done_item = dict(item, status='completed', content=[part])
        send('response.output_item.done', {'output_index': 0, 'item': done_item})
        final = dict(base, status='completed', output=[done_item], usage=usage)
        send('response.completed', {'response': final})


srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

env = dict(os.environ)
env.update({'META_API_KEY': 'FAKE', 'MUSE_MODEL': 'fake-model', 'XDG_DATA_HOME': DATA,
            'XDG_CONFIG_HOME': CFG, 'MUSE_NO_AUTO_UPDATE': '1', 'HOME': '/home/u'})
muse = '/home/u/.local/bin/muse'
ver = subprocess.run([muse, '--version'], capture_output=True, text=True, env=env)
print('VERSION', ver.stdout.strip(), ver.stderr.strip()[:200])
prompt = 'do ' + MODE
cmd = [muse, 'exec', '--base-url', 'http://127.0.0.1:%d' % PORT, '--approval-mode', 'never', '--trust-workspace',
       '--json', '--disable-reminders', prompt]
print('CMD', ' '.join(cmd))
try:
    r = subprocess.run(cmd, cwd=WS, capture_output=True, text=True, env=env, timeout=150)
    print('EXIT', r.returncode)
    with open(BASE + '/exec-stdout.jsonl', 'w') as f:
        f.write(r.stdout)
    with open(BASE + '/exec-stderr.txt', 'w') as f:
        f.write(r.stderr)
    print('STDERR', r.stderr[-1500:])
    print('STDOUT-TAIL', r.stdout[-800:])
except subprocess.TimeoutExpired as e:
    print('TIMEOUT', (e.stdout or b'')[-800:], (e.stderr or b'')[-800:])

print('REQUESTS', STATE['n'])
files = sorted(glob.glob(DATA + '/muse/sessions/**/session.jsonl', recursive=True))
print('SESSION FILES', json.dumps(files, indent=1))
for fpath in files:
    print('=== FILE', fpath)
    with open(fpath) as f:
        for i, line in enumerate(f):
            try:
                o = json.loads(line)
            except Exception:
                print(i, 'UNPARSED', line[:200])
                continue
            pt = o.get('payload_type')
            p = o.get('payload') if isinstance(o.get('payload'), dict) else {}
            kind = p.get('kind')
            ev = p.get('event') if isinstance(p.get('event'), dict) else {}
            ek = ev.get('kind')
            hit = ('tokens' in line) or ('fake-model' in line) or ('usage' in line.lower())
            print(i, pt, kind, ek, len(line), 'HIT' if hit else '')
            if hit:
                print('   LINE:', line[:2500].rstrip())
srv.shutdown()
