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

let onlyRealUnixToolsDir: string
let fixtures: string
let ext: 'tar.gz' | 'tar.xz'
let nodeName: string

function which(tool: string): string | null {
  const r = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

beforeAll(() => {
  onlyRealUnixToolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-onlyRealUnixToolsDir-'))
  for (const t of REAL_TOOLS) {
    const real = which(t)
    if (real) fs.symlinkSync(real, path.join(onlyRealUnixToolsDir, t))
  }

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
  fs.rmSync(onlyRealUnixToolsDir, { recursive: true, force: true })
  fs.rmSync(fixtures, { recursive: true, force: true })
})

interface Machine {
  home: string
  logs: string
  give(name: string, body: string): void
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
        env: { HOME: home, PATH: onlyRealUnixToolsDir, FIXTURES: fixtures },
        timeout: 60_000
      })
  }
}

const CURL = (exitCode = 0) => `
printf '%s\\n' "$*" >> "$LOGS/curl.log"
[ ${exitCode} != 0 ] && exit ${exitCode}
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; url="$a"; prev="$a"; done
name=\${url##*/}
[ -f "$FIXTURES/$name" ] || exit 22
cat "$FIXTURES/$name" > "$out"
exit 0`

const expectNoHomebrewRsyncThePathCannotHide = (): void => {
  expect(['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'].filter(fs.existsSync)).toEqual([])
}

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

describe('U-ENS-1..4: ensure.sh on a remote machine never sits on a hidden password prompt nor blocks a session over the statusline node', () => {
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
    const alwaysDifferentHexDigit = (c: string): string => (c === '9' ? '0' : '9')
    fs.writeFileSync(
      sums,
      fs.readFileSync(sums, 'utf8').replace(/^[0-9a-f]/gm, alwaysDifferentHexDigit)
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

  it('refreshes apt\u2019s package lists once, right before the first install: a bare Debian/Ubuntu container has none', () => {
    const m = machine()
    complete(m)
    fs.rmSync(path.join(m.home, '.local', 'bin', 'rsync'))
    m.give('id', 'echo 0')
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
    expectNoHomebrewRsyncThePathCannotHide()
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
    expectNoHomebrewRsyncThePathCannotHide()
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

  // CC§2
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
