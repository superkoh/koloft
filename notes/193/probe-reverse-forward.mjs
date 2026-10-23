import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FIXTURES = path.join(REPO, 'test', 'e2e', 'fixtures')
const OUTPUT = path.join(HERE, 'probe-output.txt')
const DOCKER = '/opt/homebrew/bin/docker'
const SSH = '/usr/bin/ssh'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LABEL = 'koloft-probe-193'
const id = crypto.randomBytes(3).toString('hex')
const net = `kp193-net-${id}`
const bastion = `kp193-bastion-${id}`
const target = `kp193-target-${id}`
const tmp = fs.mkdtempSync('/tmp/kp193-')
const cm = path.join(tmp, 'cm')
const lines = []
let chrome = null
const CLIENT_BUDGET_MS = 15_000
let relayServer = null
const LISTENERS = [
  'import sys,socket,struct',
  'want=int(sys.argv[1])',
  'for f,fam in (("/proc/net/tcp",4),("/proc/net/tcp6",6)):',
  '  for l in open(f).read().splitlines()[1:]:',
  '    p=l.split();a,port=p[1].split(":")',
  '    if p[3]=="0A" and int(port,16)==want:',
  '      b=bytes.fromhex(a)',
  '      ip=socket.inet_ntoa(struct.pack("<I",int(a,16))) if fam==4 else socket.inet_ntop(socket.AF_INET6,b"".join(b[i:i+4][::-1] for i in range(0,16,4)))',
  '      print("listen",ip,want)'
].join('\n')

function log(step, value) {
  const line = `${step}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  lines.push(line)
  console.log(line)
}

function dk(args, opts = {}) {
  return execFileSync(DOCKER, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
}

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20_000 })
  return { code: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function koloftSshOptions() {
  return [
    '-o',
    'RemoteCommand=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${cm}/%C`,
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

const config = path.join(tmp, 'config')
const ssh = (alias, ...args) => run(SSH, ['-F', config, ...koloftSshOptions(), ...args, alias])
const sshCmd = (alias, cmd) => run(SSH, ['-F', config, ...koloftSshOptions(), '-n', alias, cmd])
const mux = (alias, op, ...args) =>
  run(SSH, ['-F', config, '-o', `ControlPath=${cm}/%C`, '-O', op, ...args, alias])

async function onMachine(user, ...args) {
  const r = await new Promise((resolve) => {
    execFile(
      DOCKER,
      ['exec', '-u', user, target, 'node', '/opt/probe/machine-client.mjs', ...args],
      {
        encoding: 'utf8',
        timeout: CLIENT_BUDGET_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024
      },
      (err, stdout, stderr) => resolve({ err, stdout, stderr, status: err ? err.code : 0 })
    )
  })
  if (r.err?.killed) return { ok: false, hungFor: CLIENT_BUDGET_MS }
  const last = (r.stdout || '').trim().split('\n').at(-1) || ''
  try {
    const parsed = JSON.parse(last)
    return r.stderr.trim() ? { ...parsed, stderr: r.stderr.trim().slice(0, 400) } : parsed
  } catch {
    return {
      ok: false,
      raw: r.stdout,
      stderr: r.stderr,
      code: r.status,
      err: r.err ? String(r.err.message).slice(0, 300) : null
    }
  }
}

async function hostKey(container) {
  for (let i = 0; i < 120; i++) {
    const r = spawnSync(DOCKER, ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
      encoding: 'utf8'
    })
    const [type, key] = (r.stdout || '').trim().split(/\s+/)
    if (r.status === 0 && key) return `${type} ${key}`
    await sleep(250)
  }
  throw new Error(`no host key in ${container}`)
}

function startRelayStandIn() {
  const secret = crypto.randomBytes(16).toString('hex')
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  wss.on('connection', (ws, req) => {
    if (req.url !== `/cdp/${secret}`) {
      ws.close(1008, 'unknown endpoint')
      return
    }
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.method === 'Browser.getVersion')
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { product: 'relay-stand-in', from: req.socket.remoteAddress }
          })
        )
      else if (msg.method === 'Probe.big')
        ws.send(JSON.stringify({ id: msg.id, result: { data: 'x'.repeat(msg.params.bytes) } }))
    })
  })
  return new Promise((resolve) =>
    wss.on('listening', () => resolve({ wss, port: wss.address().port, secret }))
  )
}

async function startChrome() {
  const profile = path.join(tmp, 'chrome')
  fs.mkdirSync(profile)
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const file = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(file)) {
      const [port, wsPath] = fs.readFileSync(file, 'utf8').trim().split('\n')
      if (port && wsPath) return { port: Number(port), wsPath }
    }
    await sleep(250)
  }
  throw new Error('chrome never wrote DevToolsActivePort')
}

function cleanup() {
  if (relayServer) relayServer.close()
  if (chrome) chrome.kill('SIGKILL')
  for (const alias of ['kt-key', 'kt-tuser', 'kt-nofwd']) mux(alias, 'exit')
  spawnSync(DOCKER, ['rm', '-f', bastion, target], { stdio: 'ignore' })
  spawnSync(DOCKER, ['network', 'rm', net], { stdio: 'ignore' })
  fs.rmSync(tmp, { recursive: true, force: true })
}

for (const sig of ['SIGTERM', 'SIGINT'])
  process.on(sig, () => {
    cleanup()
    process.exit(1)
  })

const masked = (s, secret) => s.split(secret).join('<secret>')

try {
  log('ssh client', run(SSH, ['-V']).stderr)
  fs.mkdirSync(cm, { mode: 0o700 })
  const key = path.join(tmp, 'id_lab')
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', LABEL, '-f', key])
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()
  const image = `${LABEL}:${id}`
  dk(['build', '-q', '-t', image, '-f', path.join(FIXTURES, 'sshd.Dockerfile'), FIXTURES])
  dk(['network', 'create', '--label', LABEL, net])
  const box = (name, extra) =>
    dk([
      'run',
      '-d',
      '--label',
      LABEL,
      '--name',
      name,
      '--hostname',
      name,
      '--network',
      net,
      '-e',
      `LAB_PUBKEY=${pub}`,
      ...extra,
      image
    ])
  box(target, [])
  box(bastion, ['-p', '127.0.0.1::22'])
  const port = Number(/:(\d+)/.exec(dk(['port', bastion, '22/tcp']))[1])
  const knownHosts = path.join(tmp, 'known_hosts')
  fs.writeFileSync(
    knownHosts,
    `[127.0.0.1]:${port} ${await hostKey(bastion)}\n${target} ${await hostKey(target)}\n`
  )
  fs.writeFileSync(
    config,
    [
      'Host kt-jump',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      '  User kuser',
      'Host kt-key',
      '  User kuser',
      'Host kt-tuser',
      '  User tuser',
      'Host kt-nofwd',
      '  User nuser',
      'Host kt-key kt-tuser kt-nofwd',
      `  HostName ${target}`,
      '  ProxyJump kt-jump',
      'Host kt-*',
      `  IdentityFile ${key}`,
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      ''
    ].join('\n')
  )
  for (let i = 0; ; i++) {
    if (run(SSH, ['-F', config, '-o', 'BatchMode=yes', 'kt-key', 'true']).code === 0) break
    if (i > 120) throw new Error('lab never came up')
    await sleep(250)
  }
  log('machine sshd', dk(['exec', target, 'sh', '-c', 'sshd -V 2>&1 || ssh -V 2>&1']).trim())
  dk(['exec', target, 'mkdir', '-p', '/opt/probe'])
  dk(['cp', path.join(HERE, 'machine-client.mjs'), `${target}:/opt/probe/machine-client.mjs`])
  dk([
    'cp',
    path.join(REPO, 'node_modules', 'playwright-core'),
    `${target}:/opt/probe/playwright-core`
  ])
  dk(['exec', target, 'mkdir', '-p', '/opt/probe/node_modules'])
  dk(['cp', path.join(REPO, 'node_modules', 'ws'), `${target}:/opt/probe/node_modules/ws`])
  dk(['exec', target, 'chmod', '-R', 'a+rX', '/opt/probe'])

  const relay = await startRelayStandIn()
  relayServer = relay.wss
  const S = relay.secret
  log('relay stand-in on the Mac', `ws://127.0.0.1:${relay.port}/cdp/<secret>`)

  log('1 open Koloft-style master (ProxyJump through the bastion)', sshCmd('kt-key', 'true'))
  log('1 master check', mux('kt-key', 'check'))

  const fwd = mux('kt-key', 'forward', '-R', `0:127.0.0.1:${relay.port}`)
  log('2 -O forward -R 0:127.0.0.1:<relay port> on the live master', fwd)
  const remotePort = Number(fwd.stdout.split('\n')[0])
  log('2 allocated port on the machine', remotePort)
  log(
    '2 listening sockets on that port (from /proc/net/tcp*)',
    dk(['exec', target, 'python3', '-c', LISTENERS, String(remotePort)]).trim()
  )

  const url = `ws://127.0.0.1:${remotePort}/cdp/${S}`
  const first = await onMachine('kuser', 'ws', url, String(8 * 1024 * 1024))
  log('3 kuser on the machine connects to the forwarded relay url (8 MiB reply)', first)
  log(
    '3b wrong path',
    await onMachine('kuser', 'ws', `ws://127.0.0.1:${remotePort}/cdp/${'0'.repeat(32)}`)
  )
  log(
    '3d same url with the machine Node 22 built-in WebSocket instead of the ws package',
    await onMachine('kuser', 'ws-native', url)
  )
  log(
    '3c another account on the same machine (tuser) with the right path',
    await onMachine('tuser', 'ws', url)
  )

  const sshPlainSession = sshCmd('kt-key', 'echo still-runs-commands')
  log('4 a normal command over the same master after the forward', sshPlainSession)

  const c = await startChrome()
  const cf = mux('kt-key', 'forward', '-R', `0:127.0.0.1:${c.port}`)
  const chromeRemote = Number(cf.stdout.split('\n')[0])
  log('5 second forward on the same master, to headless Chrome', {
    code: cf.code,
    port: chromeRemote,
    stderr: cf.stderr
  })
  log(
    '5 playwright-core connectOverCDP from the machine across the tunnel',
    await onMachine('kuser', 'pw', `ws://127.0.0.1:${chromeRemote}${c.wsPath}`)
  )

  dk(['cp', path.join(REPO, 'node_modules', '@playwright', 'cli'), `${target}:/opt/probe/cli`])
  dk(['exec', target, 'chmod', '-R', 'a+rX', '/opt/probe/cli'])
  const cli = (...a) => {
    const r = spawnSync(
      DOCKER,
      [
        'exec',
        '-u',
        'kuser',
        '-w',
        '/home/kuser',
        target,
        'node',
        '/opt/probe/cli/playwright-cli.js',
        '--session=probe',
        ...a
      ],
      { encoding: 'utf8', timeout: 60_000 }
    )
    return { code: r.status, out: `${r.stdout}${r.stderr}`.trim().slice(0, 600) }
  }
  log(
    '5b the playwright-cli Koloft ships, on the machine (node 22): attach --cdp across the tunnel',
    cli('attach', `--cdp=ws://127.0.0.1:${chromeRemote}${c.wsPath}`)
  )
  log(
    '5b goto',
    cli('goto', 'data:text/html,<title>cli-across-the-tunnel</title><button>Press</button>')
  )
  log('5b snapshot', cli('snapshot'))
  log('5b detach', cli('detach'))

  const again = mux('kt-key', 'forward', '-R', `${remotePort}:127.0.0.1:${relay.port}`)
  log('6 ask for the same machine port again while it is held', again)

  const cancel = mux('kt-key', 'cancel', '-R', `${remotePort}:127.0.0.1:${relay.port}`)
  log('7 -O cancel the relay forward', cancel)
  log('7 client after that cancel', await onMachine('kuser', 'ws', url))
  log(
    '7a -O cancel with the spec exactly as it was asked (port 0)',
    mux('kt-key', 'cancel', '-R', `0:127.0.0.1:${relay.port}`)
  )
  log('7a client after that cancel', await onMachine('kuser', 'ws', url))
  log(
    '7a listeners left on the port',
    dk(['exec', target, 'python3', '-c', LISTENERS, String(remotePort)]).trim() || '(none)'
  )
  const reAdd = mux('kt-key', 'forward', '-R', `${remotePort}:127.0.0.1:${relay.port}`)
  log('7 re-add the same machine port by number', reAdd)
  log('7 client after re-add', await onMachine('kuser', 'ws', url))

  dk([
    'exec',
    '-d',
    '-u',
    'kuser',
    target,
    'tmux',
    'new-session',
    '-d',
    '-s',
    'keepalive',
    'sleep 600'
  ])
  log('8 -O exit the master (link drops)', mux('kt-key', 'exit'))
  await sleep(500)
  log('8 client after the master is gone', await onMachine('kuser', 'ws', url))
  log(
    '8 tmux session on the machine still there',
    dk(['exec', '-u', 'kuser', target, 'tmux', 'ls']).trim()
  )
  log('8 new master', sshCmd('kt-key', 'true'))
  const after = mux('kt-key', 'forward', '-R', `${remotePort}:127.0.0.1:${relay.port}`)
  log('8 re-ask the same machine port on the new master', after)
  log('8 the old url works again', await onMachine('kuser', 'ws', url))

  const blocker = dk([
    'exec',
    '-d',
    '-u',
    'tuser',
    target,
    'python3',
    '-c',
    'import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",47123));s.listen();time.sleep(600)'
  ])
  void blocker
  await sleep(500)
  log(
    '9 forward to a machine port another program already holds (47123)',
    mux('kt-key', 'forward', '-R', `47123:127.0.0.1:${relay.port}`)
  )
  log(
    '9 listeners on 47123 after that',
    dk(['exec', target, 'python3', '-c', LISTENERS, '47123']).trim()
  )
  log(
    '9 a client to ws://localhost:47123 reaches',
    await onMachine('kuser', 'ws', `ws://localhost:47123/cdp/${S}`)
  )
  log(
    '9 a client to ws://127.0.0.1:47123 reaches',
    await onMachine('kuser', 'ws', `ws://127.0.0.1:47123/cdp/${S}`)
  )
  log('9 master still alive', mux('kt-key', 'check'))

  dk([
    'exec',
    target,
    'sh',
    '-c',
    "printf 'Match User nuser\\n  AllowTcpForwarding no\\n' >> /etc/ssh/sshd_config"
  ])
  log('10 sshd config test', dk(['exec', target, 'sh', '-c', 'sshd -t && echo ok']).trim())
  dk(['exec', target, 'kill', '-HUP', '1'])
  await sleep(1500)
  log('10 nuser master (AllowTcpForwarding no for nuser)', sshCmd('kt-nofwd', 'true'))
  const nf = mux('kt-nofwd', 'forward', '-R', `0:127.0.0.1:${relay.port}`)
  log('10 -O forward where the server forbids forwarding', nf)
  log('10 nuser master still alive', mux('kt-nofwd', 'check'))

  relay.wss.close()
  fs.writeFileSync(OUTPUT, masked(lines.join('\n') + '\n', S))
} catch (err) {
  log('probe failed', String(err.stack || err))
  fs.writeFileSync(OUTPUT, lines.join('\n') + '\n')
  process.exitCode = 1
} finally {
  cleanup()
}
