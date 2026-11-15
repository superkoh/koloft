import os, subprocess, tempfile

H = os.path.expanduser('~')
FIXED = ':'.join([H + '/.local/bin', H + '/.koloft/node/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/games'])
fd, f = tempfile.mkstemp()
os.close(fd)
env = {'HOME': H, 'USER': 'u', 'SHELL': '/bin/zsh', 'PATH': FIXED, 'KOLOFT_LOGIN_PATH_FILE': f}
subprocess.run(['/bin/zsh', '-lic', 'printf %s "$PATH" > "$KOLOFT_LOGIN_PATH_FILE"'], cwd=H, env=env,
               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
login_path = open(f).read()
os.remove(f)
plain = subprocess.run(['/bin/sh', '-c', 'command -v rconly-tool || echo NOT-FOUND'], env=dict(env), stdout=subprocess.PIPE).stdout.decode().strip()
print('LOGIN_PATH=' + login_path)
print('plain sh with the fixed PATH: ' + plain)
