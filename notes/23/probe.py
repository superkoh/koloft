import json, os, pty, re, select, sys, time, tempfile

BIN = os.environ['CLAUDE_BIN']
variant = sys.argv[1]
flag = sys.argv[2] if len(sys.argv) > 2 else 'dsp'

base = tempfile.mkdtemp(prefix='probe23-')
cfg = os.path.join(base, 'cfg')
work = os.path.join(base, 'work')
os.makedirs(cfg)
os.makedirs(work)
work = os.path.realpath(work)
with open(os.path.join(cfg, '.claude.json'), 'w') as f:
    json.dump({'hasCompletedOnboarding': True,
               'projects': {work: {'hasTrustDialogAccepted': True}}}, f)
args = [BIN, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
if flag == 'dsp':
    args.append('--dangerously-skip-permissions')
elif flag == 'pm':
    args += ['--permission-mode', 'bypassPermissions']
if variant == 'flagsettings':
    sp = os.path.join(base, 'inj.json')
    with open(sp, 'w') as f:
        json.dump({'skipDangerousModePermissionPrompt': True}, f)
    args += ['--settings', sp]
elif variant == 'usersettings':
    with open(os.path.join(cfg, 'settings.json'), 'w') as f:
        json.dump({'skipDangerousModePermissionPrompt': True}, f)

env = {k: v for k, v in os.environ.items()
       if not (k.startswith('CLAUDE_CODE') or k.startswith('KOLOFT') or k in ('CLAUDECODE', 'CLAUDE_PID', 'ANTHROPIC_API_KEY'))}
env['CLAUDE_CONFIG_DIR'] = cfg
env['DISABLE_AUTOUPDATER'] = '1'
env['TERM'] = 'xterm-256color'

pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execve(BIN, args, env)
buf = b''
end = time.time() + 20
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if b'?6n' in chunk:
            os.write(fd, b'\x1b[1;1R')
text = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b.', ' ', buf.decode('utf8', 'replace'))
text = re.sub(r'\s+', ' ', text)
hit = 'Bypass Permissions mode' in text
print(variant, flag, 'WARNING_SCREEN' if hit else 'no-warning', '|', text[-500:])
try:
    os.kill(pid, 9)
except OSError:
    pass
