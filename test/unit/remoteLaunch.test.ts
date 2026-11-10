import { describe, it, expect, afterAll } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

import {
  accountEnv,
  buildMachinePackage,
  claudeTabSpec,
  killSessionCmd,
  launchLine,
  skillsFromMachineLine,
  machineToolProgram,
  tabScript,
  utilShellLine,
  writeTabPackage,
  type ClaudeTab,
  type TabSpec
} from '../../src/main/remote/launch'
import { TMUX_CONF, heartbeatCmd } from '../../src/main/remote/install'
import { museRunLines } from '../../src/main/museRemote'
import { STATUS_RELAY_FILE, STATUS_RELAY_PY } from '../../src/main/remote/statusRelay'
import { MUSE_SANDBOX_CANNOT_START } from '../../src/main/museSandbox'
import { AGY_KEY_FROM_KOLOFT, agyTab } from '../../src/main/remote/agyTab'

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
  greet(text: string): void
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
[ -f "$D/greeting" ] && cat "$D/greeting"
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
    greet: (text) => fs.writeFileSync(path.join(dir, 'greeting'), `${text}\n`),
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

function typeLineWithStdinOpen(
  r: Remote,
  line: string
): { out: () => string; done: Promise<number | null> } {
  const script = path.join(mkroot('line'), 'line.sh')
  fs.writeFileSync(script, line + '\n')
  const c = spawn(PLAINEST_SHELL_THE_LINE_MUST_SURVIVE, [script], {
    env: { HOME: process.env.HOME, PATH: `${r.bin}:/usr/bin:/bin`, TERM: 'xterm' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  c.stdout.on('data', (d) => (out += String(d)))
  const done = new Promise<number | null>((resolve) => c.on('close', resolve))
  return { out: () => out, done }
}

const spec = ({
  settings = { hooks: {} },
  claudeArgs = ['--session-id', 'sess1'],
  agentPlugin,
  trustFolder,
  program,
  ...over
}: Partial<TabSpec & ClaudeTab> = {}): TabSpec => {
  const tab = {
    tabId: 'T',
    tmuxName: 'k-sess1',
    machineName: 'm-0000000000000000',
    cwd: '/tmp',
    banner: 'koloft: bravo',
    ...over
  }
  return program
    ? { ...tab, program }
    : claudeTabSpec(tab, { settings, claudeArgs, agentPlugin, trustFolder })
}

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
  it('once the machine package is on the machine, a tab takes one ssh to push its package and one to run; before that the machine package goes first and the tab package after it, every ssh before the run reading a pipe and never the terminal keystrokes', () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'echo hi\n', 'theme.json': '{}' }, spec())
    const first = typeLine(r, st.line())

    expect(first.status).toBe(0)
    expect(r.calls()).toBe(4)
    expect(r.argv(2).at(-1)).toContain(st.pkg.name)
    expect(fs.readFileSync(koloft(r, st.pkg.name, 'run.sh'), 'utf8')).toBe('echo hi\n')
    expect(r.argv(3).at(-1)).toContain('tar xf - -C "$HOME/.koloft/tabs"')
    expect(fs.readFileSync(koloft(r, 'tabs', 'T.sh'), 'utf8')).toContain('new-session')
    expect(r.argv(4)).toContain('-tt')
    expect(r.argv(4).at(-1)).toContain(`T.sh" start`)
    expect(first.stdout).not.toContain('koloft-tab-in')
    const credentialTabPackageLeftOnThisDisk = fs.existsSync(st.tabDir)
    expect(credentialTabPackageLeftOnThisDisk).toBe(false)
    expect(
      st.line().match(/\| ssh /g)?.length,
      'every ssh before the tab script takes a tar on its input'
    ).toBe(3)

    const st2 = stage(r, { 'run.sh': 'echo hi\n', 'theme.json': '{}' }, spec({ tabId: 'T2' }))
    const again = typeLine(r, st2.line())
    expect(again.status).toBe(0)
    expect(r.calls()).toBe(6)
    expect(r.argv(5).at(-1)).toContain('tar xf - -C "$HOME/.koloft/tabs"')
    expect(fs.existsSync(koloft(r, 'tabs', 'T2.sh'))).toBe(true)
    expect(r.argv(6)).toContain('-tt')
  })

  it('on a machine whose login shell prints a greeting, the tab still starts and the machine package goes over only once', () => {
    const r = remote()
    r.greet('Welcome to the box')
    const st = stage(r, { 'run.sh': 'x' }, spec())
    expect(typeLine(r, st.line()).status).toBe(0)
    expect(r.calls()).toBe(4)
    const st2 = stage(r, { 'run.sh': 'x' }, spec({ tabId: 'T2' }))
    expect(typeLine(r, st2.line()).status).toBe(0)
    expect(r.calls()).toBe(6)
  })

  // PLATFORM§3
  it('pushes no macOS AppleDouble twins along with the packages, and no extended-attribute headers that GNU tar on the machine would warn about for each file', () => {
    const r = remote()
    const pushed = path.join(r.dir, 'pushed')
    fs.mkdirSync(pushed)
    fs.writeFileSync(
      path.join(r.bin, 'tar'),
      `#!/bin/sh\ncase "$1" in x*) tee "${pushed}/$$" | /usr/bin/tar "$@";; *) exec /usr/bin/tar "$@";; esac\n`,
      { mode: 0o755 }
    )
    const st = stage(r, { 'run.sh': 'echo hi\n' }, spec())
    for (const f of [path.join(st.pkg.dir, 'run.sh'), path.join(st.tabDir, 'T.json')]) {
      expect(spawnSync('/usr/bin/xattr', ['-w', 'com.apple.metadata:x', 'y', f]).status).toBe(0)
    }
    const line = st.line()
    expect(line.match(/COPYFILE_DISABLE=1 tar cz?f -/g)?.length).toBe(
      line.match(/tar cz?f -/g)?.length
    )

    expect(typeLine(r, line).status).toBe(0)
    expect(fs.readdirSync(koloft(r, st.pkg.name)).filter((n) => n.startsWith('._'))).toEqual([])
    expect(fs.readdirSync(koloft(r, 'tabs')).filter((n) => n.startsWith('._'))).toEqual([])
    const streams = fs
      .readdirSync(pushed)
      .map(
        (f) =>
          spawnSync('/usr/bin/gzip', ['-dcf'], { input: fs.readFileSync(path.join(pushed, f)) })
            .stdout
      )
    expect(streams.map((s) => ['run.sh', 'T.json'].filter((n) => s.includes(n))).sort()).toEqual([
      ['T.json'],
      ['run.sh']
    ])
    for (const s of streams) expect(s.includes('LIBARCHIVE.xattr')).toBe(false)
  })

  it('stops when a push fails — never a bare login shell dressed up as Claude, and never leaving the tab package with its credentials on a machine whose package did not arrive', () => {
    for (const failing of [2, 3]) {
      const r = remote()
      const st = stage(r, { 'run.sh': 'x' }, spec({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }))
      r.fail(failing, 1)
      const res = typeLine(r, st.line())
      expect(res.status).toBe(4)
      expect(res.stdout).toContain('[Koloft]')
      expect(r.calls()).toBe(failing)
      expect(fs.existsSync(st.tabDir)).toBe(false)
      expect(fs.existsSync(koloft(r, 'tabs', 'T.env'))).toBe(false)
    }
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

  it('a session that failed to start or ended with an error says its exit code and ends at once, waiting for no key, since Koloft keeps the tab and its screen', async () => {
    const r = remote()
    const st = stage(r, { 'run.sh': 'x' }, spec())
    r.fail(4, 7)
    const live = typeLineWithStdinOpen(r, st.line())
    expect(await live.done).toBe(7)
    expect(live.out()).toContain('stopped with exit code 7')
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

describe('the Workbench shell of a remote session', () => {
  const shellLine = (r: Remote): string =>
    utilShellLine({
      host: 'dev.box',
      sshOptions: ['-o', 'ControlPath=/tmp/koloft-1/%C'],
      machine: buildMachinePackage(path.join(r.dir, 'pkg'), {
        'util.sh':
          'echo "shell up in $1 for $2"\nexit "$(cat "$HOME/shell-exit" 2>/dev/null || echo 0)"\n'
      }),
      tabId: 'W',
      dir: "/srv/it's here"
    })

  it('opens with its one ssh once the machine package is there, even where the login shell prints a greeting; on a machine without it, the package goes over once and the shell opens after', () => {
    const r = remote()
    r.greet('Welcome to the box')
    const first = typeLine(r, shellLine(r))
    expect(first.status).toBe(0)
    expect(first.stdout).toContain("shell up in /srv/it's here for W")
    expect(r.calls()).toBe(4)

    const again = typeLine(r, shellLine(r))
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("shell up in /srv/it's here for W")
    expect(r.calls()).toBe(5)
  })

  it('a shell the owner ends with the same code Koloft uses for a missing package just ends, with nothing sent and no second shell', () => {
    const r = remote()
    typeLine(r, shellLine(r))
    const opened = r.calls()
    fs.writeFileSync(path.join(r.machineHome, 'shell-exit'), '97')
    const res = typeLine(r, shellLine(r))
    expect(res.status).toBe(97)
    expect(res.stdout.match(/shell up/g)).toHaveLength(1)
    expect(r.calls()).toBe(opened + 2)
  })

  it('stops with a word from Koloft when the machine package cannot be sent', () => {
    const r = remote()
    r.fail(3, 1)
    const res = typeLine(r, shellLine(r))
    expect(res.status).toBe(4)
    expect(res.stdout).toContain('[Koloft] could not connect')
    expect(r.calls()).toBe(3)
  })
})

interface Box {
  home: string
  tabs: string
  logs: string
  env(): Record<string, string>
  argv(): string[]
  tmux(): string[]
  ensured(): boolean
  onATerminal(): boolean
  claudeCalls(): string[][]
  envAt(n: number): Record<string, string>
  tabEnvSeenAt(n: number): boolean
  order(): string[]
  standIn(): string[]
  run(...args: string[]): { status: number | null; stdout: string }
}

function box(
  s: TabSpec,
  opts: { ensureExit?: number; claudeExit?: number; ensureBringsNode?: boolean } = {}
): Box {
  const home = mkroot('tabhome')
  const bin = path.join(home, '.local', 'bin')
  const logs = path.join(home, 'logs')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(logs)
  const m = path.join(home, '.koloft', s.machineName)
  fs.mkdirSync(m, { recursive: true })
  fs.writeFileSync(path.join(m, 'tmux.conf'), TMUX_CONF)
  fs.writeFileSync(path.join(m, STATUS_RELAY_FILE), STATUS_RELAY_PY)
  fs.writeFileSync(
    path.join(m, 'ensure.sh'),
    `#!/bin/sh\n: > ${JSON.stringify(path.join(logs, 'ensure'))}\n${
      opts.ensureBringsNode
        ? `mkdir -p "$HOME/.koloft/node/bin" && ln -s ${JSON.stringify(process.execPath)} "$HOME/.koloft/node/bin/node"\n`
        : ''
    }exit ${opts.ensureExit ?? 0}\n`,
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
case " $* " in *" capture-pane "*) printf 'the last screen\\n\\n\\n'; exit 0;; esac
case " $* " in *" new-session "*) ;; *) exit 0;; esac
if grep -q 'default-shell /bin/sh' "$conf"; then sh -c "$last"; else "$SHELL" -c "$last"; fi
exit 0
`,
    { mode: 0o755 }
  )
  writeFishLoginShell(bin)
  fs.writeFileSync(
    path.join(bin, 'script'),
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(path.join(logs, 'script'))}
exec sh -c "$2" 2>/dev/null
`,
    { mode: 0o755 }
  )
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
[ -t 0 ] && : > "$L/tty"
exit ${opts.claudeExit ?? 0}
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
    onATerminal: () => fs.existsSync(path.join(logs, 'tty')),
    standIn: () =>
      fs.existsSync(path.join(logs, 'script')) ? read('script').trim().split('\n') : [],
    run: (...args) => {
      const res = spawnSync('/bin/sh', [path.join(tabs, `${s.tabId}.sh`), ...args], {
        encoding: 'utf8',
        env: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          SHELL: path.join(bin, 'fish'),
          ANTHROPIC_API_KEY: 'stale-machine-key',
          GEMINI_API_KEY: 'stale-machine-key'
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

const SKILLS_IN_A_MACHINE_PACKAGE = {
  'agent-plugin/skills/koloft/SKILL.md': 'NEW',
  'docs-plugin/skills/koloft-docs/SKILL.md': 'NEW DOCS',
  'docs-plugin/skills/koloft-docs/references/core.md': 'NEW CORE'
}

function putSkillsInMachinePackage(machineDir: string): void {
  for (const [rel, text] of Object.entries(SKILLS_IN_A_MACHINE_PACKAGE)) {
    fs.mkdirSync(path.dirname(path.join(machineDir, rel)), { recursive: true })
    fs.writeFileSync(path.join(machineDir, rel), text)
  }
}

describe("Koloft's skills a Codex, Muse or Antigravity tab keeps in its home on the machine", () => {
  it('keeps the koloft-docs skill folder the same as the machine package every time, and the koloft skill only while agent tools are on: an older copy is swapped for a whole new one with nothing left over, and a copy already the same is left in place, so a running agent never finds it gone', () => {
    const root = mkroot('skill')
    const machineDir = path.join(root, 'm-1')
    const skills = path.join(root, 'home', 'skills')
    buildMachinePackage(root, SKILLS_IN_A_MACHINE_PACKAGE)
    const pkg = fs.readdirSync(root).find((n) => n.startsWith('m-'))!
    fs.renameSync(path.join(root, pkg), machineDir)
    for (const old of ['koloft/SKILL.md', 'koloft/old.md', 'koloft-docs/references/old.md']) {
      fs.mkdirSync(path.dirname(path.join(skills, old)), { recursive: true })
      fs.writeFileSync(path.join(skills, old), 'OLD')
    }
    const run = (line: string): number | null =>
      spawnSync(PLAINEST_SHELL_THE_LINE_MUST_SURVIVE, ['-c', line]).status
    const read = (rel: string): string => fs.readFileSync(path.join(skills, rel), 'utf8')
    expect(run(skillsFromMachineLine(skills, machineDir, true))).toBe(0)
    expect(read('koloft/SKILL.md')).toBe('NEW')
    expect(fs.readdirSync(path.join(skills, 'koloft'))).toEqual(['SKILL.md'])
    expect(read('koloft-docs/references/core.md')).toBe('NEW CORE')
    expect(fs.readdirSync(path.join(skills, 'koloft-docs', 'references'))).toEqual(['core.md'])
    const docsFolder = fs.statSync(path.join(skills, 'koloft-docs')).ino
    expect(run(skillsFromMachineLine(skills, machineDir, false))).toBe(0)
    expect(fs.existsSync(path.join(skills, 'koloft'))).toBe(false)
    expect(read('koloft-docs/SKILL.md')).toBe('NEW DOCS')
    expect(read('koloft-docs/references/core.md')).toBe('NEW CORE')
    expect(fs.statSync(path.join(skills, 'koloft-docs')).ino).toBe(docsFolder)
    expect(fs.readdirSync(skills).sort()).toEqual(['koloft-docs'])
  })
})

describe('U-TAB-*: the tab script on the machine', () => {
  it('falls back to the workspace root when the recorded directory is gone, so a resume into a removed worktree still opens', () => {
    const root = mkroot('root')
    const s = spec({ cwd: path.join(root, '.claude', 'worktrees', 'gone'), fallbackCwd: root })
    const b = box(s)
    expect(b.run().status).toBe(0)
    expect(b.env().PWD).toBe(root)
  })

  it('starts claude inside tmux with the picked account and, with agent tools off, only the koloft-docs skill from the machine package, and eats the credential file', () => {
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
      '--plugin-dir',
      `${b.home}/.koloft/m-0000000000000000/docs-plugin/`,
      '--session-id',
      'sess1'
    ])
    expect(fs.existsSync(path.join(b.tabs, 'T.env'))).toBe(false)
    expect(res.stdout).toContain('koloft: bravo')
  })

  // CC§12
  it.skipIf(spawnSync('python3', ['-c', 'import pty, termios']).status !== 0)(
    "claude runs on a terminal of the status relay's, and where python3 cannot run (macOS's stub without the developer tools) it starts on its own instead",
    () => {
      const relayed = box(spec())
      expect(relayed.run().status).toBe(0)
      expect(relayed.onATerminal()).toBe(true)

      const stub = box(spec())
      fs.writeFileSync(path.join(stub.home, '.local', 'bin', 'python3'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755
      })
      expect(stub.run().status).toBe(0)
      expect(stub.onATerminal()).toBe(false)
      expect(stub.argv()[0]).toBe('--settings')
    }
  )

  it("hands claude the -w name and the worktree's port offset for a worktree session, and no offset to any other", () => {
    const b = box(
      spec({ claudeArgs: ['--session-id', 'sess1', '-w', 'my.feature-1'], portOffset: 42 })
    )
    expect(b.run().status).toBe(0)
    expect(b.argv().slice(-3)).toEqual(['sess1', '-w', 'my.feature-1'])
    expect(b.env().KOLOFT_PORT_OFFSET).toBe('42')
    expect(claudeEnvOf(spec()).KOLOFT_PORT_OFFSET).toBeUndefined()
  })

  it("with agent tools on, claude gets Koloft's skill and Koloft's prompt from the machine package next to the koloft-docs skill it always gets, and finds the machine's playwright-cli, then its koloft, first on its PATH, told which tab it runs in", () => {
    const b = box(spec({ agentPlugin: true }))
    expect(b.run().status).toBe(0)
    const m = `${b.home}/.koloft/m-0000000000000000`
    expect(b.argv().slice(0, 8)).toEqual([
      '--settings',
      `${b.home}/.koloft/tabs/T.json`,
      '--plugin-dir',
      `${m}/docs-plugin/`,
      '--plugin-dir',
      `${m}/agent-plugin/`,
      '--append-system-prompt-file',
      `${m}/agent-plugin/koloft-prompt.md`
    ])
    expect(b.env().PATH.split(':').slice(0, 2)).toEqual([`${m}/claude-bin/`, `${m}/bin/`])
    expect(b.env().KOLOFT_TAB_ID).toBe('T')
  })

  it("a Muse tab moves the carried credential into its account's folder on the machine, links the machine user's own Muse settings and trust there even before that user has them (muse writes through the link), drops an AGENTS.md link whose file is gone, runs muse through the wrapper with no playwright-cli of Koloft's on its PATH (only Claude Code tabs on a machine drive the Workbench browser), and a reconnect attaches by the name the wrapper last gave the tmux session", () => {
    const s = spec({
      tmuxName: 'm-T',
      program: machineToolProgram(
        'muse',
        museRunLines({
          tabId: 'T',
          account: "o'brien",
          args: ['--approval-judge', 'off', 'say hi'],
          sandboxed: false,
          trust: [],
          koloftSkill: false
        }),
        { 'T.auth.json': '{"providers":{}}', 'T.hooks.json': '{"hooks":{}}' }
      )
    })
    const b = box(s)
    const own = path.join(b.home, '.config', 'muse')
    fs.mkdirSync(own, { recursive: true })
    fs.writeFileSync(path.join(own, 'settings.json'), '{"schema_version":1}')
    const accountMuse = path.join(b.home, '.koloft', 'muse-homes', "o'brien", 'muse')
    fs.mkdirSync(accountMuse, { recursive: true })
    fs.symlinkSync(path.join(own, 'AGENTS.md'), path.join(accountMuse, 'AGENTS.md'))
    fs.writeFileSync(
      path.join(b.home, '.local', 'bin', 'python3'),
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(b.logs, 'env'))}\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(b.logs, 'argv'))}\n`,
      { mode: 0o755 }
    )
    expect(b.run().status).toBe(0)
    expect(b.tmux().join(' ')).toContain('new-session -A -D -s m-T')
    const m = path.join(b.home, '.koloft', 'm-0000000000000000')
    expect(b.argv()).toEqual([
      `${m}/muse-wrap.py`,
      `${b.home}/.koloft/hook-sessions`,
      'T',
      '--',
      'muse',
      '--approval-judge',
      'off',
      'say hi'
    ])
    const account = path.join(b.home, '.koloft', 'muse-homes', "o'brien")
    expect(b.env()).toMatchObject({
      XDG_CONFIG_HOME: account,
      TBH_CREDENTIAL_BACKEND: 'file',
      TBH_MANAGED_HOOKS_PATH: `${b.home}/.koloft/tabs/T.hooks.json`
    })
    expect(b.env().PATH).not.toContain('claude-bin')
    expect(fs.readFileSync(path.join(account, 'muse', 'auth.json'), 'utf8')).toBe(
      '{"providers":{}}'
    )
    expect(fs.statSync(path.join(account, 'muse', 'auth.json')).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(b.tabs, 'T.auth.json'))).toBe(false)
    expect(fs.readlinkSync(path.join(account, 'muse', 'settings.json'))).toBe(
      path.join(own, 'settings.json')
    )
    expect(fs.readlinkSync(path.join(account, 'muse', 'trust.json'))).toBe(
      path.join(own, 'trust.json')
    )
    expect(fs.lstatSync(path.join(account, 'muse', 'AGENTS.md'), { throwIfNoEntry: false })).toBe(
      undefined
    )
    fs.writeFileSync(path.join(b.tabs, 'T.tmux'), 'k-sess9')
    b.run('attach')
    expect(b.tmux().slice(-7)).toEqual(['-L', 'koloft', '-u', 'attach', '-d', '-t', 'k-sess9'])
  })

  // MUSE§16
  it("a Muse tab copies Koloft's skills from the machine package into its account's own skills folder, where a same-named skill of the machine user's never takes their place while the user's other skills are still linked in: koloft-docs every time, koloft only while agent tools are on", () => {
    const muse = (koloftSkill: boolean): TabSpec =>
      spec({
        tmuxName: 'm-T',
        program: machineToolProgram(
          'muse',
          museRunLines({
            tabId: 'T',
            account: 'a',
            args: [],
            sandboxed: false,
            trust: [],
            koloftSkill
          }),
          { 'T.hooks.json': '{"hooks":{}}' }
        )
      })
    const b = box(muse(true))
    putSkillsInMachinePackage(path.join(b.home, '.koloft', 'm-0000000000000000'))
    const owners = path.join(b.home, '.config', 'muse', 'skills')
    for (const skill of ['review', 'koloft-docs'])
      fs.mkdirSync(path.join(owners, skill), { recursive: true })
    fs.writeFileSync(path.join(b.home, '.local', 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 })
    const skills = path.join(b.home, '.koloft', 'muse-homes', 'a', 'muse', 'skills')
    expect(b.run().status).toBe(0)
    expect(fs.readFileSync(path.join(skills, 'koloft', 'SKILL.md'), 'utf8')).toBe('NEW')
    writeTabPackage(b.tabs, muse(false))
    expect(b.run().status).toBe(0)
    expect(fs.existsSync(path.join(skills, 'koloft'))).toBe(false)
    expect(fs.lstatSync(path.join(skills, 'koloft-docs')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(skills, 'koloft-docs', 'references', 'core.md'), 'utf8')).toBe(
      'NEW CORE'
    )
    expect(fs.readlinkSync(path.join(skills, 'review'))).toBe(path.join(owners, 'review'))
  })

  // MUSE§17
  it('a Muse tab on a machine where no user namespace can be made says why its sandbox cannot start only when Muse runs with its sandbox, not when permission prompts are skipped', () => {
    const said = (sandboxed: boolean): string => {
      const b = box(
        spec({
          tmuxName: 'm-T',
          program: machineToolProgram(
            'muse',
            museRunLines({
              tabId: 'T',
              account: 'a',
              args: [],
              sandboxed,
              trust: [],
              koloftSkill: false
            }),
            {}
          )
        })
      )
      for (const [name, text] of [
        ['unshare', 'exit 1'],
        ['python3', 'exit 0']
      ])
        fs.writeFileSync(path.join(b.home, '.local', 'bin', name), `#!/bin/sh\n${text}\n`, {
          mode: 0o755
        })
      const res = b.run()
      expect(res.status).toBe(0)
      return res.stdout
    }
    expect(said(true)).toContain(MUSE_SANDBOX_CANNOT_START)
    expect(said(false)).not.toContain(MUSE_SANDBOX_CANNOT_START)
  })

  it("an Antigravity tab puts Koloft's settings, hooks and carried sign-in into its account's folder on the machine, links the machine user's own conversations there, runs agy with Koloft's API key and never the machine's own, and a reconnect attaches by the name agy's title script gave the tmux session", () => {
    const tabFiles = {
      'T.settings.json': '{"koloft":1}',
      'T.hooks.json': '{"hooks":{}}',
      'T.auth.json': 'oauth-token'
    }
    const s = spec({
      tmuxName: 'm-T-t',
      env: { [AGY_KEY_FROM_KOLOFT]: 'koloft-key' },
      program: agyTab({
        tabId: 'T',
        account: "o'brien",
        args: ['--csrf_token=x', 'say hi'],
        settings: tabFiles['T.settings.json'],
        hooks: tabFiles['T.hooks.json'],
        token: tabFiles['T.auth.json'],
        koloftSkill: false
      })
    })
    const b = box(s)
    fs.writeFileSync(
      path.join(b.home, '.local', 'bin', 'agy'),
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(b.logs, 'env'))}\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(b.logs, 'argv'))}\n`,
      { mode: 0o755 }
    )
    expect(b.run().status).toBe(0)
    expect(b.tmux().join(' ')).toContain('new-session -A -D -s m-T-t')
    const account = path.join(b.home, '.koloft', 'agy', "o'brien")
    expect(b.argv()).toEqual([`--gemini_dir=${account}`, '--csrf_token=x', 'say hi'])
    expect(b.env().GEMINI_API_KEY).toBe('koloft-key')
    expect(b.env()[AGY_KEY_FROM_KOLOFT]).toBeUndefined()
    expect(b.env().KOLOFT_AGY_LOG).toBe(`${b.home}/.koloft/hook-sessions/T.agy.jsonl`)
    const app = path.join(account, 'antigravity-cli')
    expect(fs.readFileSync(path.join(app, 'settings.json'), 'utf8')).toBe('{"koloft":1}')
    expect(fs.readFileSync(path.join(account, 'config', 'hooks.json'), 'utf8')).toBe('{"hooks":{}}')
    expect(fs.readFileSync(path.join(app, 'antigravity-oauth-token'), 'utf8')).toBe('oauth-token')
    for (const name of Object.keys(tabFiles))
      expect(fs.existsSync(path.join(b.tabs, name))).toBe(false)
    expect(fs.readlinkSync(path.join(app, 'conversations'))).toBe(
      `${b.home}/.gemini/antigravity-cli/conversations`
    )
    fs.writeFileSync(path.join(b.tabs, 'T.tmux'), 'k-sess9')
    b.run('attach')
    expect(b.tmux().slice(-7)).toEqual(['-L', 'koloft', '-u', 'attach', '-d', '-t', 'k-sess9'])
  })

  it("an Antigravity tab started without an API key runs agy without the machine's own key", () => {
    const b = box(
      spec({
        program: agyTab({
          tabId: 'T',
          account: 'a',
          args: [],
          settings: '{}',
          hooks: '{}',
          koloftSkill: false
        })
      })
    )
    fs.writeFileSync(
      path.join(b.home, '.local', 'bin', 'agy'),
      `#!/bin/sh\nenv > ${JSON.stringify(path.join(b.logs, 'env'))}\n`,
      { mode: 0o755 }
    )
    expect(b.run().status).toBe(0)
    expect(b.env().GEMINI_API_KEY).toBeUndefined()
  })

  // AGY§29 PLATFORM§35
  it.skipIf(spawnSync('python3', ['-c', 'import pty, termios']).status !== 0)(
    "agy runs on a terminal of the status relay's, so its redraws pass tmux before 3.7 as whole frames, and where python3 cannot run it starts on its own instead",
    () => {
      const agyIn = (b: Box): void =>
        fs.writeFileSync(
          path.join(b.home, '.local', 'bin', 'agy'),
          `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(path.join(b.logs, 'argv'))}\n[ -t 0 ] && : > ${JSON.stringify(path.join(b.logs, 'tty'))}\nexit 0\n`,
          { mode: 0o755 }
        )
      const agySpec = (): TabSpec =>
        spec({
          program: agyTab({
            tabId: 'T',
            account: 'a',
            args: ['--csrf_token=x'],
            settings: '{}',
            hooks: '{}',
            koloftSkill: false
          })
        })
      const relayed = box(agySpec())
      agyIn(relayed)
      expect(relayed.run().status).toBe(0)
      expect(relayed.onATerminal()).toBe(true)
      expect(relayed.argv()[1]).toBe('--csrf_token=x')

      const stub = box(agySpec())
      agyIn(stub)
      fs.writeFileSync(path.join(stub.home, '.local', 'bin', 'python3'), '#!/bin/sh\nexit 1\n', {
        mode: 0o755
      })
      expect(stub.run().status).toBe(0)
      expect(stub.onATerminal()).toBe(false)
      expect(stub.argv()[1]).toBe('--csrf_token=x')
    }
  )

  it('the tab ends with the code the agent exited with inside tmux, though tmux itself always exits 0, and shows the screen the agent left when that code is not 0', () => {
    const failed = box(spec(), { claudeExit: 3 }).run()
    expect(failed.status).toBe(3)
    expect(failed.stdout).toMatch(/the last screen\n$/)
    const clean = box(spec()).run()
    expect(clean.status).toBe(0)
    expect(clean.stdout).not.toContain('the last screen')
  })

  it('an agent that exits 255 ends the tab with 254, since 255 from ssh means the link broke and the tab would reconnect', () => {
    expect(box(spec(), { claudeExit: 255 }).run().status).toBe(254)
  })

  // CC§4 PLATFORM§35
  it("a reconnect turns on the pane title and the agent's status passthrough for a tmux started by an older Koloft, attaches to the running session and installs nothing", () => {
    const b = box(spec())
    const res = b.run('attach')
    expect(res.status).toBe(0)
    expect(b.tmux()).toEqual([
      ...['-L', 'koloft', 'set', '-gq', 'set-titles', 'on', ';'],
      ...['set', '-gq', 'set-titles-string', '#{pane_title}', ';'],
      ...['set', '-gq', 'allow-passthrough', 'on'],
      ...['-L', 'koloft', '-u', 'attach', '-d', '-t', 'k-sess1']
    ])
    expect(b.ensured()).toBe(false)
  })

  it("on a machine whose ssh gives the command no terminal, a start and a reconnect each run inside a stand-in terminal of the tab's size, where tmux can open", () => {
    const b = box(spec())
    expect(b.run('start', '120', '40').status).toBe(0)
    expect(b.standIn().join(' ')).toContain('stty cols 120 rows 40')
    expect(b.tmux().join(' ')).toContain('new-session -A -D -s k-sess1')
    expect(b.env().TERM).toBe('xterm-256color')

    b.run('attach', '90', '30')
    expect(b.standIn().join(' ')).toContain('stty cols 90 rows 30')
    expect(b.tmux().slice(-7)).toEqual(['-L', 'koloft', '-u', 'attach', '-d', '-t', 'k-sess1'])
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

  // CC§9 ADR-0026
  it('a tab told to trust its folder writes the trust under the real path with the node ensure.sh brought, keeping what .claude.json had, even for a repo inside a trusted folder, since trust stops at the repo top; a tab not told to leaves it alone', () => {
    const parent = mkroot('trust')
    const repo = path.join(parent, 'repo')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    const real = fs.realpathSync(repo)
    const seeded = JSON.stringify({
      numStartups: 3,
      projects: { [path.dirname(real)]: { hasTrustDialogAccepted: true } }
    })
    const cj = (b: Box): string => path.join(b.home, '.claude.json')
    const trusting = box(spec({ cwd: repo, trustFolder: true }), { ensureBringsNode: true })
    fs.writeFileSync(cj(trusting), seeded)
    expect(trusting.run().status).toBe(0)
    expect(JSON.parse(fs.readFileSync(cj(trusting), 'utf8'))).toEqual({
      numStartups: 3,
      projects: {
        [path.dirname(real)]: { hasTrustDialogAccepted: true },
        [real]: { hasTrustDialogAccepted: true }
      }
    })
    expect(trusting.claudeCalls()).toHaveLength(1)

    const plain = box(spec({ cwd: repo }), { ensureBringsNode: true })
    fs.writeFileSync(cj(plain), seeded)
    expect(plain.run().status).toBe(0)
    expect(fs.readFileSync(cj(plain), 'utf8')).toBe(seeded)
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

  // CC§9
  it("hands claude a job's name and first prompt word for word, quotes and shell syntax included, and refuses a session name the shell could read as syntax", () => {
    const args = [
      '--session-id',
      'sess1',
      '--name',
      "Bob's nightly",
      '--',
      '/report; rm -rf / $HOME'
    ]
    const b = box(spec({ claudeArgs: args }))
    expect(b.run().status).toBe(0)
    expect(b.argv().slice(-args.length)).toEqual(args)
    expect(() => tabScript(spec({ tmuxName: "k-'; id #" }))).toThrow()
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
