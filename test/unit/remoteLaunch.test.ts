import { describe, it, expect, afterAll } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

import {
  accountEnv,
  buildMachinePackage,
  killSessionCmd,
  launchLine,
  tabScript,
  writeTabPackage,
  type TabSpec
} from '../../src/main/remote/launch'
import { TMUX_CONF, heartbeatCmd } from '../../src/main/remote/install'

const PLAINEST_SHELL_THE_LINE_MUST_SURVIVE = fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh'
const tmpRoots: string[] = []
const mkroot = (tag: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `koloft-${tag}-`))
  tmpRoots.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true })
})

interface Remote {
  dir: string
  machineHome: string
  fail(call: number, code: number): void
  argv(call: number): string[]
  calls(): number
  bin: string
}

const FISH_LOGIN_SHELL = `#!/bin/sh
dry=""
[ "$1" = -n ] && { dry=1; shift; }
bare=$(printf '%s' "$2" | sed "s/'[^']*'//g")
case "$bare" in *'export '*|*'{ '*|*'; }'*|*'$$'*) echo "fish: not fish syntax: $2" >&2; exit 2;; esac
[ -n "$dry" ] && exit 0
exec sh -c "$2"
`

function writeFishLoginShell(bin: string): string {
  const fish = path.join(bin, 'fish')
  fs.writeFileSync(fish, FISH_LOGIN_SHELL, { mode: 0o755 })
  return fish
}

function remote(): Remote {
  const dir = mkroot('ssh')
  fs.mkdirSync(path.join(dir, 'n'))
  fs.mkdirSync(path.join(dir, 'machine'))
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin)
  writeFishLoginShell(bin)
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    `#!/bin/sh
D=${JSON.stringify(dir)}
n=1
while ! mkdir "$D/n/$n" 2>/dev/null; do n=$((n+1)); done
last=""
for a in "$@"; do last="$a"; done
printf '%s\\n' "$@" > "$D/log.$n"
[ -f "$D/exit.$n" ] && exit "$(cat "$D/exit.$n")"
[ "$1" = -tt ] && exec "$D/bin/fish" -n -c "$last"
exec env HOME="$D/machine" "$D/bin/fish" -c "$last"
`,
    { mode: 0o755 }
  )
  return {
    dir,
    bin,
    machineHome: path.join(dir, 'machine'),
    fail: (call, code) => fs.writeFileSync(path.join(dir, `exit.${call}`), String(code)),
    argv: (call) =>
      fs
        .readFileSync(path.join(dir, `log.${call}`), 'utf8')
        .trim()
        .split('\n'),
    calls: () => fs.readdirSync(path.join(dir, 'n')).length
  }
}

const SSH_LINK_BROKE_EXIT = 255

const koloft = (r: Remote, ...rest: string[]): string =>
  path.join(r.machineHome, '.koloft', ...rest)

function typeLine(r: Remote, line: string): { status: number | null; stdout: string } {
  const script = path.join(mkroot('line'), 'line.sh')
  fs.writeFileSync(script, line + '\n')
  const res = spawnSync(PLAINEST_SHELL_THE_LINE_MUST_SURVIVE, [script], {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: `${r.bin}:/usr/bin:/bin` },
    timeout: 60_000
  })
  return { status: res.status, stdout: res.stdout }
}

function typeLineLive(
  r: Remote,
  line: string
): { out: () => string; running: () => boolean; enter: () => void; done: Promise<number | null> } {
  const script = path.join(mkroot('line'), 'line.sh')
  fs.writeFileSync(script, line + '\n')
  const c = spawn(PLAINEST_SHELL_THE_LINE_MUST_SURVIVE, [script], {
    env: { HOME: process.env.HOME, PATH: `${r.bin}:/usr/bin:/bin`, TERM: 'xterm' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  let alive = true
  c.stdout.on('data', (d) => (out += String(d)))
  const done = new Promise<number | null>((resolve) =>
    c.on('close', (code) => {
      alive = false
      resolve(code)
    })
  )
  return { out: () => out, running: () => alive, enter: () => c.stdin.write('\n'), done }
}

async function until(pred: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

const spec = (over: Partial<TabSpec> = {}): TabSpec => ({
  tabId: 'T',
  tmuxName: 'k-sess1',
  machineName: 'm-0000000000000000',
  cwd: '/tmp',
  banner: 'koloft: bravo',
  settings: { hooks: {} },
  claudeArgs: ['--session-id', 'sess1'],
  ...over
})

function stage(r: Remote, files: Record<string, string | Buffer>, s: TabSpec) {
  const pkg = buildMachinePackage(path.join(r.dir, 'pkg'), files)
  const tabDir = path.join(r.dir, 'tabs', s.tabId)
  writeTabPackage(tabDir, { ...s, machineName: pkg.name })
  return {
    pkg,
    tabDir,
    line: (mode: 'start' | 'attach' = 'start') =>
      launchLine({
        host: 'dev.box',
        sshOptions: ['-o', 'ControlPath=/tmp/koloft-1/%C'],
        machine: pkg,
        tabDir,
        tabId: s.tabId,
        mode
      })
  }
}

describe('U-LINE-*: the launch line', () => {
  it('pushes the machine package once, the tab package always, then runs the tab script, never letting ssh eat the terminal keystrokes', () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'echo hi\n', 'theme.json': '{}' }, spec())
    const first = typeLine(r, st.line())

    expect(first.status).toBe(0)
    expect(r.calls()).toBe(4)
    expect(r.argv(1)).toContain('-n')
    expect(r.argv(1).at(-1)).toContain('test -d')
    expect(fs.readFileSync(koloft(r, st.pkg.name, 'run.sh'), 'utf8')).toBe('echo hi\n')
    expect(fs.readFileSync(koloft(r, 'tabs', 'T.sh'), 'utf8')).toContain('new-session')
    expect(r.argv(4)).toContain('-tt')
    expect(r.argv(4).at(-1)).toContain(`T.sh" start`)
    const credentialTabPackageLeftOnThisDisk = fs.existsSync(st.tabDir)
    expect(credentialTabPackageLeftOnThisDisk).toBe(false)

    const st2 = stage(r, { 'run.sh': 'echo hi\n', 'theme.json': '{}' }, spec({ tabId: 'T2' }))
    const again = typeLine(r, st2.line())
    expect(again.status).toBe(0)
    expect(r.calls()).toBe(7)
    expect(r.argv(5).at(-1)).toContain('test -d')
    expect(r.argv(6).at(-1)).toContain('tar xf')
    expect(r.argv(6).at(-1)).toContain('tabs')
    expect(r.argv(7)).toContain('-tt')
  })

  // PLATFORM§3
  it('pushes no macOS AppleDouble twins along with the packages', () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'echo hi\n' }, spec())
    for (const f of [path.join(st.pkg.dir, 'run.sh'), path.join(st.tabDir, 'T.json')]) {
      spawnSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:x', 'y', f])
    }
    const line = st.line()
    expect(line.match(/COPYFILE_DISABLE=1 tar cf -/g)?.length).toBe(2)

    expect(typeLine(r, line).status).toBe(0)
    expect(fs.readdirSync(koloft(r, st.pkg.name)).filter((n) => n.startsWith('._'))).toEqual([])
    expect(fs.readdirSync(koloft(r, 'tabs')).filter((n) => n.startsWith('._'))).toEqual([])
  })

  it('stops when a push fails — never a bare login shell dressed up as Claude', () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    r.fail(3, 1)
    const res = typeLine(r, st.line())
    expect(res.status).toBe(4)
    expect(res.stdout).toContain('[Koloft]')
    expect(r.calls()).toBe(3)
    expect(fs.existsSync(st.tabDir)).toBe(false)
  })

  it("reconnects only on ssh’s own link-broke code, turning claude's mouse and paste modes off before the notice, and reconnecting attaches", () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    r.fail(4, SSH_LINK_BROKE_EXIT)
    const res = typeLine(r, st.line())
    expect(res.status).toBe(0)
    expect(r.calls()).toBe(5)
    expect(r.argv(5).at(-1)).toContain(`T.sh" attach`)
    expect(res.stdout).toContain('\u001b[?1000l')
    expect(res.stdout).toContain('\u001b[?2004l')
    expect(res.stdout.indexOf('\u001b[?1000l')).toBeLessThan(
      res.stdout.indexOf('connection lost, reconnecting')
    )
  }, 20_000)

  it('a Claude that exits on its own ends the line with Claude’s code', () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    r.fail(4, 7)
    const res = typeLine(r, st.line())
    expect(res.status).toBe(7)
    expect(r.calls()).toBe(4)
  })

  it('a start that failed holds the tab open until Enter, so its reason can be read', async () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    r.fail(4, 7)
    const live = typeLineLive(r, st.line())
    expect(await until(() => live.out().includes('did not start (exit 7)'))).toBe(true)
    expect(live.out()).toContain('press Enter to close')
    await new Promise((res) => setTimeout(res, 300))
    expect(live.running()).toBe(true)
    live.enter()
    expect(await live.done).toBe(7)
  }, 30_000)

  it('an account name full of quotes reaches the machine unharmed', () => {
    const r = remote()
    const banner = `koloft: it's "me" \`x\` $HOME`
    const st = stage(r, { 'run.sh': 'x' }, spec({ banner }))
    const res = typeLine(r, st.line())
    expect(res.status).toBe(0)
    const echo = fs
      .readFileSync(koloft(r, 'tabs', 'T.sh'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('echo '))!
    expect(spawnSync('/bin/sh', ['-c', echo], { encoding: 'utf8' }).stdout).toBe(banner + '\n')
  })

  it('two tabs pushing the same package at once leave one whole copy and no scraps', async () => {
    const r = remote()
    const big = crypto.randomBytes(3 * 1024 * 1024)
    const files = { 'run.sh': 'x', 'ccstatusline.js': big }
    const a = stage(r, files, spec({ tabId: 'A' }))
    const b = stage(r, files, spec({ tabId: 'B' }))
    expect(a.pkg.name).toBe(b.pkg.name)

    const both = [a, b].map((st) => {
      const script = path.join(mkroot('line'), 'line.sh')
      fs.writeFileSync(script, st.line() + '\n')
      return new Promise<number | null>((resolve) => {
        const c = spawn(PLAINEST_SHELL_THE_LINE_MUST_SURVIVE, [script], {
          env: { HOME: process.env.HOME, PATH: `${r.bin}:/usr/bin:/bin` },
          stdio: 'ignore'
        })
        c.on('close', (code) => resolve(code))
      })
    })
    expect(await Promise.all(both)).toEqual([0, 0])

    const entries = fs.readdirSync(koloft(r)).sort()
    expect(entries.filter((e) => e.startsWith('m.tmp'))).toEqual([])
    expect(entries.filter((e) => e.startsWith('m-'))).toEqual([a.pkg.name])
    expect(fs.readFileSync(koloft(r, a.pkg.name, 'ccstatusline.js')).equals(big)).toBe(true)
  }, 60_000)
})

interface Box {
  home: string
  tabs: string
  logs: string
  env(): Record<string, string>
  argv(): string[]
  tmux(): string[]
  ensured(): boolean
  claudeCalls(): string[][]
  envAt(n: number): Record<string, string>
  tabEnvSeenAt(n: number): boolean
  order(): string[]
  run(arg?: string): { status: number | null; stdout: string }
}

function box(s: TabSpec, opts: { ensureExit?: number } = {}): Box {
  const home = mkroot('tabhome')
  const bin = path.join(home, '.local', 'bin')
  const logs = path.join(home, 'logs')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(logs)
  const m = path.join(home, '.koloft', s.machineName)
  fs.mkdirSync(m, { recursive: true })
  fs.writeFileSync(path.join(m, 'tmux.conf'), TMUX_CONF)
  fs.writeFileSync(
    path.join(m, 'ensure.sh'),
    `#!/bin/sh\n: > ${JSON.stringify(path.join(logs, 'ensure'))}\nexit ${opts.ensureExit ?? 0}\n`,
    { mode: 0o755 }
  )

  // PLATFORM§35
  fs.writeFileSync(
    path.join(bin, 'tmux'),
    `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(path.join(logs, 'tmux'))}
printf 'tmux %s\\n' "$*" >> ${JSON.stringify(path.join(logs, 'order'))}
conf=""; prev=""; last=""
for a in "$@"; do [ "$prev" = -f ] && conf="$a"; last="$a"; prev="$a"; done
case " $* " in *" new-session "*) ;; *) exit 0;; esac
grep -q 'default-shell /bin/sh' "$conf" && exec sh -c "$last"
exec "$SHELL" -c "$last"
`,
    { mode: 0o755 }
  )
  writeFishLoginShell(bin)
  fs.mkdirSync(path.join(logs, 'c'))
  const tabs = path.join(home, '.koloft', 'tabs')
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
L=${JSON.stringify(logs)}
n=1
while ! mkdir "$L/c/$n" 2>/dev/null; do n=$((n+1)); done
env > "$L/env.$n"
printf '%s\\n' "$@" > "$L/argv.$n"
[ -f ${JSON.stringify(path.join(tabs, `${s.tabId}.env`))} ] && : > "$L/tabenv.$n"
printf 'claude %s\\n' "$*" >> "$L/order"
env > "$L/env"
printf '%s\\n' "$@" > "$L/argv"
exit 0
`,
    { mode: 0o755 }
  )

  writeTabPackage(tabs, s)
  const read = (n: string): string => fs.readFileSync(path.join(logs, n), 'utf8')
  const envOf = (n: string): Record<string, string> =>
    Object.fromEntries(
      read(n)
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    )
  return {
    home,
    tabs,
    logs,
    env: () => envOf('env'),
    argv: () => read('argv').trim().split('\n'),
    claudeCalls: () =>
      fs
        .readdirSync(logs)
        .filter((n) => n.startsWith('argv.'))
        .sort()
        .map((n) => read(n).trim().split('\n')),
    envAt: (n) => envOf(`env.${n}`),
    tabEnvSeenAt: (n) => fs.existsSync(path.join(logs, `tabenv.${n}`)),
    order: () => (fs.existsSync(path.join(logs, 'order')) ? read('order').trim().split('\n') : []),
    tmux: () => (fs.existsSync(path.join(logs, 'tmux')) ? read('tmux').trim().split('\n') : []),
    ensured: () => fs.existsSync(path.join(logs, 'ensure')),
    run: (arg) => {
      const res = spawnSync('/bin/sh', [path.join(tabs, `${s.tabId}.sh`), ...(arg ? [arg] : [])], {
        encoding: 'utf8',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          SHELL: path.join(bin, 'fish'),
          ANTHROPIC_API_KEY: 'stale-machine-key'
        },
        timeout: 30_000
      })
      return { status: res.status, stdout: res.stdout }
    }
  }
}

function claudeEnvOf(s: TabSpec): Record<string, string> {
  const b = box(s)
  b.run()
  return b.env()
}

describe('U-TAB-*: the tab script on the machine', () => {
  it('falls back to the workspace root when the recorded directory is gone, so a resume into a removed worktree still opens', () => {
    const root = mkroot('root')
    const s = spec({ cwd: path.join(root, '.claude', 'worktrees', 'gone'), fallbackCwd: root })
    const b = box(s)
    expect(b.run().status).toBe(0)
    expect(b.env().PWD).toBe(root)
  })

  it('starts claude inside tmux with the picked account, and eats the credential file', () => {
    const cwd = path.join(mkroot('cwd'), "it's here")
    fs.mkdirSync(cwd, { recursive: true })
    const s = spec({
      cwd,
      env: accountEnv('oauth', 'bravo', 'sk-ant-oat01-remote')
    })
    const b = box(s)
    const res = b.run()

    expect(res.status).toBe(0)
    expect(b.tmux().join(' ')).toContain('new-session -A -D -s k-sess1')
    const env = b.env()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-remote')
    expect(env.ANT_ACCOUNT).toBe('bravo')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.PWD).toBe(cwd)
    expect(b.argv()).toEqual([
      '--settings',
      `${b.home}/.koloft/tabs/T.json`,
      '--session-id',
      'sess1'
    ])
    expect(fs.existsSync(path.join(b.tabs, 'T.env'))).toBe(false)
    expect(res.stdout).toContain('koloft: bravo')
  })

  it('hands claude the -w name for a worktree session', () => {
    const b = box(spec({ claudeArgs: ['--session-id', 'sess1', '-w', 'my.feature-1'] }))
    expect(b.run().status).toBe(0)
    expect(b.argv().slice(-3)).toEqual(['sess1', '-w', 'my.feature-1'])
  })

  it('a reconnect attaches to the running session and installs nothing', () => {
    const b = box(spec())
    const res = b.run('attach')
    expect(res.status).toBe(0)
    expect(b.tmux()).toEqual(['-L', 'koloft', 'attach', '-d', '-t', 'k-sess1'])
    expect(b.ensured()).toBe(false)
  })

  it("clears the tab's leftover hook reports before starting, since tab ids are reused across Koloft runs, but not on a reconnect", () => {
    const b = box(spec())
    const hooks = path.join(b.home, '.koloft', 'hook-sessions')
    fs.mkdirSync(hooks, { recursive: true })
    const stale = [path.join(hooks, 'T.json'), path.join(hooks, 'T.status.jsonl')]
    for (const f of stale) fs.writeFileSync(f, '{"event":"end"}\n')
    expect(b.run().status).toBe(0)
    expect(stale.map((f) => fs.existsSync(f))).toEqual([false, false])

    for (const f of stale) fs.writeFileSync(f, '{"event":"start"}\n')
    b.run('attach')
    expect(stale.map((f) => fs.existsSync(f))).toEqual([true, true])
  })

  // CC§10
  it("skips claude's first-run login page when Koloft brought the login", () => {
    const withLogin = (): TabSpec => spec({ env: accountEnv('oauth', 'bravo', 'sk-ant-oat01-x') })
    const cj = (b: Box): string => path.join(b.home, '.claude.json')

    const fresh = box(withLogin())
    expect(fresh.run().status).toBe(0)
    expect(JSON.parse(fs.readFileSync(cj(fresh), 'utf8'))).toEqual({ hasCompletedOnboarding: true })

    const used = box(withLogin())
    fs.writeFileSync(cj(used), '{\n  "numStartups": 3,\n  "userID": "u1"\n}\n')
    expect(used.run().status).toBe(0)
    expect(JSON.parse(fs.readFileSync(cj(used), 'utf8'))).toEqual({
      hasCompletedOnboarding: true,
      numStartups: 3,
      userID: 'u1'
    })
    expect(fs.existsSync(cj(used) + '.koloft-bak')).toBe(false)

    const own = box(spec())
    expect(own.run().status).toBe(0)
    expect(fs.existsSync(cj(own))).toBe(false)
  })

  // CC§10
  it("warms claude's server-side settings once, with the account, on a machine that has never run it", () => {
    const b = box(spec({ env: accountEnv('oauth', 'bravo', 'sk-ant-oat01-warm') }))
    const res = b.run()

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('first run on this machine')
    expect(b.claudeCalls()[0]).toEqual(['-p', 'ok', '--max-turns', '1'])
    expect(b.claudeCalls()).toHaveLength(2)
    expect(b.order()[0]).toMatch(/^claude /)
    expect(b.order().find((l) => l.includes('new-session'))).toBeTruthy()
    expect(b.order().findIndex((l) => l.startsWith('claude '))).toBeLessThan(
      b.order().findIndex((l) => l.includes('new-session'))
    )
    expect(b.envAt(1).CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-warm')
    expect(b.tabEnvSeenAt(1)).toBe(true)
    expect(fs.existsSync(path.join(b.tabs, 'T.env'))).toBe(false)
  })

  it('does not warm settings a second time on a machine that already has them', () => {
    const b = box(spec({ env: accountEnv('oauth', 'bravo', 'sk-ant-oat01-warm') }))
    fs.writeFileSync(
      path.join(b.home, '.claude.json'),
      '{"hasCompletedOnboarding":true,"cachedGrowthBookFeatures":{}}\n'
    )
    const res = b.run()
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('first run on this machine')
    expect(b.claudeCalls()).toHaveLength(1)
    expect(b.claudeCalls()[0]).toContain('--settings')
  })

  it('with the balancer off there is no account to warm settings with', () => {
    const b = box(spec())
    const res = b.run()
    expect(res.status).toBe(0)
    expect(res.stdout).not.toContain('first run on this machine')
    expect(b.claudeCalls()).toHaveLength(1)
  })

  // CC§1
  it("tells the hook to rename the tmux session after claude's own id, which an in-TUI /clear changes", () => {
    expect(claudeEnvOf(spec()).KOLOFT_TMUX_FOLLOW).toBe('1')
  })

  it('a machine that could not be prepared never reaches tmux', () => {
    const b = box(spec(), { ensureExit: 4 })
    const res = b.run()
    expect(res.status).toBe(4)
    expect(b.tmux()).toEqual([])
  })

  it('with the balancer off nothing about an account is sent', () => {
    const b = box(spec({ banner: 'koloft: this machine’s own login' }))
    const res = b.run()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('own login')
    const env = b.env()
    for (const k of Object.keys(env)) expect(k).not.toMatch(/^ANTHROPIC_|^CLAUDE_CODE_OAUTH/)
    expect(env.ANT_ACCOUNT).toBeUndefined()
    expect(fs.existsSync(path.join(b.tabs, 'T.env'))).toBe(false)
  })

  it('refuses to build a script around anything the shell could read as syntax', () => {
    expect(() => tabScript(spec({ claudeArgs: ['--task', '; rm -rf /'] }))).toThrow()
    expect(() => tabScript(spec({ tmuxName: "k-'; id #" }))).toThrow()
  })

  it('the kill command names the tmux session, which outlives an in-TUI /clear', () => {
    expect(killSessionCmd('k-sess1')).toContain('kill-session -t k-sess1')
  })
})

describe('remote commands under a fish login shell', () => {
  it("every remote command string — the launch line's ssh commands, the heartbeat and the kill — still works when the remote login shell is fish: no bare export, { } or $$ outside sh -c", () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    expect(typeLine(r, st.line()).status).toBe(0)
    expect(r.calls()).toBe(4)

    const machineHome = mkroot('fishhome')
    const machineBin = path.join(machineHome, '.local', 'bin')
    fs.mkdirSync(machineBin, { recursive: true })
    const tmuxLog = path.join(machineHome, 'tmux.log')
    fs.writeFileSync(
      path.join(machineBin, 'tmux'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}\n`,
      { mode: 0o755 }
    )
    const fish = writeFishLoginShell(mkroot('fishbin'))
    const loginShell = (cmd: string): ReturnType<typeof spawnSync> =>
      spawnSync(fish, ['-c', cmd], {
        encoding: 'utf8',
        env: { HOME: machineHome, PATH: '/usr/bin:/bin' },
        timeout: 30_000
      })

    const kill = loginShell(killSessionCmd('k-sess1'))
    expect(kill.stderr).toBe('')
    expect(kill.status).toBe(0)
    expect(fs.readFileSync(tmuxLog, 'utf8')).toContain('kill-session -t k-sess1')

    const heartbeat = loginShell(heartbeatCmd([machineHome]))
    expect(heartbeat.stderr).toBe('')
    expect(heartbeat.status).toBe(0)
    expect(heartbeat.stdout).toContain(`== ${machineHome}`)
  }, 60_000)
})

describe('U-ENV-1: what a tab sends about the account', () => {
  it('carries the same variables the local shim exports, per account kind', () => {
    expect(Object.keys(accountEnv('oauth', 'bravo', 't')).sort()).toEqual([
      'ANT_ACCOUNT',
      'CLAUDE_CODE_OAUTH_TOKEN'
    ])
    expect(Object.keys(accountEnv('apikey', 'api-main', 't')).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANT_ACCOUNT'
    ])
    const custom = accountEnv('custom', 'zhipu', 't', {
      baseUrl: 'https://example.test/api/anthropic',
      model: 'glm-5.2'
    })
    expect(Object.keys(custom).sort()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_MODEL',
      'ANT_ACCOUNT',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL_FORCE'
    ])
    expect(custom.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.2')
    expect(custom.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe('1')
    expect(
      Object.keys(accountEnv('custom', 'p', 't', { baseUrl: 'https://p.test' })).sort()
    ).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANT_ACCOUNT'])
  })

  it('lands on disk readable by nobody else, quotes and all', () => {
    const dir = path.join(mkroot('pkg'), 'tabs')
    const s = spec({ env: accountEnv('apikey', "it's me", 'sk-ant-api03-x') })
    writeTabPackage(dir, s)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(dir, 'T.env')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'T.json')).mode & 0o777).toBe(0o600)
    const line = spawnSync(
      '/bin/sh',
      ['-c', `set -a; . "${path.join(dir, 'T.env')}"; printf '%s' "$ANT_ACCOUNT"`],
      { encoding: 'utf8' }
    )
    expect(line.stdout).toBe("it's me")
  })
})
