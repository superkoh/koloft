import os, pty, sys, time, select, signal

D = os.path.dirname(os.path.abspath(__file__))
pid, fd = pty.fork()
if pid == 0:
    os.execvp('sh', ['sh', os.path.join(D, 'run.sh')])

buf = b''
log = open(os.path.join(D, 'screen.log'), 'wb')


def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
            log.write(data)
            log.flush()
            if b'\x1b[6n' in data:
                os.write(fd, b'\x1b[1;1R')
    return True


def wait_for(words, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if not pump(0.5):
            return None
        low = buf.lower()
        for w in words:
            if w in low:
                return w
    return None


hit = wait_for([b'trust this folder', b'trust the files', b'for shortcuts', b'try "'], 60)
print('first screen:', hit)
if hit and b'trust' in hit:
    pump(1)
    os.write(fd, b'\x1b[B')
    pump(1)
    os.write(fd, b'\r')
    print('after trust:', wait_for([b'for shortcuts', b'try "'], 60))
pump(3)
for line in [b'Reply with the single word ok.', b'Reply with the single word yes.']:
    buf = b''
    os.write(fd, line)
    pump(1)
    os.write(fd, b'\r')
    pump(25)
pump(5)
os.kill(pid, signal.SIGTERM)
pump(2)
print('done')
