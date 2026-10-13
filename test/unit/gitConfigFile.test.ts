import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { gitAccountsDir, gitConfigEnv, writeGitAccountConfigs } from '../../src/main/gitConfigFile'
import type { GitAccount, GitRepoPick } from '../../src/shared/types'

let root: string
let home: string
let dir: string
let helper: string
let helperLog: string
let globalHelperLog: string
let repoA: string
let treeA: string
let nested: string
let repoB: string
let master: string

const bob: GitAccount = {
  host: 'github.com',
  login: 'bob',
  id: 123,
  name: 'Bob "B" #1; \\o/',
  default: true,
  status: 'ok',
  addedAt: 1
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra
  }
}

function git(cwd: string, args: string[], env = baseEnv(), input?: string): string {
  const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`
}

function recorder(file: string, log: string, password: string): void {
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncat >/dev/null\necho "$*" >> '${log}'\n[ "$2" = get ] || [ "$1" = get ] && printf 'username=u\\npassword=${password}\\n'\nexit 0\n`,
    { mode: 0o755 }
  )
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gitcfg-')))
  home = path.join(root, 'home')
  const userData = path.join(root, 'Application Support', 'koloft')
  fs.mkdirSync(path.join(userData, 'shim'), { recursive: true })
  fs.mkdirSync(home)
  dir = gitAccountsDir(userData)
  helper = path.join(userData, 'shim', 'git-credential-koloft')
  helperLog = path.join(root, 'helper.log')
  globalHelperLog = path.join(root, 'global-helper.log')
  recorder(helper, helperLog, 'tok-from-koloft')
  const globalHelper = path.join(root, 'global-helper')
  recorder(globalHelper, globalHelperLog, 'tok-from-global')
  fs.writeFileSync(path.join(home, '.gitconfig'), `[credential]\n\thelper = ${globalHelper}\n`)

  repoA = path.join(root, 'A')
  treeA = path.join(root, 'A-tree')
  nested = path.join(repoA, 'nested')
  repoB = path.join(root, 'B')
  for (const r of [repoA, repoB]) {
    fs.mkdirSync(r)
    git(r, ['init', '-q'])
    git(r, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'i'
    ])
  }
  fs.mkdirSync(path.join(repoA, 'sub'))
  fs.mkdirSync(nested)
  git(nested, ['init', '-q'])
  git(repoA, ['worktree', 'add', '-q', treeA])

  const picks: GitRepoPick[] = [
    { repo: path.join(repoA, '.git'), host: 'github.com', login: 'bob' }
  ]
  master = writeGitAccountConfigs(dir, picks, [bob], helper)
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('per-repository git config', () => {
  it("a picked repository's top, subfolder and linked worktree read the account; a nested repository and another repository do not", () => {
    const env = gitConfigEnv(baseEnv(), master)
    for (const ws of [repoA, path.join(repoA, 'sub'), treeA]) {
      expect(git(ws, ['config', '--get', 'koloft.account'], env)).toBe('bob')
      expect(git(ws, ['config', '--get', 'user.email'], env)).toBe(
        '123+bob@users.noreply.github.com'
      )
      expect(git(ws, ['config', '--get', 'user.name'], env)).toBe(bob.name)
    }
    for (const ws of [nested, repoB])
      expect(git(ws, ['config', '--get', 'koloft.account'], env)).toBe('exit 1')
  })

  it("inside a picked repository git asks only Koloft's helper, run from a path with a space and told the login; elsewhere the user's own helper answers", () => {
    const env = gitConfigEnv(baseEnv(), master)
    const ask = 'protocol=https\nhost=github.com\n\n'
    expect(git(repoA, ['credential', 'fill'], env, ask)).toContain('password=tok-from-koloft')
    expect(fs.readFileSync(helperLog, 'utf8')).toContain('bob get')
    expect(fs.existsSync(globalHelperLog)).toBe(false)
    expect(git(repoB, ['credential', 'fill'], env, ask)).toContain('password=tok-from-global')
  })

  it("keeps the user's own GIT_CONFIG_COUNT entries and adds Koloft's after them", () => {
    const env = gitConfigEnv(
      baseEnv({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'koloft.mine',
        GIT_CONFIG_VALUE_0: 'yes'
      }),
      master
    )
    expect(git(repoA, ['config', '--get', 'koloft.mine'], env)).toBe('yes')
    expect(git(repoA, ['config', '--get', 'koloft.account'], env)).toBe('bob')
  })

  it('a rewrite with the pick and the account gone leaves the repository on its own config and no account file behind', () => {
    const tmpDir = path.join(root, 'rewrite')
    writeGitAccountConfigs(
      tmpDir,
      [{ repo: path.join(repoA, '.git'), host: 'github.com', login: 'bob' }],
      [bob],
      helper
    )
    const again = writeGitAccountConfigs(tmpDir, [], [], helper)
    expect(git(repoA, ['config', '--get', 'koloft.account'], gitConfigEnv(baseEnv(), again))).toBe(
      'exit 1'
    )
    expect(fs.readdirSync(path.join(tmpDir, 'accounts'))).toEqual([])
  })
})
