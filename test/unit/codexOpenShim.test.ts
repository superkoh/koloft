import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { removeOpenShim, writeOpenShim, type OpenShim } from '../../src/main/openShimScript'

let base: string
let cwd: string
let recordingRealOpenDir: string
let shim: OpenShim

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-cxopen-')))
  cwd = path.join(base, 'repo')
  fs.mkdirSync(cwd)
  fs.writeFileSync(path.join(cwd, 'page.html'), '<h1>page</h1>\n')
  fs.writeFileSync(path.join(cwd, 'data.xyz'), 'nope\n')
  recordingRealOpenDir = path.join(base, 'real')
  fs.mkdirSync(recordingRealOpenDir)
  fs.writeFileSync(
    path.join(recordingRealOpenDir, 'open'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$ARGS_OUT"\nexit 0\n',
    { mode: 0o755 }
  )
  shim = writeOpenShim(path.join(base, 'codex-open'), randomUUID(), undefined)
})

afterEach(() => {
  if (fs.existsSync(shim.requestDir)) fs.chmodSync(shim.requestDir, 0o700)
  removeOpenShim(shim)
  fs.rmSync(base, { recursive: true, force: true })
})

function runShim(args: string[]): { stdout: string; drops: unknown[]; realArgs: string[] | null } {
  const argsOut = path.join(base, 'args-out')
  fs.rmSync(argsOut, { force: true })
  const res = spawnSync(path.join(shim.shimDir, 'open'), args, {
    cwd,
    env: {
      PATH: [shim.shimDir, recordingRealOpenDir, '/usr/bin', '/bin'].join(':'),
      PWD: cwd,
      ARGS_OUT: argsOut
    },
    encoding: 'utf8'
  })
  expect(res.status).toBe(0)
  const drops = fs.existsSync(shim.requestDir)
    ? fs
        .readdirSync(shim.requestDir)
        .map((f) => JSON.parse(fs.readFileSync(path.join(shim.requestDir, f), 'utf8')))
    : []
  const realArgs = fs.existsSync(argsOut)
    ? fs.readFileSync(argsOut, 'utf8').split('\n').filter(Boolean)
    : null
  return { stdout: res.stdout, drops, realArgs }
}

describe('Codex open shim', () => {
  it('asks Koloft to show a viewable file, says so on its output, and never runs the real open', () => {
    const { stdout, drops, realArgs } = runShim(['page.html'])
    expect(stdout.trim()).toBe('koloft-open:sent')
    expect(realArgs).toBeNull()
    expect(drops).toEqual([
      expect.objectContaining({ path: path.join(cwd, 'page.html'), url: '', cwd })
    ])
  })

  it('asks Koloft to show an http page the same way', () => {
    const { stdout, drops, realArgs } = runShim(['http://localhost:5173/a'])
    expect(stdout.trim()).toBe('koloft-open:sent')
    expect(realArgs).toBeNull()
    expect(drops).toEqual([expect.objectContaining({ url: 'http://localhost:5173/a', path: '' })])
  })

  it('when the sandbox lets it write nowhere it says it was blocked and still never runs the real open', () => {
    fs.chmodSync(shim.requestDir, 0o555)
    const { stdout, drops, realArgs } = runShim(['page.html'])
    expect(stdout.trim()).toBe('koloft-open:blocked')
    expect(realArgs).toBeNull()
    expect(drops).toEqual([])
  })

  it('passes anything it does not show to the real open, with the exact arguments', () => {
    for (const args of [['data.xyz'], ['-a', 'Safari', 'page.html'], ['missing.html']]) {
      const { stdout, drops, realArgs } = runShim(args)
      expect(realArgs, args.join(' ')).toEqual(args)
      expect(stdout, args.join(' ')).toBe('')
      expect(drops, args.join(' ')).toEqual([])
    }
  })

  it('passes everything to the real open once Koloft has removed the request folder', () => {
    fs.rmSync(shim.requestDir, { recursive: true })
    const { realArgs } = runShim(['page.html'])
    expect(realArgs).toEqual(['page.html'])
  })
})

describe('Codex open shim dotfile folder', () => {
  it("puts the shim first in a zsh login shell after the user's own profile has run, from $HOME or from the user's own ZDOTDIR", () => {
    for (const own of ['home', 'zdotdir'] as const) {
      const home = path.join(base, `home-${own}`)
      const userDir = own === 'home' ? home : path.join(base, 'user-zdotdir')
      fs.mkdirSync(userDir, { recursive: true })
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(
        path.join(userDir, '.zprofile'),
        `export PATH="${path.join(base, 'user-bin')}:$PATH"\n`
      )
      const run = writeOpenShim(
        path.join(base, `codex-open-${own}`),
        randomUUID(),
        own === 'zdotdir' ? userDir : undefined
      )
      try {
        const res = spawnSync('/bin/zsh', ['-lc', 'command -v open; printf "%s\\n" "$PATH"'], {
          env: { HOME: home, PATH: '/usr/bin:/bin', ZDOTDIR: run.zdotDir },
          encoding: 'utf8'
        })
        const [openPath, pathLine] = res.stdout.trim().split('\n')
        expect(openPath, own).toBe(path.join(run.shimDir, 'open'))
        expect(pathLine.split(':'), own).toContain(path.join(base, 'user-bin'))
      } finally {
        removeOpenShim(run)
      }
    }
  })

  it("keeps the shim first whatever the user's ~/.zshenv does to ZDOTDIR and however their later files reorder PATH, and runs their files from the folder zsh itself would, with ZDOTDIR as zsh would leave it", () => {
    const cases = [
      { zshenv: 'ZDOTDIR="${ZDOTDIR:-$HOME/.config/zsh}"', dir: '.config/zsh', saw: '.config/zsh' },
      { zshenv: 'unset ZDOTDIR', dir: '', saw: '(unset)' }
    ]
    for (const [i, { zshenv, dir, saw }] of cases.entries()) {
      const home = path.join(base, `home-own-zshenv-${i}`)
      fs.mkdirSync(path.join(home, dir), { recursive: true })
      fs.writeFileSync(path.join(home, '.zshenv'), `${zshenv}\n`)
      fs.writeFileSync(
        path.join(home, dir, '.zprofile'),
        `export PATH="${path.join(base, 'user-bin')}:$PATH"\nexport ZPROFILE_SAW="\${ZDOTDIR-(unset)}"\n`
      )
      fs.writeFileSync(path.join(home, dir, '.zlogin'), 'export PATH="/usr/bin:/bin:$PATH"\n')
      const res = spawnSync(
        '/bin/zsh',
        ['-lc', 'command -v open; printf "%s\\n" "$PATH" "$ZPROFILE_SAW"'],
        { env: { HOME: home, PATH: '/usr/bin:/bin', ZDOTDIR: shim.zdotDir }, encoding: 'utf8' }
      )
      const [openPath, pathLine, zprofileSaw] = res.stdout.trim().split('\n')
      expect(openPath, zshenv).toBe(path.join(shim.shimDir, 'open'))
      expect(pathLine.split(':'), zshenv).toContain(path.join(base, 'user-bin'))
      expect(zprofileSaw, zshenv).toBe(saw === '(unset)' ? saw : path.join(home, saw))    }
  })
})

describe('Codex open shim BASH_ENV file', () => {
  function bash(flag: '-lc' | '-c', home: string): string[] {
    const res = spawnSync(
      '/bin/bash',
      [flag, 'command -v open; printf "%s\\n" "$PATH" "rc=$FROM_BASHRC"'],
      {
        env: { HOME: home, PATH: '/usr/bin:/bin', BASH_ENV: shim.bashEnv },
        // PLATFORM§2
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8'
      }
    )
    return res.stdout.trim().split('\n')
  }

  it("puts the shim first in a bash login shell after the user's profile and ~/.bashrc have run, since Codex skips ~/.bashrc once BASH_ENV is set, and loads ~/.bashrc in no other bash", () => {
    const home = path.join(base, 'home-bash')
    fs.mkdirSync(home)
    fs.writeFileSync(
      path.join(home, '.bash_profile'),
      `export PATH="${path.join(base, 'user-bin')}:$PATH"\n`
    )
    fs.writeFileSync(
      path.join(home, '.bashrc'),
      'export FROM_BASHRC=1\nexport PATH="/usr/bin:/bin:$PATH"\n'
    )
    const [openPath, pathLine, rc] = bash('-lc', home)
    expect(openPath).toBe(path.join(shim.shimDir, 'open'))
    expect(pathLine.split(':')).toContain(path.join(base, 'user-bin'))
    expect(rc).toBe('rc=1')
    const [nonLoginOpen, , nonLoginRc] = bash('-c', home)
    expect(nonLoginOpen).toBe(path.join(shim.shimDir, 'open'))
    expect(nonLoginRc).toBe('rc=')
  })
})
