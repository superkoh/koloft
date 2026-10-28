import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { pathWithDirLast } = await import('../../src/main/toolInstall')
const { gitLauncherScript, gitMissing, gitSystemConfig, stepAsideForTheUsersGit } =
  await import('../../src/main/bundledTools')
const { writeExecutable } = await import('../../src/main/playwrightCli')

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft tools-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function executable(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode: 0o755 })
  return file
}

describe('the bundled gh', () => {
  it('stays behind every other folder, even ones the login shell adds after it, so a user’s own gh wins', () => {
    const shipped = '/k/gh/bin'
    const loginAdded = `${pathWithDirLast('/usr/bin:/bin', shipped)}:/opt/homebrew/bin`
    expect(pathWithDirLast(loginAdded, shipped).split(':')).toEqual([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      shipped
    ])
  })
})

describe('the bundled git', () => {
  it('is needed only when no folder but /usr/bin, whose git is Apple’s install stub, holds a git', () => {
    const own = path.join(dir, 'own')
    executable(path.join(own, 'git'), '#!/bin/sh\n')
    const empty = path.join(dir, 'empty')
    fs.mkdirSync(empty)
    const prev = process.env.KOLOFT_TEST_CLT
    process.env.KOLOFT_TEST_CLT = 'missing'
    try {
      expect(gitMissing(`/usr/bin:${empty}`)).toBe(true)
      expect(gitMissing(`/usr/bin:${empty}:${own}`)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.KOLOFT_TEST_CLT
      else process.env.KOLOFT_TEST_CLT = prev
    }
  })

  it('gives way to the first real git program on the login PATH, skipping a relative folder, a script named git (an asdf or mise shim, or its own launcher) and a link to a program not named git (a mise shim)', () => {
    const gitBin = path.join(dir, 'git-bin')
    const launcher = executable(path.join(gitBin, 'git'), '#!/bin/sh\necho shipped\n')
    const linkBack = path.join(dir, 'link-back')
    fs.mkdirSync(linkBack)
    fs.symlinkSync(launcher, path.join(linkBack, 'git'))
    const asdf = path.join(dir, 'asdf')
    executable(path.join(asdf, 'git'), '#!/usr/bin/env bash\nexec asdf exec git "$@"\n')
    const mise = path.join(dir, 'mise')
    const miseProgram = executable(path.join(dir, 'mise-bin', 'mise'), '\xcf\xfa\xed\xfe')
    fs.mkdirSync(mise)
    fs.symlinkSync(miseProgram, path.join(mise, 'git'))
    const nix = path.join(dir, 'nix-profile', 'bin')
    const store = executable(path.join(dir, 'store', 'git-2.47', 'bin', 'git'), '\xcf\xfa\xed\xfe')
    fs.mkdirSync(nix, { recursive: true })
    fs.symlinkSync(store, path.join(nix, 'git'))
    const prevCwd = process.cwd()
    const prevClt = process.env.KOLOFT_TEST_CLT
    process.chdir(path.dirname(store))
    process.env.KOLOFT_TEST_CLT = 'missing'
    try {
      stepAsideForTheUsersGit(gitBin, `.:${gitBin}:${linkBack}:${asdf}:${mise}:/usr/bin`)
      expect(fs.readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\necho shipped\n')

      stepAsideForTheUsersGit(gitBin, `.:${gitBin}:${linkBack}:${asdf}:${mise}:/usr/bin:${nix}`)
      expect(fs.readlinkSync(launcher)).toBe(path.join(nix, 'git'))
    } finally {
      process.chdir(prevCwd)
      if (prevClt === undefined) delete process.env.KOLOFT_TEST_CLT
      else process.env.KOLOFT_TEST_CLT = prevClt
    }
  })

  it('is written again on the next launch without writing into the user’s git its launcher links to', () => {
    const theirs = executable(path.join(dir, 'own', 'git'), '#!/bin/sh\necho theirs\n')
    const launcher = path.join(dir, 'git-bin', 'git')
    fs.mkdirSync(path.dirname(launcher))
    fs.symlinkSync(theirs, launcher)
    writeExecutable(launcher, '#!/bin/sh\necho shipped\n')
    expect(fs.readFileSync(theirs, 'utf8')).toBe('#!/bin/sh\necho theirs\n')
    expect(fs.readFileSync(launcher, 'utf8')).toBe('#!/bin/sh\necho shipped\n')
  })

  it('runs git from its own folder with its own exec path and system config, passing every argument', () => {
    const root = path.join(dir, 'git root')
    executable(
      path.join(root, 'libexec', 'git-core', 'git'),
      '#!/bin/sh\nprintf "%s|%s|%s\\n" "$GIT_EXEC_PATH" "$GIT_CONFIG_SYSTEM" "$*"\n'
    )
    const config = path.join(dir, 'gitconfig')
    const launcher = executable(path.join(dir, 'bin', 'git'), gitLauncherScript(root, config))
    const r = spawnSync(launcher, ['commit', '-m', 'two words'], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe(
      `${path.join(root, 'libexec', 'git-core')}|${config}|commit -m two words`
    )
  })

  it('makes main the first branch and finds its templates even under a folder name with a space', () => {
    const root = path.join(dir, 'Application Support', 'git')
    const config = path.join(dir, 'gitconfig')
    fs.writeFileSync(config, gitSystemConfig(root))
    const read = (key: string): string =>
      spawnSync('git', ['config', '--system', '--get', key], {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: '' }
      }).stdout.trim()
    expect(read('init.defaultBranch')).toBe('main')
    expect(read('init.templateDir')).toBe(path.join(root, 'share', 'git-core', 'templates'))
  })
})
