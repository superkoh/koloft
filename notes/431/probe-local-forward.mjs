import { execFileSync, spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const IMAGE = process.argv[2]
if (!IMAGE) throw new Error('usage: node probe-local-forward.mjs <koloft-e2e-sshd image>')
const DOCKER = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find((d) => fs.existsSync(d))
const SSH = '/usr/bin/ssh'
const NAME = `probe431-${process.pid}`
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'probe431-'))
const control = `/tmp/p431-${process.pid}`
fs.mkdirSync(control, { mode: 0o700 })
const key = path.join(work, 'id')
const cfg = path.join(work, 'config')
const known = path.join(work, 'known')

const dk = (args, opts = {}) => execFileSync(DOCKER, args, { encoding: 'utf8', ...opts })
const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function kOpts() {
  return [
    '-F',
    cfg,
    '-o',
    'RemoteCommand=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${control}/%C`,
    '-o',
    'ControlPersist=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'BatchMode=yes'
  ]
}

function run(label, user, argsBeforeHost, argsAfterHost = [], timeout = 15_000) {
  const t0 = Date.now()
  const r = spawnSync(SSH, [...kOpts(), ...argsBeforeHost, `lab-${user}`, ...argsAfterHost], {
    encoding: 'utf8',
    timeout
  })
  const ms = Date.now() - t0
  log(
    `[${label}] exit=${r.status} ms=${ms} stdout=${JSON.stringify(r.stdout.trim())} stderr=${JSON.stringify(r.stderr.trim())}`
  )
  return r
}

function logins(user) {
  const out = dk(['logs', NAME], { stdio: ['ignore', 'pipe', 'pipe'] })
  const err = spawnSync(DOCKER, ['logs', NAME], { encoding: 'utf8' }).stderr
  return `${out}${err}`.split('\n').filter((l) => l.includes(`Accepted publickey for ${user}`))
    .length
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

async function get(url) {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const body = await res.text()
    return `HTTP ${res.status} ${body.length}B in ${Date.now() - t0}ms`
  } catch (e) {
    return `error ${e.cause?.code ?? e.cause?.message ?? e.message} in ${Date.now() - t0}ms`
  }
}

function sshdConfigAppend(lines) {
  dk([
    'exec',
    NAME,
    'sh',
    '-c',
    `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} >> /etc/ssh/sshd_config && pkill -HUP -x sshd || kill -HUP 1`
  ])
}

async function main() {
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()
  dk(['run', '-d', '--name', NAME, '-e', `LAB_PUBKEY=${pub}`, '-p', '127.0.0.1::22', IMAGE])
  const port = Number(/:(\d+)/.exec(dk(['port', NAME, '22/tcp']))[1])
  let hostKey = ''
  for (let i = 0; i < 120 && !hostKey; i++) {
    const r = spawnSync(DOCKER, ['exec', NAME, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
      encoding: 'utf8'
    })
    if (r.status === 0) hostKey = r.stdout.trim().split(/\s+/).slice(0, 2).join(' ')
    else await sleep(250)
  }
  fs.writeFileSync(known, `[127.0.0.1]:${port} ${hostKey}\n`)
  fs.writeFileSync(
    cfg,
    ['kuser', 'nuser', 'muser']
      .map(
        (u) =>
          `Host lab-${u}\n  HostName 127.0.0.1\n  Port ${port}\n  User ${u}\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${known}\n  GlobalKnownHostsFile /dev/null\n`
      )
      .join('')
  )
  for (let i = 0; i < 120; i++) {
    if (spawnSync(SSH, ['-F', cfg, '-o', 'BatchMode=yes', 'lab-kuser', 'true']).status === 0) break
    await sleep(250)
  }
  log('ssh client:', spawnSync(SSH, ['-V'], { encoding: 'utf8' }).stderr.trim())
  log(
    'sshd:',
    dk(['exec', NAME, 'sh', '-c', 'ssh -V 2>&1; . /etc/os-release; echo $PRETTY_NAME'])
      .trim()
      .replace(/\n/g, ' / ')
  )

  dk([
    'exec',
    '-d',
    '-u',
    'kuser',
    '-w',
    '/home/kuser/proj',
    NAME,
    'python3',
    '-m',
    'http.server',
    '8000',
    '--bind',
    '127.0.0.1'
  ])
  dk([
    'exec',
    '-d',
    '-u',
    'kuser',
    '-w',
    '/home/kuser/proj',
    NAME,
    'python3',
    '-m',
    'http.server',
    '8001',
    '--bind',
    '::1'
  ])
  await sleep(1000)

  log('\n== 1. master up, logins counted')
  run('master', 'kuser', [], ['true'])
  const before = logins('kuser')
  log('logins so far:', before)
  run('check', 'kuser', ['-O', 'check'])

  log('\n== 2. -L with port 0 (does ssh pick and print a Mac port?)')
  const r0 = run('forward L 0', 'kuser', ['-O', 'forward', '-L', '127.0.0.1:0:localhost:8000'])
  const picked = Number(r0.stdout.trim())
  if (picked > 0) log('fetch picked port:', await get(`http://127.0.0.1:${picked}/README.md`))

  log('\n== 3. -L with a port Koloft picked')
  const p1 = await freePort()
  const spec1 = `127.0.0.1:${p1}:localhost:8000`
  run('forward L', 'kuser', ['-O', 'forward', '-L', spec1])
  log('fetch 127.0.0.1:', await get(`http://127.0.0.1:${p1}/README.md`))
  log('fetch localhost:', await get(`http://localhost:${p1}/README.md`))
  log('logins after forward:', logins('kuser'), '(before', before, ')')
  run('plain command still rides', 'kuser', [], ['echo', 'ok'])

  log('\n== 4. machine side "localhost" reaching an ::1-only server')
  const p6 = await freePort()
  run('forward to ::1 server via localhost', 'kuser', [
    '-O',
    'forward',
    '-L',
    `127.0.0.1:${p6}:localhost:8001`
  ])
  log('fetch:', await get(`http://127.0.0.1:${p6}/README.md`))

  log('\n== 5. many connections at once')
  const results = await Promise.all(
    Array.from({ length: 30 }, () => get(`http://127.0.0.1:${p1}/README.md`))
  )
  log('30 parallel fetches:', results.filter((s) => s.startsWith('HTTP 200')).length, 'ok')

  log('\n== 6. the same spec again, and the same Mac port to another machine port')
  run('same spec twice', 'kuser', ['-O', 'forward', '-L', spec1])
  run('same Mac port, other target', 'kuser', [
    '-O',
    'forward',
    '-L',
    `127.0.0.1:${p1}:localhost:9999`
  ])

  log('\n== 7. a Mac port another program already holds')
  const holder = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => holder.once('listening', r))
  const held = holder.address().port
  run('forward onto held port', 'kuser', [
    '-O',
    'forward',
    '-L',
    `127.0.0.1:${held}:localhost:8000`
  ])
  run('check after', 'kuser', ['-O', 'check'])
  holder.close()

  log('\n== 8. a machine port nothing listens on')
  const p2 = await freePort()
  run('forward to dead port', 'kuser', ['-O', 'forward', '-L', `127.0.0.1:${p2}:localhost:9999`])
  log('fetch:', await get(`http://127.0.0.1:${p2}/`))
  run('check after', 'kuser', ['-O', 'check'])

  log('\n== 9. cancel: exact spec, and a spec written differently')
  run('cancel other spelling', 'kuser', ['-O', 'cancel', '-L', `${p1}:localhost:8000`])
  log('fetch after other-spelling cancel:', await get(`http://127.0.0.1:${p1}/README.md`))
  run('cancel exact', 'kuser', ['-O', 'cancel', '-L', spec1])
  log('fetch after exact cancel:', await get(`http://127.0.0.1:${p1}/README.md`))
  run('cancel again (already gone)', 'kuser', ['-O', 'cancel', '-L', spec1])
  run('plain command still rides', 'kuser', [], ['echo', 'ok'])

  log('\n== 10. the master goes, the forward goes')
  const p3 = await freePort()
  run('forward', 'kuser', ['-O', 'forward', '-L', `127.0.0.1:${p3}:localhost:8000`])
  log('fetch:', await get(`http://127.0.0.1:${p3}/README.md`))
  run('exit master', 'kuser', ['-O', 'exit'])
  await sleep(500)
  log('fetch after master exit:', await get(`http://127.0.0.1:${p3}/README.md`))
  run('forward with no master', 'kuser', ['-O', 'forward', '-L', `127.0.0.1:${p3}:localhost:8000`])

  log('\n== 11. MaxSessions 2 (muser): two sessions held, then a forward')
  dk([
    'exec',
    '-d',
    '-u',
    'muser',
    '-w',
    '/home/muser/proj',
    NAME,
    'python3',
    '-m',
    'http.server',
    '8002',
    '--bind',
    '127.0.0.1'
  ])
  await sleep(800)
  run('master muser', 'muser', [], ['true'])
  const held1 = spawn(SSH, [...kOpts(), 'lab-muser', 'sleep 30'], { stdio: 'ignore' })
  const held2 = spawn(SSH, [...kOpts(), 'lab-muser', 'sleep 30'], { stdio: 'ignore' })
  await sleep(1500)
  const pm = await freePort()
  run('forward while full', 'muser', ['-O', 'forward', '-L', `127.0.0.1:${pm}:localhost:8002`])
  log('fetch while 2 sessions held:', await get(`http://127.0.0.1:${pm}/README.md`))
  held1.kill()
  held2.kill()
  run('exit master muser', 'muser', ['-O', 'exit'])

  log('\n== 12. AllowTcpForwarding no (nuser)')
  sshdConfigAppend(['Match User nuser', '  AllowTcpForwarding no'])
  await sleep(800)
  dk([
    'exec',
    '-d',
    '-u',
    'nuser',
    '-w',
    '/home/nuser/proj',
    NAME,
    'python3',
    '-m',
    'http.server',
    '8003',
    '--bind',
    '127.0.0.1'
  ])
  await sleep(800)
  run('master nuser', 'nuser', [], ['true'])
  const pn = await freePort()
  run('forward', 'nuser', ['-O', 'forward', '-L', `127.0.0.1:${pn}:localhost:8003`])
  log('fetch:', await get(`http://127.0.0.1:${pn}/README.md`))
  run('check after', 'nuser', ['-O', 'check'])
  run('plain command still rides', 'nuser', [], ['echo', 'ok'])
  run('exit master nuser', 'nuser', ['-O', 'exit'])
}

try {
  await main()
} finally {
  spawnSync(DOCKER, ['rm', '-f', NAME], { stdio: 'ignore' })
  for (const u of ['kuser', 'nuser', 'muser'])
    spawnSync(SSH, [...kOpts(), '-O', 'exit', `lab-${u}`], { stdio: 'ignore', timeout: 5000 })
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(control, { recursive: true, force: true })
}
