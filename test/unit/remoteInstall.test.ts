import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

import {
  ENSURE_SH,
  NO_FILES_THERE,
  NODE_VERSION,
  heartbeatCmd,
  parseHeartbeat
} from '../../src/main/remote/install'
import { MIN_AGY_VERSION, MIN_CLAUDE_VERSION } from '../../src/main/cliMinimums'

const REAL_TOOLS = [
  'sh',
  'sed',
  'awk',
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
  ext = which('xz') || fs.existsSync('/opt/homebrew/bin/xz') ? 'tar.xz' : 'tar.gz'
  buildNodeDist(fixtures, { [nodeName]: 'runs' })
})

function buildNodeDist(dist: string, builds: Record<string, 'runs' | 'will not run'>): void {
  const sums: string[] = []
  for (const [name, outcome] of Object.entries(builds)) {
    const stage = path.join(dist, 'stage', name, 'bin')
    fs.mkdirSync(stage, { recursive: true })
    const body = outcome === 'runs' ? `echo v${NODE_VERSION}` : 'exit 1'
    fs.writeFileSync(path.join(stage, 'node'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    const file = path.join(dist, `${name}.${ext}`)
    const flag = ext === 'tar.xz' ? '-cJf' : '-czf'
    spawnSync('tar', [flag, file, '-C', path.join(dist, 'stage'), name])
    const sum = spawnSync('shasum', ['-a', '256', file], { encoding: 'utf8' }).stdout.split(' ')[0]
    sums.push(`${sum}  ${name}.${ext}`)
  }
  fs.writeFileSync(path.join(dist, 'SHASUMS256.txt'), sums.join('\n') + '\n')
}
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
  run(arg?: string): { status: number | null; stdout: string; stderr: string }
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
    run: (arg) =>
      spawnSync('/bin/sh', [script, ...(arg ? [arg] : [])], {
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

const HOMEBREW_FETCHERS_THE_PATH_CANNOT_HIDE = [
  '/opt/homebrew/bin/curl',
  '/opt/homebrew/bin/wget',
  '/usr/local/bin/curl',
  '/usr/local/bin/wget'
].filter((f) => fs.existsSync(f))

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

  function serveNodeBuilds(m: Machine, builds: Record<string, 'runs' | 'will not run'>): void {
    const dist = path.join(m.home, 'dist')
    buildNodeDist(dist, builds)
    m.give('curl', `LOGS=${JSON.stringify(m.logs)}\nFIXTURES=${JSON.stringify(dist)}\n${CURL()}`)
  }

  const onLinuxX64 = (m: Machine): void =>
    m.give('uname', '[ "$1" = -s ] && echo Linux\n[ "$1" = -m ] && echo x86_64\nexit 0')

  // PLATFORM§37
  it('on a Linux too old for the official node build, the build for older Linux is fetched, checked and kept', () => {
    const m = machine()
    complete(m, { node: '18.20.4' })
    onLinuxX64(m)
    serveNodeBuilds(m, {
      [`node-v${NODE_VERSION}-linux-x64`]: 'will not run',
      [`node-v${NODE_VERSION}-linux-x64-glibc-217`]: 'runs'
    })

    const res = m.run()
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('no statusline')
    expect(m.calls('curl').join('\n')).toContain(
      `https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64-glibc-217.${ext}`
    )
    const node = path.join(m.home, '.koloft', 'node', 'bin', 'node')
    expect(spawnSync(node, ['-v'], { encoding: 'utf8' }).stdout.trim()).toBe(`v${NODE_VERSION}`)
    expect(
      fs.readdirSync(path.join(m.home, '.koloft')).filter((n) => n.startsWith('node.tmp'))
    ).toEqual([])
  })

  it('a machine where no node build runs is told once, keeps no node, and never fetches again', () => {
    const m = machine()
    complete(m, { node: '18.20.4' })
    onLinuxX64(m)
    serveNodeBuilds(m, {
      [`node-v${NODE_VERSION}-linux-x64`]: 'will not run',
      [`node-v${NODE_VERSION}-linux-x64-glibc-217`]: 'will not run'
    })

    const first = m.run()
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('does not run on this machine')
    expect(fs.existsSync(path.join(m.home, '.koloft', 'node'))).toBe(false)
    const fetches = m.calls('curl').length

    const second = m.run()
    expect(second.status).toBe(0)
    expect(second.stdout).not.toContain('installing node')
    expect(m.calls('curl')).toHaveLength(fetches)
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

describe.each([
  {
    product: 'Claude Code',
    tool: 'claude',
    tab: undefined,
    min: MIN_CLAUDE_VERSION,
    olderYetLaterAsText: '2.1.99',
    versionLine: '%s (Claude Code)'
  },
  {
    product: 'Antigravity CLI',
    tool: 'agy',
    tab: 'agy',
    min: MIN_AGY_VERSION,
    olderYetLaterAsText: '1.3.6',
    versionLine: '%s'
  }
])('ensure.sh holds a remote $product to the minimum this Koloft supports', (t) => {
  const toolAt = (m: Machine, version: string, updatesTo?: string): void => {
    const file = path.join(m.home, `${t.tool}-version`)
    fs.writeFileSync(file, version)
    const bump = updatesTo ? `printf '%s' ${updatesTo} > ${JSON.stringify(file)}` : ':'
    m.give(
      t.tool,
      `case "$1" in
--version) printf '${t.versionLine}\\n' "$(cat ${JSON.stringify(file)})" ;;
update) printf 'update\\n' >> ${JSON.stringify(path.join(m.logs, `${t.tool}.log`))}; ${bump} ;;
esac
exit 0`
    )
  }

  it('an older one is updated before the session starts', () => {
    const m = machine()
    complete(m)
    toolAt(m, t.olderYetLaterAsText, '99.0.0')
    const res = m.run(t.tab)
    expect(res.status).toBe(0)
    expect(m.calls(t.tool)).toEqual(['update'])
    expect(res.stderr).toContain(`older than ${t.min}`)
  })

  it(`one the update cannot lift stops the session and says to run ${t.tool} update`, () => {
    const m = machine()
    complete(m)
    toolAt(m, t.olderYetLaterAsText)
    const res = m.run(t.tab)
    expect(res.status).toBe(4)
    expect(m.calls(t.tool)).toEqual(['update'])
    expect(res.stderr).toContain(`Run "${t.tool} update" yourself`)
  })
})

describe('ensure.sh for a Muse tab', () => {
  const MUSE_INSTALLER = `
printf '%s\\n' "$*" >> "$LOGS/curl.log"
printf '%s\\n' 'printf "#!/bin/sh\\necho Muse Code 1.4.9\\n" > "$HOME/.local/bin/muse"; chmod +x "$HOME/.local/bin/muse"'`

  const forMuse = (m: Machine, python: 'runs' | 'is a stub'): void => {
    m.give('bash', 'exec /bin/bash "$@"')
    m.give('tmux', 'exit 0')
    m.give('rsync', 'exit 0')
    m.give('gh', 'exit 0')
    m.give('python3', python === 'runs' ? 'exit 0' : 'exit 1')
    m.give('curl', `LOGS=${JSON.stringify(m.logs)}\n${MUSE_INSTALLER}`)
    m.giveLogger('sudo', 1)
    m.giveLogger('apt-get')
  }

  it("installs muse with Meta's installer, and never claude or the statusline's node", () => {
    const m = machine()
    forMuse(m, 'runs')
    const res = m.run('muse')
    expect(res.status).toBe(0)
    expect(m.calls('curl')).toEqual(['-fsSL https://dev.meta.ai/install.sh'])
    expect(fs.existsSync(path.join(m.home, '.local', 'bin', 'muse'))).toBe(true)
    expect(fs.existsSync(path.join(m.home, '.koloft', 'node'))).toBe(false)
  })

  it('stops with what is missing when python3 there does not run, as the macOS stand-in does', () => {
    const m = machine()
    forMuse(m, 'is a stub')
    const res = m.run('muse')
    expect(res.status).toBe(4)
    expect(res.stdout).toContain('Muse sessions need python3 on this machine')
    expect(m.calls('curl')).toEqual([])
  })

  it.skipIf(HOMEBREW_FETCHERS_THE_PATH_CANNOT_HIDE.length > 0)(
    'on a machine with neither curl nor wget, as a bare container is, curl is installed with the package manager before the installer runs',
    () => {
      const m = machine()
      forMuse(m, 'runs')
      const curl = path.join(m.home, '.local', 'bin', 'curl')
      const packaged = path.join(m.home, 'curl-from-the-package')
      fs.renameSync(curl, packaged)
      m.give('id', 'echo 0')
      m.give(
        'apt-get',
        `printf '%s\\n' "$*" >> ${JSON.stringify(path.join(m.logs, 'apt-get.log'))}
[ "$*" = "install -y curl" ] && cat ${JSON.stringify(packaged)} > ${JSON.stringify(curl)} && chmod +x ${JSON.stringify(curl)}
exit 0`
      )
      const res = m.run('muse')
      expect(res.status).toBe(0)
      expect(m.calls('apt-get')).toEqual(['update', 'install -y curl'])
      expect(m.calls('curl')).toEqual(['-fsSL https://dev.meta.ai/install.sh'])
    }
  )

  it('a Claude tab never reaches for muse or python3', () => {
    const m = machine()
    complete(m)
    m.giveLogger('python3')
    expect(m.run().status).toBe(0)
    expect(m.calls('python3')).toEqual([])
    expect(m.calls('curl')).toEqual([])
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

  const ask = (paths: string[], watched: string[] = []): ReturnType<typeof parseHeartbeat> => {
    const cmd = heartbeatCmd(paths, watched)
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

  // CC§2
  it("tells the machine's resolved /tmp and its user id, where claude keeps each session's scratchpad", () => {
    expect(ask([]).tmp).toEqual({ tmpRoot: fs.realpathSync('/tmp'), uid: process.getuid!() })
  })

  it("on Linux claude's scratchpad base follows CLAUDE_CODE_TMPDIR, then TMPDIR, as the Linux build reads os.tmpdir()", () => {
    const fakeBin = path.join(dir, 'linux-bin')
    fs.mkdirSync(fakeBin)
    fs.writeFileSync(path.join(fakeBin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
    const tmpdir = path.join(dir, 'tmpdir')
    const ccTmp = path.join(dir, 'cc-tmp')
    fs.mkdirSync(tmpdir)
    fs.mkdirSync(ccTmp)
    const onLinux = (env: Record<string, string>): string | undefined => {
      const res = spawnSync('sh', ['-c', heartbeatCmd([])], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env }
      })
      return parseHeartbeat(res.stdout).tmp?.tmpRoot
    }
    expect(onLinux({ TMPDIR: tmpdir })).toBe(fs.realpathSync(tmpdir))
    expect(onLinux({ TMPDIR: tmpdir, CLAUDE_CODE_TMPDIR: ccTmp })).toBe(fs.realpathSync(ccTmp))
  })

  it('stamps every watched file and folder in the order asked, a missing one with an empty stamp, and still answers the folders', () => {
    const file = path.join(dir, 'watched.txt')
    fs.writeFileSync(file, 'abc')
    const info = ask([repo], [file, path.join(dir, 'gone.txt'), repo])
    expect(info.stamps).toHaveLength(3)
    expect(info.stamps[0]).toMatch(/^\d+\.\d+ 3$/)
    expect(info.stamps[1]).toBe('')
    expect(info.stamps[2]).toMatch(/^\d+\.\d+ \d+$/)
    expect(info.git.get(repo)?.isGit).toBe(true)
  })

  // PLATFORM§34 PLATFORM§37
  it("stamps the workspace's transcripts and the hook folder as wholes: an append, a same-size rewrite within one second, a new or a removed file each change the stamp, another project's files never do", () => {
    const home = path.join(dir, 'home')
    const projects = path.join(home, '.claude', 'projects')
    const hookDir = path.join(home, '.koloft', 'hook-sessions')
    const mine = path.join(projects, '-home-koh-api')
    const other = path.join(projects, '-srv-www')
    for (const d of [path.join(mine, 's1', 'subagents'), other, hookDir])
      fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(mine, 's1.jsonl'), 'a\n')
    fs.writeFileSync(path.join(mine, 's1', 'subagents', 'x.jsonl'), 'a\n')
    fs.writeFileSync(path.join(other, 's3.jsonl'), 'a\n')
    fs.writeFileSync(path.join(hookDir, 't1.json'), '{"event":"stop"}')
    const mirrors = (): ReturnType<typeof parseHeartbeat>['mirrors'] => {
      const res = spawnSync('sh', ['-c', heartbeatCmd([], [], ['-home-koh-api'])], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })
      expect(res.status).toBe(0)
      return parseHeartbeat(res.stdout).mirrors
    }
    const hook = path.join(hookDir, 't1.json')
    fs.utimesSync(hook, 1_700_000_000.25, 1_700_000_000.25)
    const first = mirrors()
    expect(first.transcripts).toMatch(/^\d+ \d+$/)
    expect(first.hooks).toMatch(/^\d+ \d+$/)

    fs.appendFileSync(path.join(other, 's3.jsonl'), 'b\n')
    fs.writeFileSync(path.join(projects, 'stray.jsonl'), 'a\n')
    expect(mirrors()).toEqual(first)

    fs.appendFileSync(path.join(mine, 's1', 'subagents', 'x.jsonl'), 'b\n')
    const appended = mirrors()
    expect(appended.transcripts).not.toBe(first.transcripts)
    expect(appended.hooks).toBe(first.hooks)

    fs.writeFileSync(hook, '{"event":"ask"}X')
    fs.utimesSync(hook, 1_700_000_000.5, 1_700_000_000.5)
    const rewritten = mirrors()
    expect(rewritten.hooks).not.toBe(appended.hooks)
    expect(rewritten.transcripts).toBe(appended.transcripts)

    fs.writeFileSync(path.join(hookDir, 't2.status.jsonl'), 'x\n')
    const added = mirrors()
    expect(added.hooks).not.toBe(rewritten.hooks)
    fs.rmSync(path.join(hookDir, 't2.status.jsonl'))
    expect(mirrors().hooks).not.toBe(added.hooks)
  }, 120_000)

  it('stamps each extra folder it is asked to mirror under the home, one line apiece in the order asked, so a change in one leaves the others and the workspace folders as they were', () => {
    const home = path.join(dir, 'home')
    const brain = path.join(home, '.gemini', 'antigravity', 'brain', 'c1')
    const other = path.join(home, 'other')
    const workspace = path.join(home, 'api')
    for (const d of [brain, other, workspace]) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(brain, 'transcript.jsonl'), 'a\n')
    fs.writeFileSync(path.join(other, 'x'), 'a\n')
    const beat = (): ReturnType<typeof parseHeartbeat> => {
      const res = spawnSync(
        'sh',
        ['-c', heartbeatCmd([workspace], [], [], ['.gemini/antigravity/brain', 'other', 'gone'])],
        { encoding: 'utf8', env: { ...process.env, HOME: home } }
      )
      expect(res.status).toBe(0)
      return parseHeartbeat(res.stdout)
    }
    const first = beat()
    expect(first.mirrors.extras).toHaveLength(3)
    expect(first.mirrors.extras[2]).toBe(NO_FILES_THERE)
    expect(first.alive).toEqual([])
    expect([...first.git.keys()]).toEqual([workspace])

    fs.appendFileSync(path.join(brain, 'transcript.jsonl'), 'b\n')
    const after = beat().mirrors.extras
    expect(after[0]).not.toBe(first.mirrors.extras[0])
    expect(after.slice(1)).toEqual(first.mirrors.extras.slice(1))
  }, 120_000)

  it('says "no files there" for the transcripts of a machine that never ran a Claude Code session, so they are not copied, while Koloft’s own hook folder is made and always stamped, so its copy still shows a shell that breaks rsync', () => {
    const home = fs.mkdtempSync(path.join(dir, 'bare-home-'))
    const res = spawnSync('sh', ['-c', heartbeatCmd([], [], ['-home-koh-api'])], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home }
    })
    expect(res.status).toBe(0)
    const mirrors = parseHeartbeat(res.stdout).mirrors
    expect(mirrors.transcripts).toBe(NO_FILES_THERE)
    expect(mirrors.hooks).toMatch(/^\d+ \d+$/)
    expect(fs.existsSync(path.join(home, '.koloft', 'hook-sessions'))).toBe(true)
  })

  it('still stamps transcripts once the folder is there but every transcript was deleted, so the copy with --delete drops them here too', () => {
    const home = fs.mkdtempSync(path.join(dir, 'emptied-home-'))
    fs.mkdirSync(path.join(home, '.claude', 'projects', '-home-koh-api'), { recursive: true })
    const res = spawnSync('sh', ['-c', heartbeatCmd([], [], ['-home-koh-api'], ['brain'])], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home }
    })
    expect(res.status).toBe(0)
    const mirrors = parseHeartbeat(res.stdout).mirrors
    expect(mirrors.transcripts).toMatch(/^\d+ \d+$/)
    expect(mirrors.extras).toEqual([NO_FILES_THERE])
  })

  it('reads the lines before the first folder as tmux session names, never a stamp line', () => {
    const parsed = parseHeartbeat(
      'stamp 1.5 3\nstamp \nk-aaa\nk-bbb\n== /home/koh/api\ngit\nworktree /home/koh/api\n\n'
    )
    expect(parsed.stamps).toEqual(['1.5 3', ''])
    expect(parsed.alive).toEqual(['k-aaa', 'k-bbb'])
    expect(parsed.git.get('/home/koh/api')?.worktrees).toEqual([{ dir: '/home/koh/api' }])
  })
})
