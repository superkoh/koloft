#!/usr/bin/env node
import { execFile, execFileSync, spawn, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const FIXTURES = path.join(REPO, 'test', 'e2e', 'fixtures')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}

const DOCKER_HOST = arg('docker-host')
const ROUNDS = Number(arg('rounds', '15'))
const WARMUP = 2
const RTTS = arg('rtt-list', '0,30,100').split(',').map(Number)
const USER = arg('user', 'kuser')
const PULL_COUNT = Number(arg('pulls', '3'))
const AT_ONCE = Number(arg('at-once', '7'))
const HEARTBEAT = fs.readFileSync(path.join(HERE, 'heartbeat.sh'), 'utf8')
const BELL = fs.readFileSync(path.join(HERE, 'bell.sh'), 'utf8')

const dockerArgs = (args) => (DOCKER_HOST ? ['-H', DOCKER_HOST, ...args] : args)
const dk = (args) =>
  execFileSync('docker', dockerArgs(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const PROJECT_FLAGS = [
  '--inplace',
  '-m',
  '--delete',
  '--include=/-home-USER-proj*/',
  '--include=/-home-USER-proj*/*.jsonl',
  '--include=/-home-USER-proj*/*.title',
  '--include=/-home-USER-proj*/*/',
  '--include=/-home-USER-proj*/*/**',
  '--exclude=*'
].map((f) => f.replace('USER', USER))
const HOOK_FLAGS = ['-I', '--inplace', '--delete']
const BRAIN_FLAGS = [
  '--inplace',
  '-m',
  '--delete',
  '--include=/*/',
  '--include=/*/*.md.metadata.json',
  '--include=/*/*.md',
  '--include=/*/.system_generated/',
  '--include=/*/.system_generated/logs/',
  '--include=/*/.system_generated/logs/transcript.jsonl',
  '--exclude=*'
]
const filesNamed = (name) => [
  '--inplace',
  '-m',
  '--delete',
  '--include=*/',
  `--include=${name}`,
  '--exclude=*'
]
const PULLS = [
  { name: 'transcripts', from: '.claude/projects', flags: PROJECT_FLAGS },
  { name: 'hooks', from: '.koloft/hook-sessions', flags: HOOK_FLAGS },
  { name: 'agy brain', from: '.gemini/antigravity-cli/brain', flags: BRAIN_FLAGS },
  { name: 'codex sessions', from: '.codex/sessions', flags: filesNamed('rollout-*.jsonl') },
  {
    name: 'codex archived',
    from: '.codex/archived_sessions',
    flags: filesNamed('rollout-*.jsonl')
  },
  { name: 'muse sessions', from: '.local/share/muse/sessions', flags: filesNamed('session.jsonl') },
  {
    name: 'agy conversations',
    from: '.gemini/antigravity-cli/conversations',
    flags: ['--delete', '--include=*.db', '--exclude=*']
  }
].slice(0, PULL_COUNT)

const SEED = `
import os, random, json
h = os.path.expanduser('~')
def line(n): return json.dumps({"type": "assistant", "text": "x" * n}) + "\\n"
def write(p, text):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f: f.write(text)
proj = os.path.join(h, '.claude/projects/-home-${USER}-proj')
for i in range(20): write(os.path.join(proj, f's{i:02d}.jsonl'), line(1000) * 200)
for i in range(10): write(os.path.join(proj, 'subagents', f'a{i:02d}.jsonl'), line(1000) * 50)
for i in range(15): write(os.path.join(h, '.koloft/hook-sessions', f'h{i:02d}.json'), json.dumps({"i": i}))
brain = os.path.join(h, '.gemini/antigravity-cli/brain')
for i in range(10):
    d = os.path.join(brain, f'c{i:02d}')
    for name in ('task.md', 'plan.md', 'walkthrough.md'):
        write(os.path.join(d, name), '# note\\n' + 'y' * 4000)
        write(os.path.join(d, name + '.metadata.json'), '{}')
    write(os.path.join(d, '.system_generated/logs/transcript.jsonl'), line(1000) * 100)
for folder in ('sessions', 'archived_sessions'):
    for i in range(10): write(os.path.join(h, '.codex', folder, '2026/11/13', f'rollout-{i:02d}.jsonl'), line(1000) * 100)
for i in range(10): write(os.path.join(h, '.local/share/muse/sessions', f'm{i:02d}', 'session.jsonl'), line(1000) * 100)
for i in range(5): write(os.path.join(h, '.gemini/antigravity-cli/conversations', f'c{i:02d}.db'), 'd' * 200000)
`

const TOUCH = `
import os, json, time, sys
h = os.path.expanduser('~')
n = int(sys.argv[1])
def line(k): return json.dumps({"t": time.time(), "text": "z" * k}) + "\\n"
def add(p):
    with open(os.path.join(h, p), 'a') as f: f.write(line(2000))
add(f'.claude/projects/-home-${USER}-proj/s{n % 20:02d}.jsonl')
with open(os.path.join(h, '.koloft/hook-sessions', f'h{n % 15:02d}.json'), 'w') as f: f.write(json.dumps({"n": n}))
add(f'.gemini/antigravity-cli/brain/c{n % 10:02d}/.system_generated/logs/transcript.jsonl')
add(f'.codex/sessions/2026/11/13/rollout-{n % 10:02d}.jsonl')
add(f'.codex/archived_sessions/2026/11/13/rollout-{n % 10:02d}.jsonl')
add(f'.local/share/muse/sessions/m{n % 10:02d}/session.jsonl')
add(f'.gemini/antigravity-cli/conversations/c{n % 5:02d}.db')
`

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        stderr: String(stderr)
      })
    )
  })
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function firstLine(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split(
      '\n'
    )[0]
  } catch (e) {
    return String(e.stderr ?? e).split('\n')[0]
  }
}

async function main() {
  console.log(
    `decision rule: pays only if the round median with 30 ms added round-trip is >= 30% shorter together, and nothing fails at the default MaxSessions`
  )
  console.log(`local rsync: ${firstLine('rsync', ['--version'])}`)
  console.log(`local ssh: ${spawnSync('ssh', ['-V'], { encoding: 'utf8' }).stderr.trim()}`)
  console.log(`pulls per round: ${PULLS.map((p) => p.name).join(', ')}; lab user ${USER}`)
  const image = 'koloft-679-sshd:measure'
  dk(['build', '-q', '-t', image, '-f', path.join(FIXTURES, 'sshd.Dockerfile'), FIXTURES])
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'k679-'))
  const control = fs.mkdtempSync('/tmp/k679-')
  const scrub = (s) => s.split(work).join('<work>').split(control).join('<control>')
  const key = path.join(work, 'id')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  const name = `k679-${crypto.randomBytes(3).toString('hex')}`
  dk([
    'run',
    '-d',
    '--name',
    name,
    '--cap-add',
    'NET_ADMIN',
    '-p',
    '127.0.0.1::22',
    '-e',
    `LAB_PUBKEY=${fs.readFileSync(`${key}.pub`, 'utf8').trim()}`,
    image
  ])
  const results = []
  let bell
  const config = path.join(work, 'config')
  try {
    console.log(`lab rsync: ${dk(['exec', name, 'rsync', '--version']).split('\n')[0]}`)
    const port = Number(/:(\d+)/.exec(dk(['port', name, '22/tcp']))[1])
    fs.writeFileSync(
      config,
      [
        'Host lab',
        '  HostName 127.0.0.1',
        `  Port ${port}`,
        `  User ${USER}`,
        `  IdentityFile ${key}`,
        '  IdentitiesOnly yes',
        '  UserKnownHostsFile /dev/null',
        '  StrictHostKeyChecking no',
        '  LogLevel ERROR',
        ''
      ].join('\n')
    )
    const sshOpts = [
      '-F',
      config,
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
    for (let i = 0; i < 60; i++) {
      if ((await run('ssh', ['-n', ...sshOpts, 'lab', 'true'])).code === 0) break
      await new Promise((r) => setTimeout(r, 500))
    }
    dk(['exec', '-u', USER, name, 'python3', '-c', SEED])
    const local = (p) => path.join(work, 'mirror', p.from)
    const rsync = (p) => {
      fs.mkdirSync(local(p), { recursive: true })
      return run('rsync', [
        '-a',
        ...p.flags,
        '--timeout=10',
        '-e',
        `ssh ${sshOpts.join(' ')}`,
        `lab:${p.from}/`,
        `${local(p)}/`
      ])
    }
    for (const p of PULLS) {
      const r = await rsync(p)
      const files = fs.readdirSync(local(p), { recursive: true }).length
      if (r.code !== 0 || files === 0)
        throw new Error(
          `first pull of ${p.name} moved nothing (code ${r.code}): ${scrub(r.stderr)}`
        )
    }
    bell = spawn('ssh', ['-n', ...sshOpts, 'lab', BELL], { stdio: 'ignore' })
    let netem = RTTS.some((r) => r > 0)
    if (netem) {
      try {
        dk(['exec', '-e', 'DEBIAN_FRONTEND=noninteractive', name, 'apt-get', 'update', '-qq'])
        dk([
          'exec',
          '-e',
          'DEBIAN_FRONTEND=noninteractive',
          name,
          'apt-get',
          'install',
          '-y',
          '-qq',
          'iproute2'
        ])
        dk(['exec', name, 'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', 'delay', '0ms'])
      } catch (e) {
        netem = false
        console.log(
          `netem not available, only the 0 ms row runs: ${String(e.stderr ?? e).split('\n')[0]}`
        )
      }
    }
    for (const rtt of RTTS) {
      if (rtt > 0 && !netem) continue
      if (netem)
        dk([
          'exec',
          name,
          'tc',
          'qdisc',
          'replace',
          'dev',
          'eth0',
          'root',
          'netem',
          'delay',
          `${rtt}ms`
        ])
      const times = { sequential: { round: [], pulls: [] }, together: { round: [], pulls: [] } }
      const errors = []
      let lastTouch = 0
      for (let i = 0; i < WARMUP + ROUNDS; i++) {
        for (const mode of i % 2 ? ['together', 'sequential'] : ['sequential', 'together']) {
          lastTouch = i * 2 + (mode === 'together' ? 1 : 0)
          dk(['exec', '-u', USER, name, 'python3', '-c', TOUCH, String(lastTouch)])
          const t0 = performance.now()
          const hb = await run('ssh', ['-n', ...sshOpts, 'lab', HEARTBEAT])
          const t1 = performance.now()
          let rs
          if (mode === 'sequential') {
            rs = []
            for (const p of PULLS) rs.push(await rsync(p))
          } else {
            rs = []
            let next = 0
            const worker = async () => {
              while (next < PULLS.length) {
                const k = next++
                rs[k] = await rsync(PULLS[k])
              }
            }
            await Promise.all(Array.from({ length: Math.min(AT_ONCE, PULLS.length) }, worker))
          }
          const t2 = performance.now()
          const named = [['heartbeat', hb], ...PULLS.map((p, k) => [p.name, rs[k]])]
          for (const [what, r] of named)
            if (r.code !== 0)
              errors.push({ mode, what, code: r.code, stderr: scrub(r.stderr.trim()).slice(-300) })
          if (i >= WARMUP) {
            times[mode].round.push(t2 - t0)
            times[mode].pulls.push(t2 - t1)
          }
        }
      }
      const touched = `.claude/projects/-home-${USER}-proj/s${String(lastTouch % 20).padStart(2, '0')}.jsonl`
      const remoteSize = Number(
        dk(['exec', name, 'stat', '-c', '%s', `/home/${USER}/${touched}`]).trim()
      )
      const localSize = fs.statSync(path.join(work, 'mirror', touched)).size
      const row = {
        rttMs: rtt,
        user: USER,
        pulls: PULLS.length,
        rounds: ROUNDS,
        lastTranscriptInSync: remoteSize === localSize,
        errors
      }
      for (const mode of ['sequential', 'together'])
        row[mode] = {
          roundMedianMs: Math.round(median(times[mode].round)),
          pullsMedianMs: Math.round(median(times[mode].pulls)),
          roundMs: times[mode].round.map(Math.round)
        }
      row.roundShorterBy = `${Math.round((1 - row.together.roundMedianMs / row.sequential.roundMedianMs) * 100)}%`
      results.push(row)
      console.log(JSON.stringify(row))
    }
  } finally {
    bell?.kill()
    try {
      execFileSync('ssh', ['-F', config, '-o', `ControlPath=${control}/%C`, '-O', 'exit', 'lab'], {
        stdio: 'ignore'
      })
    } catch {}
    try {
      dk(['rm', '-f', name])
    } catch {}
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(control, { recursive: true, force: true })
  }
  console.log('summary')
  for (const r of results)
    console.log(
      `+${r.rttMs} ms rtt, ${r.pulls} pulls, ${r.user}: round median one-after-another ${r.sequential.roundMedianMs} ms, together ${r.together.roundMedianMs} ms (${r.roundShorterBy} shorter); pulls alone ${r.sequential.pullsMedianMs} -> ${r.together.pullsMedianMs} ms; failed commands ${r.errors.length}; mirror in sync ${r.lastTranscriptInSync}`
    )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
