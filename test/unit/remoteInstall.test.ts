import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

import {
  ENSURE_SH,
  NODE_VERSION,
  heartbeatCmd,
  parseHeartbeat
} from '../../src/main/remote/install'

// U-ENS-1..4. ensure.sh is what makes a bare machine usable, and it runs before EVERY
// remote session, so it is executed here for real against fake tools on PATH. Two
// things it must never do: sit on a hidden password prompt, and refuse to start a
// session just because the statusline's node could not be installed.
//
// ensure.sh sets its own PATH, putting `$HOME/.local/bin` first and the two Homebrew
// folders after it. So a tool is made PRESENT by dropping a fake into the sandbox
// home's `.local/bin`, and ABSENT by keeping it out of the little folder of real
// unix tools that is all the rest of PATH holds. `rsync` is the missing package below
// rather than tmux because this Mac has a real tmux in /opt/homebrew/bin, which no
// PATH the test controls can hide (see the guard in the tmux-less case).

const REAL_TOOLS = [
  'sh',
  'sed',
  'grep',
  'cut',
  'tr',
  'uname',
  'id',
  'mkdir',
  'rm',
  'mv',
  'ls',
  'tar',
  'cat',
  'chmod',
  'dirname',
  'basename',
  'sleep',
  'shasum',
  'env',
  'printf'
]

let sysbin: string
let fixtures: string
let ext: 'tar.gz' | 'tar.xz'
let nodeName: string

function which(tool: string): string | null {
  const r = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

beforeAll(() => {
  sysbin = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-sysbin-'))
  for (const t of REAL_TOOLS) {
    const real = which(t)
    if (real) fs.symlinkSync(real, path.join(sysbin, t))
  }

  // the node download ensure.sh verifies and unpacks. Both compressions are staged:
  // which one it asks for depends on whether the machine has `xz`.
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-nodedist-'))
  const uos = spawnSync('uname', ['-s'], { encoding: 'utf8' }).stdout.trim().toLowerCase()
  const uarch = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim()
  const arch = uarch === 'x86_64' || uarch === 'amd64' ? 'x64' : 'arm64'
  nodeName = `node-v${NODE_VERSION}-${uos}-${arch}`
  const stage = path.join(fixtures, 'stage', nodeName, 'bin')
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, 'node'), `#!/bin/sh\necho v${NODE_VERSION}\n`, { mode: 0o755 })
  const sums: string[] = []
  for (const [e, flag] of [
    ['tar.gz', '-czf'],
    ['tar.xz', '-cJf']
  ] as const) {
    const file = path.join(fixtures, `${nodeName}.${e}`)
    spawnSync('tar', [flag, file, '-C', path.join(fixtures, 'stage'), nodeName])
    const sum = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).stdout.split(' ')[0]
    sums.push(`${sum}  ${nodeName}.${e}`)
  }
  fs.writeFileSync(path.join(fixtures, 'SHASUMS256.txt'), sums.join('\n') + '\n')
  ext = which('xz') || fs.existsSync('/opt/homebrew/bin/xz') ? 'tar.xz' : 'tar.gz'
})
afterAll(() => {
  fs.rmSync(sysbin, { recursive: true, force: true })
  fs.rmSync(fixtures, { recursive: true, force: true })
})

interface Machine {
  home: string
  logs: string
  /** put a tool on the machine; `body` is the shell after the shebang */
  give(name: string, body: string): void
  /** a tool that records its arguments and exits with `code` */
  giveLogger(name: string, code?: number): void
  calls(name: string): string[]
  run(): { status: number | null; stdout: string; stderr: string }
}

function machine(): Machine {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-ens-home-'))
  const bin = path.join(home, '.local', 'bin')
  const logs = path.join(home, 'logs')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(logs)
  const script = path.join(home, 'ensure.sh')
  fs.writeFileSync(script, ENSURE_SH, { mode: 0o755 })
  const give = (name: string, body: string): void =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return {
    home,
    logs,
    give,
    giveLogger: (name, code = 0) =>
      give(name, `printf '%s\\n' "$*" >> "${logs}/${name}.log"\nexit ${code}`),
    calls: (name) => {
      const f = path.join(logs, `${name}.log`)
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
    },
    run: () =>
      spawnSync('/bin/sh', [script], {
        encoding: 'utf8',
        env: { HOME: home, PATH: sysbin, FIXTURES: fixtures },
        timeout: 60_000
      })
  }
}

/** a curl that serves the staged node dist; `exitCode` makes every fetch fail */
const CURL = (exitCode = 0) => `
printf '%s\\n' "$*" >> "$LOGS/curl.log"
[ ${exitCode} != 0 ] && exit ${exitCode}
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; url="$a"; prev="$a"; done
name=\${url##*/}
[ -f "$FIXTURES/$name" ] || exit 22
cat "$FIXTURES/$name" > "$out"
exit 0`

const NODE = (version: string) => `[ "$1" = -v ] && echo v${version}\nexit 0`

const complete = (m: Machine, opts: { node?: string; curlExit?: number } = {}): void => {
  m.give('bash', 'exit 0')
  m.give('claude', 'exit 0')
  m.give('node', NODE(opts.node ?? '22.12.0'))
  m.give('tmux', 'exit 0')
  m.give('rsync', 'exit 0')
  m.give('curl', `LOGS=${JSON.stringify(m.logs)}\n${CURL(opts.curlExit ?? 0)}`)
  m.giveLogger('sudo', 1)
  m.giveLogger('apt-get')
}

describe('ensure.sh on a remote machine', () => {
  it('a machine that already has everything installs nothing', () => {
    const m = machine()
    complete(m)
    const res = m.run()
    expect(res.status).toBe(0)
    expect(m.calls('curl')).toEqual([])
    expect(m.calls('sudo')).toEqual([])
    expect(m.calls('apt-get')).toEqual([])
  })

  it('an old node is replaced by a verified official build under ~/.koloft/node', () => {
    const m = machine()
    complete(m, { node: '18.20.4' })
    const res = m.run()
    expect(res.status).toBe(0)
    const node = path.join(m.home, '.koloft', 'node', 'bin', 'node')
    expect(fs.existsSync(node)).toBe(true)
    expect(m.calls('curl').join('\n')).toContain(
      `https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.${ext}`
    )
    expect(m.calls('curl').join('\n')).toContain('SHASUMS256.txt')
    // nothing of the download is left behind
    expect(
      fs.readdirSync(path.join(m.home, '.koloft')).filter((n) => n.startsWith('node.tmp'))
    ).toEqual([])
  })

  it('a tampered download is thrown away, and the session still starts', () => {
    const m = machine()
    complete(m, { node: '18.20.4' })
    const bad = path.join(m.home, 'dist')
    fs.mkdirSync(bad)
    for (const f of fs.readdirSync(fixtures)) {
      if (f === 'stage') continue
      fs.copyFileSync(path.join(fixtures, f), path.join(bad, f))
    }
    const sums = path.join(bad, 'SHASUMS256.txt')
    // Every line's first character has to come out DIFFERENT. Overwriting it with a
    // fixed '9' left the sum untouched whenever it already began with one — a real
    // checksum over a tarball built fresh each run, so one run in sixteen tampered with
    // nothing, the download verified, and this test failed on CI for no reason.
    fs.writeFileSync(
      sums,
      fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]/gm, (c) => (c === '9' ? '0' : '9'))
    )
    m.give('curl', `LOGS=${JSON.stringify(m.logs)}\nFIXTURES=${JSON.stringify(bad)}\n${CURL()}`)
    const res = m.run()
    expect(res.status).toBe(0)
    expect(fs.existsSync(path.join(m.home, '.koloft', 'node'))).toBe(false)
    expect(res.stdout).toContain('checksum')
    expect(res.stdout).toContain('no statusline')
  })

  it('a node download that never arrives costs the statusline, not the session', () => {
    const m = machine()
    complete(m, { node: '18.20.4', curlExit: 22 })
    const res = m.run()
    expect(res.status).toBe(0)
    expect(fs.existsSync(path.join(m.home, '.koloft', 'node'))).toBe(false)
    expect(res.stdout).toContain('no statusline')
  })

  // a bare Debian/Ubuntu container has no package lists at all, and every
  // `apt-get install` then fails on "unable to locate package"
  it('refreshes apt\u2019s package lists once, right before the first install', () => {
    const m = machine()
    complete(m)
    fs.rmSync(path.join(m.home, '.local', 'bin', 'rsync'))
    m.give('id', 'echo 0') // root: no sudo in the way
    m.run()
    expect(m.calls('apt-get')).toEqual(['update', 'install -y rsync'])
    expect(m.calls('sudo')).toEqual([])
  })

  it('asks for the lists through the same passwordless sudo as the install', () => {
    const m = machine()
    complete(m)
    fs.rmSync(path.join(m.home, '.local', 'bin', 'rsync'))
    m.giveLogger('sudo', 0)
    m.run()
    expect(m.calls('sudo')).toEqual([
      '-n true',
      '-n apt-get update',
      '-n env DEBIAN_FRONTEND=noninteractive apt-get install -y rsync'
    ])
  })

  it('with no passwordless sudo the password is asked for in the tab, and the install runs', () => {
    // ensure.sh only ever runs inside the interactive ssh tab, so a prompt there is
    // exactly where the person can type. rsync stands in for tmux here — a real
    // Homebrew tmux sits on the PATH ensure.sh builds and cannot be hidden.
    expect(['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'].filter(fs.existsSync)).toEqual([])
    const m = machine()
    complete(m)
    fs.rmSync(path.join(m.home, '.local', 'bin', 'rsync'))
    m.give(
      'sudo',
      `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(m.logs, 'sudo.log'))}
[ "$1" = -n ] && exit 1
[ "$1" = -p ] && shift 2
while [ $# -gt 0 ]; do case "$1" in env|*=*) shift ;; *) break ;; esac; done
exec "$@"`
    )
    const res = m.run()
    expect(res.status).toBe(0)
    expect(m.calls('sudo').join('\n')).toContain('sudo password')
    expect(m.calls('apt-get')).toEqual(['update', 'install -y rsync'])
    expect(res.stdout).toContain('type it below')
    expect(res.stdout).not.toContain('Run this on the machine')
  })

  it('only when the password sudo fails too is the command handed over', () => {
    expect(['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'].filter(fs.existsSync)).toEqual([])
    const m = machine()
    complete(m)
    fs.rmSync(path.join(m.home, '.local', 'bin', 'rsync'))
    const res = m.run()
    expect(res.status).not.toBe(0)
    expect(res.stdout).toContain('type it below')
    const printed = res.stdout.split('\n').find((l) => l.startsWith('  sudo '))
    expect(printed).toBe('  sudo apt-get install -y rsync')
    expect(m.calls('apt-get')).toEqual([])
  })
})

// The heartbeat is the only thing that can tell this Mac what the machine's disk looks
// like, so it is run for real here: a temp repo with one linked worktree, asked through
// the very command string that is sent over ssh.
describe('the heartbeat question', () => {
  let dir = ''
  let repo = ''
  let wt = ''

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-hb-'))
    repo = path.join(dir, 'api')
    wt = path.join(dir, 'wt-feature')
    const git = (cwd: string, ...args: string[]): void => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    }
    fs.mkdirSync(repo)
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'a@b.c')
    git(repo, 'config', 'user.name', 'a')
    fs.writeFileSync(path.join(repo, 'f'), 'x')
    git(repo, 'add', 'f')
    git(repo, 'commit', '-qm', 'one')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature')
  })

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  const ask = (paths: string[]): ReturnType<typeof parseHeartbeat> => {
    const cmd = heartbeatCmd(paths)
    const res = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    return parseHeartbeat(res.stdout)
  }

  it('answers a git checkout with its worktrees, and a plain folder with neither', () => {
    const plain = path.join(dir, 'plain')
    fs.mkdirSync(plain)
    const info = ask([repo, plain])
    expect(info.git.get(repo)?.isGit).toBe(true)
    expect(
      info.git
        .get(repo)
        ?.worktrees.map((w) => w.dir)
        .sort()
    ).toEqual([fs.realpathSync(repo), fs.realpathSync(wt)].sort())
    expect(info.git.get(repo)?.worktrees.find((w) => w.dir.endsWith('wt-feature'))?.branch).toBe(
      'feature'
    )
    expect(info.git.get(plain)).toEqual({
      isGit: false,
      worktrees: [],
      real: fs.realpathSync(plain)
    })
  })

  // claude slugs the PHYSICAL cwd (contract §2)
  it('resolves a folder reached through a symlink, and says nothing for one that is gone', () => {
    const link = path.join(dir, 'api-link')
    fs.symlinkSync(repo, link)
    expect(ask([link]).git.get(link)?.real).toBe(fs.realpathSync(repo))
    const gone = path.join(dir, 'not-here')
    expect(ask([gone]).git.get(gone)?.real).toBeUndefined()
  })

  it('reaches a folder whose path carries quotes, spaces and a dollar', () => {
    const nasty = path.join(dir, "it's $here")
    fs.mkdirSync(path.join(nasty, '.git'), { recursive: true })
    expect(ask([nasty]).git.get(nasty)?.isGit).toBe(true)
  })

  it('reads the lines before the first folder as tmux session names', () => {
    const parsed = parseHeartbeat('k-aaa\nk-bbb\n== /home/koh/api\ngit\nworktree /home/koh/api\n\n')
    expect(parsed.alive).toEqual(['k-aaa', 'k-bbb'])
    expect(parsed.git.get('/home/koh/api')?.worktrees).toEqual([{ dir: '/home/koh/api' }])
  })
})
