import os, shutil, subprocess

H = '/home/u'
P = H + '/p'
os.makedirs(H + '/rc-only/bin', exist_ok=True)
shutil.copy(P + '/rconly-tool', H + '/rc-only/bin/rconly-tool')
os.chmod(H + '/rc-only/bin/rconly-tool', 0o755)
shutil.copy(P + '/zshrc', H + '/.zshrc')
with open(H + '/.bashrc', 'a') as f:
    f.write('\nexport PATH="$HOME/rc-only/bin:$PATH"\n')
os.chmod(H + '/claude', 0o755)
subprocess.run(['chown', '-R', 'u:u', H], check=True)
print('ready')
