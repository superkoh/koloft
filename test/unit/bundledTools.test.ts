import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { pathWithDirLast } = await import('../../src/main/toolInstall')
const { gitLauncherScript, gitMissing, gitSystemConfig } =
  await import('../../src/main/bundledTools')

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
