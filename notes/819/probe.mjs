import { spawn, spawnSync, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const IMAGE = process.argv[2]
const OUTAGE_MS = Number(process.argv[3] ?? 30000)
const KILL_WITH_LINK_UP = process.argv[4] === 'baseline'
const id = `${process.pid}`
const NET = `k819-net-${id}`
const TARGET = `k819-target-${id}`
const BASTION = `k819-bastion-${id}`
const work = path.join(path.dirname(new URL(import.meta.url).pathname), `run-${id}`)
const ctl = `/tmp/k819-${id}`
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(ctl, { recursive: true, mode: 0o700 })
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a)
const dk = (args, ok = false) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' })
  if (r.status !== 0 && !ok) throw new Error(`docker ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const key = path.join(work, 'id')
execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()

function cleanup() {
  dk(['rm', '-f', TARGET, BASTION], true)
  dk(['network', 'rm', NET], true)
  spawnSync('/bin/rm', ['-rf', ctl])
}
process.on('exit', cleanup)

dk(['network', 'create', NET])
dk(['run', '-d', '--name', TARGET, '--hostname', TARGET, '--network', NET, '-e', `LAB_PUBKEY=${pub}`, IMAGE])
dk(['run', '-d', '--name', BASTION, '--network', NET, '-p', '127.0.0.1::22', '-e', `LAB_PUBKEY=${pub}`, IMAGE])
const port = Number(/:(\d+)/.exec(dk(['port', BASTION, '22/tcp']))[1])
const cfg = path.join(work, 'config')
fs.writeFileSync(
  cfg,
  [
    'Host jump',
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    'Host target',
    `  HostName ${TARGET}`,
    '  ProxyJump jump',
    'Host *',
    '  User kuser',
    `  IdentityFile ${key}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking no',
    '  UserKnownHostsFile /dev/null',
    '  LogLevel ERROR',
    ''
  ].join('\n')
)
const KOLOFT_OPTS = [
  '-F', cfg,
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${ctl}/%C`,
  '-o', 'ControlPersist=yes',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3'
]

for (let i = 0; ; i++) {
  const r = spawnSync('ssh', [...KOLOFT_OPTS, '-o', 'BatchMode=yes', 'target', 'true'], { timeout: 10000 })
  if (r.status === 0) break
  if (i > 60) throw new Error('target never answered')
  await sleep(500)
}
log('target answers over ssh through the jump host')

const tabScript = `[ "$1" = attach ] && { tmux -L koloft attach -t k-x; exit $?; }
tmux -L koloft new-session -A -s k-x 'sleep 100000'
`
spawnSync('ssh', [...KOLOFT_OPTS, 'target', 'cat > t.sh'], { input: tabScript })

const loop =
  `a=start; while :; do ssh -tt ${KOLOFT_OPTS.map((o) => `'${o}'`).join(' ')} target "sh t.sh $a"; c=$?; ` +
  `[ "$c" = 255 ] || { echo "LOOP-EXIT $c"; exit "$c"; }; a=attach; echo "LOOP-RECONNECT"; sleep 2; done`
const ptyRun = path.join(path.dirname(new URL(import.meta.url).pathname), 'pty_run.py')
const pty = spawn('python3', ['-I', ptyRun, 'sh', '-c', loop], { stdio: ['pipe', 'pipe', 'pipe'] })
pty.stderr.on('data', (d) => log('pty stderr', JSON.stringify(d.toString().slice(0, 300))))
let ptyOut = ''
pty.stdout.on('data', (d) => {
  const s = d.toString()
  ptyOut += s
  for (const m of s.matchAll(/LOOP-(EXIT \d+|RECONNECT)/g)) {
    log('pty says', m[0])
    if (m[0].startsWith('LOOP-EXIT')) ptyExitAt = Date.now()
  }
})
let ptyExitAt = null
pty.on('exit', (code) => {
  ptyExitAt = Date.now()
  log('PTY EXITED, code', code, JSON.stringify(ptyOut.slice(-400)))
})

let beats = []
let stopBeats = false
const heartbeat = async () => {
  while (!stopBeats) {
    const started = Date.now()
    const r = await new Promise((resolve) => {
      const c = spawn(
        'ssh',
        [...KOLOFT_OPTS, '-o', 'BatchMode=yes', '-n', 'target', 'tmux -L koloft ls -F "#S" 2>/dev/null; true'],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      )
      let stdout = ''
      c.stdout.on('data', (d) => (stdout += d))
      const t = setTimeout(() => c.kill('SIGTERM'), 20000)
      c.on('exit', (status, signal) => {
        clearTimeout(t)
        resolve({ status, signal, stdout })
      })
    })
    const alive = r.status === 0 ? (r.stdout.includes('k-x') ? 'k-x alive' : 'k-x GONE') : `FAILED(${r.status ?? r.signal})`
    const last = beats[beats.length - 1]
    if (last !== alive) log('heartbeat:', alive, `(${Date.now() - started} ms)`)
    beats.push(alive)
    await sleep(2000)
  }
}

for (let i = 0; ; i++) {
  if (spawnSync('docker', ['exec', '-u', 'kuser', TARGET, 'tmux', '-L', 'koloft', 'has-session', '-t', 'k-x']).status === 0)
    break
  if (i > 60) throw new Error('tmux session never started')
  await sleep(500)
}
log('tmux session k-x runs on the target, pty attached')
void heartbeat()
await sleep(3000)

if (!KILL_WITH_LINK_UP) {
  dk(['network', 'disconnect', NET, TARGET])
  log('LINK DOWN: target off the network')
}
dk(['exec', '-u', 'kuser', TARGET, 'tmux', '-L', 'koloft', 'kill-session', '-t', 'k-x'])
log('tmux session k-x killed on the target')

if (!KILL_WITH_LINK_UP) {
  await sleep(OUTAGE_MS)
  dk(['network', 'connect', NET, TARGET])
  log('LINK UP: target back on the network')
}

const deadline = Date.now() + 150000
while (ptyExitAt === null && Date.now() < deadline) await sleep(500)
await sleep(6000)
stopBeats = true
log(ptyExitAt === null ? 'RESULT: pty still up after 150 s' : 'RESULT: pty exited')
fs.writeFileSync(path.join(work, 'pty.txt'), ptyOut)
pty.kill('SIGKILL')
process.exit(0)
