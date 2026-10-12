import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { GitAccount } from '@shared/types'
import type { PushAccess } from '../../src/main/githubApi'
import { suggestFor, type GitRun, type SuggestDeps } from '../../src/main/gitAccountSuggest'

const account = (login: string, id: number): GitAccount => ({
  host: 'github.com',
  login,
  id,
  name: login,
  default: false,
  status: 'ok',
  addedAt: 0
})

function runGit(
  cwd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; input?: string }
): Promise<GitRun> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, env: opts.env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
    p.stdin.end(opts.input ?? '')
  })
}

describe('suggestFor', () => {
  let root: string
  let home: string
  let repo: string
  let accounts: GitAccount[]
  let access: Record<string, PushAccess>
  let sshCalls: string[][]
  let sshGreeting: string
  let d: SuggestDeps

  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: repo, env: d.env })
    if (r.status !== 0) throw new Error(String(r.stderr))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-suggest-'))
    home = path.join(root, 'home')
    repo = path.join(root, 'repo')
    fs.mkdirSync(home)
    fs.mkdirSync(repo)
    accounts = [account('bob', 42)]
    access = {}
    sshCalls = []
    sshGreeting = ''
    d = {
      git: runGit,
      ssh: async (args) => {
        sshCalls.push(args)
        if (args[0] === '-G')
          return { code: 0, stdout: 'host github.com\nhostname github.com\nport 22\n', stderr: '' }
        return { code: 1, stdout: '', stderr: sshGreeting }
      },
      readFile: (p) => {
        try {
          return fs.readFileSync(p, 'utf8')
        } catch {
          return null
        }
      },
      home,
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      githubUrl: 'https://github.com',
      accounts: () => accounts,
      token: async (login) => `tok-${login}`,
      pushAccess: async (token) => access[token] ?? { kind: 'none' },
      repoOf: async () => ({ owner: 'o', name: 'r' })
    }
    git('init', '-q', '-b', 'main')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('a remote naming alice, who is not in Koloft, suggests adding alice and never hands the repo to bob who can push', async () => {
    git('remote', 'add', 'origin', 'https://alice@github.com/o/r.git')
    access['tok-bob'] = { kind: 'push', allowed: true }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'add',
      login: 'alice',
      reason: 'url-user'
    })
  })

  it('a remote naming bob uses bob when bob can push, and says so when he cannot', async () => {
    git('remote', 'add', 'origin', 'https://bob@github.com/o/r.git')
    access['tok-bob'] = { kind: 'push', allowed: true }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'use',
      login: 'bob',
      reason: 'url-user'
    })
    access['tok-bob'] = { kind: 'push', allowed: false }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'cannot-push',
      login: 'bob',
      reason: 'url-user'
    })
    access['tok-bob'] = { kind: 'org-blocked', org: 'o' }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'org-blocked',
      login: 'bob',
      org: 'o'
    })
  })

  it('offline, a recognised account is not picked yet', async () => {
    git('remote', 'add', 'origin', 'https://bob@github.com/o/r.git')
    access['tok-bob'] = { kind: 'offline' }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({ kind: 'none' })
  })

  it('reads the username git itself would use from the user’s credential config', async () => {
    git('remote', 'add', 'origin', 'https://github.com/o/r.git')
    git('config', 'credential.https://github.com.username', 'bob')
    expect(await suggestFor(repo, { network: false }, d)).toEqual({
      kind: 'use',
      login: 'bob',
      reason: 'config-user'
    })
  })

  it('names the login of the user’s own gh only when gh is git’s helper', async () => {
    git('remote', 'add', 'origin', 'https://github.com/o/r.git')
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.config', 'gh', 'hosts.yml'),
      'github.com:\n    users:\n        alice:\n    user: alice\n'
    )
    expect(await suggestFor(repo, { network: false }, d)).toEqual({ kind: 'none' })
    git(
      'config',
      'credential.https://github.com.helper',
      '!/opt/homebrew/bin/gh auth git-credential'
    )
    expect(await suggestFor(repo, { network: false }, d)).toEqual({
      kind: 'add',
      login: 'alice',
      reason: 'gh-user'
    })
  })

  it('asks GitHub over ssh who the key is only when the network is allowed', async () => {
    git('remote', 'add', 'origin', 'git@github.com:o/r.git')
    sshGreeting =
      "Hi bob! You've successfully authenticated, but GitHub does not provide shell access.\n"
    access['tok-bob'] = { kind: 'push', allowed: true }
    expect(await suggestFor(repo, { network: false }, d)).toEqual({ kind: 'none' })
    expect(sshCalls.every((a) => a[0] === '-G')).toBe(true)
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'use',
      login: 'bob',
      reason: 'ssh-greeting'
    })
    expect(sshCalls.at(-1)).toContain('BatchMode=yes')
    expect(sshCalls.at(-1)?.at(-1)).toBe('git@github.com')
  })

  it('a repository with its own ssh command is never asked over ssh', async () => {
    git('remote', 'add', 'origin', 'git@github.com:o/r.git')
    git('config', 'core.sshCommand', 'ssh -i ~/.ssh/work')
    sshGreeting = 'Hi bob! You have successfully authenticated.\n'
    await suggestFor(repo, { network: true }, d)
    expect(sshCalls.every((a) => a[0] === '-G')).toBe(true)
  })

  it('with no clue, the one account that can push is offered', async () => {
    git('remote', 'add', 'origin', 'https://github.com/o/r.git')
    accounts = [account('bob', 42), account('alice', 7)]
    access['tok-alice'] = { kind: 'push', allowed: true }
    access['tok-bob'] = { kind: 'push', allowed: false }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'only-one-can-push',
      login: 'alice'
    })
  })

  it('with no clue and several accounts that can push, the default account is offered', async () => {
    git('remote', 'add', 'origin', 'https://github.com/o/r.git')
    accounts = [account('bob', 42), { ...account('alice', 7), default: true }]
    access['tok-alice'] = { kind: 'push', allowed: true }
    access['tok-bob'] = { kind: 'push', allowed: true }
    expect(await suggestFor(repo, { network: true }, d)).toEqual({
      kind: 'default-can-push',
      login: 'alice'
    })
  })

  it('a commit made here with an account’s noreply address is only a hint', async () => {
    git('remote', 'add', 'origin', 'https://github.com/o/r.git')
    git(
      '-c',
      'user.name=Bob',
      '-c',
      'user.email=42+bob@users.noreply.github.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'mine'
    )
    expect(await suggestFor(repo, { network: false }, d)).toEqual({
      kind: 'hint',
      login: 'bob',
      reason: 'commit-email'
    })
  })

  it('a repository whose remote is not on GitHub gets no suggestion', async () => {
    git('remote', 'add', 'origin', 'https://bob@gitlab.com/o/r.git')
    expect(await suggestFor(repo, { network: true }, d)).toEqual({ kind: 'none' })
  })
})
