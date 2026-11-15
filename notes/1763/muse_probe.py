import json, os, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

H = os.path.expanduser('~')
LOGIN_SHELL = sys.argv[1]
MODEL = 'fake-model'
CMD = 'command -v rconly-tool || echo NOT-FOUND; echo "PATH=$PATH"; echo "SHELL=$SHELL"'
S = {'result': None, 'tools': None}


def response_events(item):
    rid = 'resp_%d' % time.time_ns()
    base = {'id': rid, 'object': 'response', 'created_at': int(time.time()), 'model': MODEL, 'status': 'in_progress', 'output': []}
    done = dict(base, status='completed', output=[item], usage={'input_tokens': 10, 'output_tokens': 10, 'total_tokens': 20,
                'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}})
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
    return {'type': 'message', 'id': 'msg_%d' % time.time_ns(), 'role': 'assistant', 'status': 'completed',
            'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}


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

    def sse(self, events):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for ev in events:
            self.wfile.write(('event: %s\ndata: %s\n\n' % (ev['type'], json.dumps(ev))).encode())
            self.wfile.flush()

    def do_GET(self):
        if self.path.startswith('/muse-code/models'):
            return self.reply(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'name': MODEL, 'display_name': MODEL,
                                                                 'context_window': 200000, 'max_output_tokens': 8192}]})
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
        inp = [i for i in (body.get('input') or []) if isinstance(i, dict)]
        if 'bash' not in names:
            return self.sse(response_events(message('none')))
        S['tools'] = names
        outs = [i for i in inp if i.get('type') == 'function_call_output' and i.get('call_id') == 'call_b1']
        if outs:
            S['result'] = outs[-1].get('output')
            return self.sse(response_events(message('done')))
        item = {'type': 'function_call', 'id': 'fc_b1', 'call_id': 'call_b1', 'name': 'bash',
                'arguments': json.dumps({'command': CMD}), 'status': 'completed'}
        self.sse(response_events(item))


threading.Thread(target=ThreadingHTTPServer(('127.0.0.1', 8787), Handler).serve_forever, daemon=True).start()

run_dir = H + '/run'
shutil.rmtree(run_dir, ignore_errors=True)
for d in ('ws', 'config', 'data'):
    os.makedirs(run_dir + '/' + d)
FIXED = ':'.join([H + '/.local/bin', H + '/.koloft/node/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/games'])
if os.environ.get('APPEND'):
    FIXED += ':' + os.environ['APPEND']
env = {'HOME': H, 'USER': 'u', 'LOGNAME': 'u', 'SHELL': LOGIN_SHELL, 'PATH': FIXED, 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
       'MUSE_NO_AUTO_UPDATE': '1', 'META_API_KEY': 'FAKE', 'MUSE_MODEL': MODEL,
       'XDG_CONFIG_HOME': run_dir + '/config', 'XDG_DATA_HOME': run_dir + '/data'}
argv = [H + '/.local/bin/muse', 'exec', '--base-url', 'http://127.0.0.1:8787', '--approval-mode', 'never', '--disable-sandbox',
        '--trust-workspace', '--approval-judge', 'off', 'go']
p = subprocess.run(argv, cwd=run_dir + '/ws', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
version = subprocess.run([H + '/.local/bin/muse', '--version'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode().strip()
print(json.dumps({'version': version, 'login_shell': LOGIN_SHELL, 'path_handed_to_muse': FIXED, 'exit': p.returncode,
                  'bash_tool_result': S['result'], 'stdout_tail': p.stdout.decode('utf-8', 'replace')[-500:]}, indent=1))
