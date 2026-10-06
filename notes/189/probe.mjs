#!/usr/bin/env node
import { execFileSync, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FIXTURES = path.join(REPO, 'test', 'e2e', 'fixtures')
const SSH = '/usr/bin/ssh'
const SSH_KEYGEN = '/usr/bin/ssh-keygen'
const LABEL = 'koloft-probe-189'
const CASE_TIMEOUT_MS = 30_000
const USER = 'kuser'
const HOME = `/home/${USER}`

const REMOTE_PATH_LINE =
  'export PATH="$HOME/.local/bin:$HOME/.koloft/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
const NETWORK_GIT = `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false \
SSH_ASKPASS_REQUIRE=never GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes" git "$@"`
const GIT = `GIT_OPTIONAL_LOCKS=0 git "$@"`

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`
function remoteShCommand(script, args) {
  const body = `set -- ${args.map(shq).join(' ')}\n${REMOTE_PATH_LINE}\n${script}`
  return `sh -c 'eval "$(printf %s "$0" | base64 -d)"' ${Buffer.from(body).toString('base64')}`
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-189-'))
const controlDir = `/tmp/koloft-189-${process.getuid()}`
fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })
const key = path.join(work, 'id_probe')
const knownHosts = path.join(work, 'known_hosts')
const config = path.join(work, 'config')
const id = crypto.randomBytes(3).toString('hex')
const container = `kl-probe-189-${id}`
const out = []
const log = (line) => {
  console.log(line)
  out.push(line)
}

function dk(args, opts = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
}

function ensureImage() {
  const h = crypto.createHash('sha256')
  for (const name of ['sshd.Dockerfile', 'sshd-entrypoint.sh', 'fake-claude.js']) {
    h.update(name)
    h.update('\0')
    h.update(fs.readFileSync(path.join(FIXTURES, name)))
    h.update('\0')
  }
  const image = `koloft-e2e-sshd:${h.digest('hex').slice(0, 12)}`
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
    dk(['build', '-q', '-t', image, '-f', path.join(FIXTURES, 'sshd.Dockerfile'), FIXTURES])
  }
  return image
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function hostKey() {
  const deadline = Date.now() + 30_000
  for (;;) {
    const r = spawnSync('docker', ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
      encoding: 'utf8'
    })
    const [type, k] = (r.stdout ?? '').trim().split(/\s+/)
    if (r.status === 0 && k) return `${type} ${k}`
    if (Date.now() > deadline) throw new Error('no host key')
    await sleep(250)
  }
}

function sshOptions() {
  return [
    '-o',
    'RemoteCommand=none',
    '-o',
    'RequestTTY=no',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlDir}/%C`,
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

function sshRun(remoteCmd, timeoutMs) {
  const args = ['-n', '-F', config, ...sshOptions(), 'kt-probe', remoteCmd]
  const t0 = Date.now()
  const r = spawnSync(SSH, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' })
  return {
    code: r.status,
    signal: r.signal,
    ms: Date.now() - t0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? ''
  }
}

function onTarget(script) {
  return dk(['exec', '-u', USER, '-w', HOME, container, 'sh', '-c', script])
}

function runCase(name, script, repoDir, args) {
  const cmd = remoteShCommand(script, ['-C', repoDir, ...args])
  const r = sshRun(cmd, CASE_TIMEOUT_MS)
  log(`\n=== ${name}`)
  log(`remote: ${script === NETWORK_GIT ? 'NETWORK_GIT' : 'GIT'} -C ${repoDir} ${args.join(' ')}`)
  log(`exit=${r.code === null ? `killed by local timeout (${r.signal})` : r.code} time=${r.ms}ms`)
  const err = r.stderr.trim().split('\n').slice(0, 6).join('\n')
  log(`stderr:\n${err || '(empty)'}`)
  if (r.stdout.trim()) log(`stdout:\n${r.stdout.trim().split('\n').slice(0, 6).join('\n')}`)
  const fetchHead = onTarget(
    `stat -c 'yes, %s bytes' ${repoDir}/.git/FETCH_HEAD 2>/dev/null || echo no`
  ).trim()
  log(`FETCH_HEAD written: ${fetchHead}`)
}

const FETCH = ['fetch', '--quiet', '--no-auto-maintenance', 'origin', 'main']

async function main() {
  log(`probe 189 · ${new Date().toISOString()} · host ${os.platform()} ${os.release()}`)
  log(`local ssh: ${spawnSync(SSH, ['-V'], { encoding: 'utf8' }).stderr.trim()}`)
  const image = ensureImage()
  log(`image: ${image}`)
  execFileSync(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', LABEL, '-f', key])
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()
  dk([
    'run',
    '-d',
    '--label',
    LABEL,
    '--name',
    container,
    '--hostname',
    container,
    '-p',
    '127.0.0.1::22',
    '-e',
    `LAB_PUBKEY=${pub}`,
    image
  ])
  try {
    const port = Number(/:(\d+)/.exec(dk(['port', container, '22/tcp']))?.[1])
    fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${await hostKey()}\n`)
    fs.writeFileSync(
      config,
      [
        'Host kt-probe',
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        `  User ${USER}`,
        `  IdentityFile ${JSON.stringify(key)}`,
        '  IdentitiesOnly yes',
        '  IdentityAgent none',
        `  UserKnownHostsFile ${JSON.stringify(knownHosts)}`,
        '  GlobalKnownHostsFile /dev/null',
        ''
      ].join('\n')
    )
    const deadline = Date.now() + 30_000
    for (;;) {
      const r = sshRun('true', 10_000)
      if (r.code === 0) break
      if (Date.now() > deadline) {
        throw new Error(
          `ssh never came up: ${r.stderr}\n${dk(['logs', container], { stdio: ['ignore', 'pipe', 'pipe'] })}`
        )
      }
      await sleep(250)
    }
    log(
      `target: ${onTarget('git --version; ssh -V 2>&1; ls ~/.ssh; ls /bin/false').trim().replace(/\n/g, ' | ')}`
    )
    log(
      `target has no ssh key / agent: ${onTarget('ls ~/.ssh/id_* 2>&1; echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"').trim().replace(/\n/g, ' | ')}`
    )
    log(
      `target credential helper: ${onTarget('git config --global --get credential.helper; echo "rc=$?"').trim()}`
    )

    const SSH_URL = 'git@github.com:superkoh/koloft.git'
    const HTTPS_PUBLIC = 'https://github.com/superkoh/koloft.git'
    const HTTPS_NO_SUCH = 'https://github.com/superkoh/koloft-189-no-such-repo.git'
    const repos = {
      sshNoKnownHosts: SSH_URL,
      sshKnownHosts: SSH_URL,
      sshKnownHostsBare: SSH_URL,
      httpsPublic: HTTPS_PUBLIC,
      httpsNoCreds: HTTPS_NO_SUCH,
      httpsNoCredsBare: HTTPS_NO_SUCH
    }
    for (const [name, url] of Object.entries(repos)) {
      onTarget(`git init -q ${name} && git -C ${name} remote add origin ${shq(url)}`)
    }

    runCase(
      'A1 ssh origin, no github.com in known_hosts, no key (Koloft guard)',
      NETWORK_GIT,
      `${HOME}/sshNoKnownHosts`,
      FETCH
    )

    const scan = onTarget(
      'mkdir -p ~/.ssh && ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null; wc -l < ~/.ssh/known_hosts'
    ).trim()
    log(`\nknown_hosts lines after ssh-keyscan github.com: ${scan}`)
    runCase(
      'A2 ssh origin, github.com trusted, no key (Koloft guard)',
      NETWORK_GIT,
      `${HOME}/sshKnownHosts`,
      FETCH
    )
    runCase(
      'A3 ssh origin, github.com trusted, no key (bare git, no guard)',
      GIT,
      `${HOME}/sshKnownHostsBare`,
      FETCH
    )

    const certs = spawnSync(
      'docker',
      [
        'exec',
        '-u',
        'root',
        container,
        'sh',
        '-c',
        'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq ca-certificates >/dev/null 2>&1; ls /etc/ssl/certs/ca-certificates.crt'
      ],
      { encoding: 'utf8', timeout: 180_000 }
    )
    log(
      `\nlab image has no CA bundle (not a real-machine trait), so ca-certificates was installed for the https cases: ${(certs.stdout + certs.stderr).trim()}`
    )

    runCase(
      'B1 https origin, repo needs a login, no credential helper (Koloft guard)',
      NETWORK_GIT,
      `${HOME}/httpsNoCreds`,
      FETCH
    )
    runCase(
      'B2 https origin, repo needs a login, no credential helper (bare git, no guard)',
      GIT,
      `${HOME}/httpsNoCredsBare`,
      FETCH
    )

    runCase(
      'C1 https public origin, no credentials needed (Koloft guard) — happy path',
      NETWORK_GIT,
      `${HOME}/httpsPublic`,
      FETCH
    )
    const counts = onTarget(
      `cd httpsPublic; git rev-list --count origin/main 2>&1; git for-each-ref refs/remotes 2>&1; exit 0`
    ).trim()
    log(`after C1, origin/main on the target: ${counts.replace(/\n/g, ' | ')}`)
  } finally {
    spawnSync(SSH, ['-F', config, '-o', `ControlPath=${controlDir}/%C`, '-O', 'exit', 'kt-probe'], {
      stdio: 'ignore'
    })
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
    const left = spawnSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], {
      encoding: 'utf8'
    }).stdout.trim()
    log(`\ncontainers left with label ${LABEL}: ${left || 'none'}`)
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(controlDir, { recursive: true, force: true })
    fs.writeFileSync(path.join(HERE, 'output.txt'), out.join('\n') + '\n')
  }
}

main().catch((e) => {
  log(`probe failed: ${e?.stack ?? e}`)
  process.exit(1)
})
