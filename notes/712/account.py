import json, os, select, subprocess, sys, time

H = os.path.expanduser('~')
A = H + '/.koloft/muse-homes/acct'
env = dict(os.environ, XDG_CONFIG_HOME=A)
if sys.argv[1:] == ['file']:
    env['TBH_CREDENTIAL_BACKEND'] = 'file'
else:
    env.pop('TBH_CREDENTIAL_BACKEND', None)
p = subprocess.Popen([H + '/.local/bin/muse', 'serve'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)


def send(obj):
    p.stdin.write((json.dumps(obj) + '\n').encode())
    p.stdin.flush()


def wait_for(want, seconds):
    end = time.time() + seconds
    buf = b''
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], 0.2)
        if not r:
            continue
        chunk = os.read(p.stdout.fileno(), 65536)
        if not chunk:
            return 'eof'
        buf += chunk
        for line in buf.split(b'\n'):
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get('id') == want:
                return msg
    return 'timeout'


t0 = time.time()
send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'probe', 'version': '1'}, 'capabilities': {'experimentalApi': True}}})
init = wait_for(1, 20)
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
send({'jsonrpc': '2.0', 'id': 2, 'method': 'account/read', 'params': {}})
acct = wait_for(2, 20)
took = time.time() - t0
p.kill()
err = p.stderr.read().decode('utf-8', 'replace')[-800:]
auth = A + '/muse/auth.json'
print(json.dumps({
    'backend': sys.argv[1:],
    'initialize_ok': isinstance(init, dict) and 'result' in init,
    'account_read': acct.get('result', acct.get('error')) if isinstance(acct, dict) else acct,
    'seconds': round(took, 2),
    'auth_json_mode': oct(os.stat(auth).st_mode & 0o777) if os.path.exists(auth) else None,
    'carried_file_left': os.path.exists(H + '/.koloft/tabs/tab1.auth.json'),
    'stderr_tail': err,
}, indent=1))
