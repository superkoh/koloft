import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, time

H = os.path.expanduser('~')
M = H + '/.koloft/mac1'
TAB = H + '/.koloft/tabs/tab1.sh'
MIRROR = H + '/.koloft/hook-sessions/tab1.muse.jsonl'
PROMPT_AT = float(os.environ.get('PROMPT_AT', '10'))
END_AT = float(os.environ.get('END_AT', '25'))

KIT = os.environ.get('KIT', '/kit')
os.makedirs(M + '/docs-plugin/skills/koloft-docs', exist_ok=True)
os.makedirs(H + '/.koloft/tabs', exist_ok=True)
os.makedirs(H + '/w', exist_ok=True)
for name in ('muse-wrap.py', 'tmux.conf', 'muse-hook.sh'):
    shutil.copy(KIT + '/' + name, M + '/' + name)
shutil.copy(KIT + '/tab1.hooks.json', H + '/.koloft/tabs/tab1.hooks.json')
if os.path.exists(KIT + '/tab1.env'):
    shutil.copy(KIT + '/tab1.env', H + '/.koloft/tabs/tab1.env')
if os.path.exists(KIT + '/carry-auth.json'):
    shutil.copy(KIT + '/carry-auth.json', H + '/.koloft/tabs/tab1.auth.json')
if os.path.exists(MIRROR):
    os.remove(MIRROR)
with open(M + '/ensure.sh', 'w') as f:
    f.write('exit 0\n')
with open(M + '/docs-plugin/skills/koloft-docs/SKILL.md', 'w') as f:
    f.write('---\nname: koloft-docs\ndescription: probe\n---\nprobe\n')
shutil.copy(KIT + '/tab1.sh', TAB)
if os.path.exists(KIT + '/koloft'):
    os.makedirs(M + '/bin', exist_ok=True)
    shutil.copy(KIT + '/koloft', M + '/bin/koloft')
    os.chmod(M + '/bin/koloft', 0o755)
HOOKS = H + '/.koloft/hook-sessions'
answered = []


def answer_requests():
    try:
        names = os.listdir(HOOKS)
    except OSError:
        return
    for name in names:
        if name.startswith('req-') and name.endswith('.json') and name not in answered:
            answered.append(name)
            with open(os.path.join(HOOKS, name)) as f:
                answered.append(f.read().strip())
            with open(os.path.join(HOOKS, 'res-' + name[4:]), 'w') as f:
                f.write('{"exit":0,"text":"pong from the stand-in for Koloft"}')

env = dict(os.environ, TERM='xterm-256color', LANG=os.environ.get('DRIVE_LANG', 'C.UTF-8'))
env.pop('TMUX', None)


def tmux(*args):
    p = subprocess.run(['tmux', '-L', 'koloft'] + list(args), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode('utf-8', 'replace')


def client(mode, seconds, keys=()):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe('sh', ['sh', TAB, mode], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    out = bytearray()
    t0 = time.time()
    keys = list(keys)
    while time.time() - t0 < seconds:
        answer_requests()
        while keys and time.time() - t0 >= keys[0][0]:
            os.write(fd, keys.pop(0)[1])
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    return pid, fd, bytes(out), time.time() - t0


version = subprocess.run(['tmux', '-V'], stdout=subprocess.PIPE).stdout.decode().strip()
KEYS = [(PROMPT_AT, b'hello probe'), (PROMPT_AT + 1.5, b'\r')]
if os.environ.get('KEYS_FILE'):
    with open(os.environ['KEYS_FILE']) as f:
        KEYS = [(t, k.encode()) for t, k in json.load(f)]
pid, fd, out, took = client('start', END_AT, KEYS)
time.sleep(1.5)
result = {'tmux': version, 'python': sys.version.split()[0]}
result['sessions'] = tmux('list-sessions', '-F', '#{session_name}')
pane = tmux('list-panes', '-a', '-F', '#{session_name} #{pane_in_mode} #{pane_current_command}')
result['panes'] = pane
result['screen'] = tmux('capture-pane', '-p', '-t', result['sessions'][1].split('\n')[0] if result['sessions'][0] == 0 else 'k-tab1')
result['options'] = [tmux('show-options', '-gv', o) for o in ('allow-passthrough', 'set-titles', 'set-titles-string', 'set-clipboard', 'prefix', 'default-terminal', 'exit-empty')]
result['outer_7501'] = [m.decode('latin1') for m in re.findall(rb'\x1b\]7501;[^\x07\x1b]*', out)]
result['outer_dcs_tmux'] = out.count(b'\x1bPtmux;')
result['outer_titles'] = [m.decode('latin1') for m in re.findall(rb'\x1b\][02];[^\x07\x1b]*', out)][:6]
result['outer_bytes'] = len(out)
result['answered'] = answered
try:
    result['hook_dir'] = sorted(os.listdir(HOOKS))
except OSError as e:
    result['hook_dir'] = str(e)
result['outer_text'] = re.sub(rb'\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>78DEHM])', b'', out).decode('utf-8', 'replace')[-2500:]
for name in ('exit', 'screen'):
    try:
        with open(H + '/.koloft/tabs/tab1.' + name) as f:
            result['tab_' + name] = f.read()[-1500:]
    except OSError:
        pass
try:
    with open(MIRROR) as f:
        result['mirror'] = [line.strip()[:200] for line in f][:40]
except OSError as e:
    result['mirror'] = str(e)
with open('/tmp/outer-start.bin', 'wb') as f:
    f.write(out)
os.close(fd)
time.sleep(1)
_, _, out2, _ = client('attach', 4)
result['reattach_bytes'] = len(out2)
result['reattach_7501'] = [m.decode('latin1') for m in re.findall(rb'\x1b\]7501;[^\x07\x1b]*', out2)]
result['reattach_has_echo'] = b'hello probe' in out2
result['sessions_after_attach'] = tmux('list-sessions', '-F', '#{session_name} #{session_attached}')
with open('/tmp/outer-attach.bin', 'wb') as f:
    f.write(out2)
tmux('kill-server')
print(json.dumps(result, indent=1))
