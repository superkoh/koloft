import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[2] if len(sys.argv) > 2 else '/tmp/fake-model.log'
CMD_FILE = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~/kit/fake-cmd.txt')
MODEL = 'fake-model'


def log(*parts):
    with open(LOG, 'a') as f:
        f.write(' '.join(str(p) for p in parts) + '\n')


def sse(handler, events):
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/event-stream')
    handler.send_header('Cache-Control', 'no-cache')
    handler.end_headers()
    for ev in events:
        handler.wfile.write(('event: %s\ndata: %s\n\n' % (ev['type'], json.dumps(ev))).encode())
        handler.wfile.flush()
        time.sleep(0.02)


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


class H(BaseHTTPRequestHandler):
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
        log('GET', self.path)
        if self.path.startswith('/muse-code/models'):
            return self.reply(200, {'object': 'list', 'data': [{'id': MODEL, 'object': 'model', 'name': MODEL, 'display_name': MODEL, 'context_window': 200000, 'max_output_tokens': 8192}]})
        if self.path.startswith('/muse-code/config'):
            return self.reply(200, {})
        self.reply(404, {'error': {'message': 'not found'}})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n)
        log('POST', self.path, raw[:600].decode('utf-8', 'replace'))
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        inputs = body.get('input') or []
        outputs = [i for i in inputs if isinstance(i, dict) and i.get('type') == 'function_call_output']
        tools = []
        for t in body.get('tools') or []:
            if isinstance(t, dict):
                tools += [s.get('name') for s in t.get('tools') or [] if isinstance(s, dict)] + [t.get('name')]
        log('TOOLS', json.dumps(tools)[:600])
        if 'bash' not in tools:
            item = {'type': 'message', 'id': 'msg_side', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'none', 'annotations': []}]}
        elif outputs:
            log('TOOL_OUTPUT', json.dumps(outputs[-1])[:1500])
            item = {'type': 'message', 'id': 'msg_%d' % len(outputs), 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': 'fake model saw the tool output', 'annotations': []}]}
        else:
            with open(CMD_FILE) as f:
                cmd = f.read().strip()
            args = {'command': cmd}
            if cmd.startswith('ESCALATE '):
                args = {'command': cmd[len('ESCALATE '):], 'sandbox_permissions': 'require_escalated'}
            item = {'type': 'function_call', 'id': 'fc_1', 'call_id': 'call_1', 'name': 'bash', 'arguments': json.dumps(args), 'status': 'completed'}
        sse(self, response_events(item))


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8787), H).serve_forever()
