import json, os, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

H = os.path.expanduser('~')
LOGIN_SHELL = sys.argv[1]
OUT = H + '/cc-result-' + os.path.basename(LOGIN_SHELL) + '.json'
CMD = 'command -v rconly-tool || echo NOT-FOUND; echo "PATH=$PATH"'
seen = {'requests': [], 'tool_result': None}


def sse(events):
    return b''.join(('event: %s\ndata: %s\n\n' % (e['type'], json.dumps(e))).encode() for e in events)


def message(blocks, stop):
    start = {'type': 'message_start', 'message': {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-4-5',
             'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}}
    ev = [start]
    for i, b in enumerate(blocks):
        if b['type'] == 'text':
            ev.append({'type': 'content_block_start', 'index': i, 'content_block': {'type': 'text', 'text': ''}})
            ev.append({'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': b['text']}})
        else:
            ev.append({'type': 'content_block_start', 'index': i, 'content_block': {'type': 'tool_use', 'id': b['id'], 'name': b['name'], 'input': {}}})
            ev.append({'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])}})
        ev.append({'type': 'content_block_stop', 'index': i})
    ev.append({'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 5}})
    ev.append({'type': 'message_stop'})
    return sse(ev)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        body = json.loads(raw or b'{}')
        tools = [t.get('name') for t in body.get('tools') or []]
        msgs = body.get('messages') or []
        seen['requests'].append({'path': self.path, 'tools': len(tools)})
        last = msgs[-1] if msgs else {}
        content = last.get('content')
        results = [c for c in content if isinstance(c, dict) and c.get('type') == 'tool_result'] if isinstance(content, list) else []
        if results:
            seen['tool_result'] = results[-1].get('content')
            out = message([{'type': 'text', 'text': 'done'}], 'end_turn')
        elif 'Bash' in tools:
            out = message([{'type': 'tool_use', 'id': 'toolu_1', 'name': 'Bash', 'input': {'command': CMD, 'description': 'probe'}}], 'tool_use')
        else:
            out = message([{'type': 'text', 'text': 'probe'}], 'end_turn')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


srv = ThreadingHTTPServer(('127.0.0.1', 8787), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

FIXED = ':'.join([H + '/.local/bin', H + '/.koloft/node/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/games'])
if os.environ.get('APPEND'):
    FIXED += ':' + os.environ['APPEND']
settings = {'hooks': {'SessionStart': [{'hooks': [{'type': 'command', 'command': 'command -v rconly-tool > "$HOME/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt" 2>&1 || echo NOT-FOUND >> "$HOME/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt"'}]}]}}
with open(H + '/cc-settings.json', 'w') as f:
    json.dump(settings, f)
env = {'HOME': H, 'USER': 'u', 'LOGNAME': 'u', 'SHELL': LOGIN_SHELL, 'PATH': FIXED, 'LANG': 'C.UTF-8', 'TERM': 'xterm-256color',
       'ANTHROPIC_BASE_URL': 'http://127.0.0.1:8787', 'ANTHROPIC_API_KEY': 'sk-ant-api03-fake-probe-key',
       'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1'}
os.makedirs(H + '/proj', exist_ok=True)
if os.path.exists(H + '/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt'):
    os.remove(H + '/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt')
INTERACTIVE = len(sys.argv) > 2 and sys.argv[2] == 'interactive'
if INTERACTIVE:
    import pty, select, signal, struct, fcntl, termios, time
    settings['apiKeyHelper'] = 'echo sk-ant-api03-fake-probe-key'
    with open(H + '/cc-settings.json', 'w') as f:
        json.dump(settings, f)
    env.pop('ANTHROPIC_API_KEY')
    with open(H + '/.claude.json', 'w') as f:
        json.dump({'hasCompletedOnboarding': True, 'bypassPermissionsModeAccepted': True,
                   'projects': {H + '/proj': {'hasTrustDialogAccepted': True}}}, f)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(H + '/proj')
        os.execve(H + '/claude', [H + '/claude', '--settings', H + '/cc-settings.json', '--dangerously-skip-permissions'], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    buf = bytearray()
    t0 = time.time()
    typed = False
    while time.time() - t0 < 60 and seen['tool_result'] is None:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            buf += chunk
            if b'\x1b[6n' in chunk:
                os.write(fd, b'\x1b[1;1R')
            if b'\x1b[c' in chunk:
                os.write(fd, b'\x1b[?62;22c')
        if not typed and time.time() - t0 > 8:
            typed = True
            os.write(fd, b'go')
            time.sleep(0.5)
            os.write(fd, b'\r')
    time.sleep(2)
    os.kill(pid, signal.SIGKILL)

    class P:
        returncode = 'killed after the tool ran' if seen['tool_result'] is not None else 'killed, no tool result'
        stdout = bytes(buf[-600:])
    p = P()
else:
    p = subprocess.run([H + '/claude', '-p', 'go', '--settings', H + '/cc-settings.json', '--dangerously-skip-permissions'],
                       cwd=H + '/proj', env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
snaps = os.listdir(H + '/.claude/shell-snapshots') if os.path.isdir(H + '/.claude/shell-snapshots') else []
snap_path_lines = []
for s in snaps:
    snap_path_lines += [l[:300] for l in open(H + '/.claude/shell-snapshots/' + s, errors='replace').read().splitlines() if 'PATH' in l]
version = subprocess.run([H + '/claude', '--version'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout.decode().strip()
hook = open(H + '/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt').read() if os.path.exists(H + '/cc-hook-' + os.path.basename(LOGIN_SHELL) + '.txt') else None
result = {'version': version, 'login_shell': LOGIN_SHELL, 'path_handed_to_claude': FIXED, 'exit': p.returncode,
          'stdout_tail': p.stdout.decode('utf-8', 'replace')[-600:], 'bash_tool_result': seen['tool_result'],
          'session_start_hook_saw': hook, 'requests': seen['requests'], 'snapshots': snaps, 'snapshot_path_lines': snap_path_lines}
print(json.dumps(result, indent=1))
