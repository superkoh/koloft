import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../src/main/sessionStore'
import { SessionWorktrees } from '../../src/main/sessionWorktrees'

let directory: string
let repo: string
let store: SessionStore
let worktrees: SessionWorktrees

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-session-worktrees-')))
  repo = path.join(directory, 'repo with spaces')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Worktree test')
  git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n')
  git('add', 'file.txt')
  git('commit', '-m', 'Initial')
  store = new SessionStore(path.join(directory, 'sessions.json'))
  worktrees = new SessionWorktrees(store)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('SessionWorktrees', () => {
  it('records ownership before creating a worktree, and adopts it without losing dirty changes', async () => {
    const save = store.putResource.bind(store)
    const states: string[] = []
    vi.spyOn(store, 'putResource').mockImplementation((resource) => {
      if (resource.state === 'creating') expect(fs.existsSync(resource.worktreePath)).toBe(false)
      states.push(resource.state)
      save(resource)
    })
    const resource = await worktrees.create(repo, 'one')
    expect(states).toEqual(['creating', 'ready'])
    expect(resource.worktreeBranch).toBe('worktree-one')
    fs.writeFileSync(path.join(resource.worktreePath, 'file.txt'), 'unfinished edit\n')
    const adopted = await worktrees.adopt(repo, resource.worktreePath)
    expect(adopted.id).toBe(resource.id)
    expect(fs.readFileSync(path.join(resource.worktreePath, 'file.txt'), 'utf8')).toBe(
      'unfinished edit\n'
    )
    expect(store.listResources()).toHaveLength(1)
  })

  it('does not create a checkout if saving its intent fails', async () => {
    vi.spyOn(store, 'putResource').mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(worktrees.create(repo, 'blocked')).rejects.toThrow('disk full')
    expect(fs.existsSync(path.join(repo, '.claude/worktrees/blocked'))).toBe(false)
    expect(git('branch', '--list', 'worktree-blocked')).toBe('')
  })

  it('rebuilds a manually deleted checkout on the surviving branch, preserving its commits', async () => {
    const resource = await worktrees.create(repo, 'one')
    fs.writeFileSync(path.join(resource.worktreePath, 'new.txt'), 'committed')
    git('-C', resource.worktreePath, 'add', 'new.txt')
    git('-C', resource.worktreePath, 'commit', '-m', 'Worktree change')
    const latest = git('-C', resource.worktreePath, 'rev-parse', 'HEAD')
    fs.rmSync(resource.worktreePath, { recursive: true })
    const rebuilt = await worktrees.rebuild(resource.id)
    expect(git('-C', rebuilt.worktreePath, 'rev-parse', 'HEAD')).toBe(latest)
    expect(fs.readFileSync(path.join(rebuilt.worktreePath, 'new.txt'), 'utf8')).toBe('committed')
  })

  it('rebuilds at the recorded baseline when both checkout and branch were removed', async () => {
    const resource = await worktrees.create(repo, 'one')
    git('worktree', 'remove', resource.worktreePath)
    git('branch', '-D', resource.worktreeBranch!)
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later')
    git('add', 'later.txt')
    git('commit', '-m', 'Later main')
    const rebuilt = await worktrees.rebuild(resource.id)
    expect(git('-C', rebuilt.worktreePath, 'rev-parse', 'HEAD')).toBe(resource.originalHeadCommit)
    expect(fs.existsSync(path.join(rebuilt.worktreePath, 'later.txt'))).toBe(false)
  })

  it('creates a renamed recovery checkout without changing the old checkout', async () => {
    const resource = await worktrees.create(repo, 'one')
    fs.writeFileSync(path.join(resource.worktreePath, 'file.txt'), 'keep this dirty edit')
    const renamed = await worktrees.prepareRenamed(resource.id, 'two')
    expect(renamed.id).not.toBe(resource.id)
    expect(renamed.worktreeBranch).toBe('worktree-two')
    expect(fs.readFileSync(path.join(resource.worktreePath, 'file.txt'), 'utf8')).toBe(
      'keep this dirty edit'
    )
    expect(store.listResources()).toHaveLength(2)
  })

  it('refuses branch drift and locked missing worktrees without modifying them', async () => {
    const resource = await worktrees.create(repo, 'one')
    git('-C', resource.worktreePath, 'switch', '-c', 'changed-branch')
    await expect(worktrees.rebuild(resource.id)).rejects.toThrow('branch has changed')
    expect(git('-C', resource.worktreePath, 'branch', '--show-current')).toBe('changed-branch')
    git('worktree', 'lock', resource.worktreePath)
    fs.rmSync(resource.worktreePath, { recursive: true })
    await expect(worktrees.rebuild(resource.id)).rejects.toThrow('locked')
    expect(git('worktree', 'list', '--porcelain')).toContain('locked')
    expect(store.getResource(resource.id)?.state).toBe('failed')
  })

  it('adopts an existing detached checkout without changing its branch or files', async () => {
    const checkout = path.join(directory, 'outside namespace')
    git('worktree', 'add', '--detach', checkout, 'HEAD')
    fs.writeFileSync(path.join(checkout, 'file.txt'), 'dirty detached checkout')
    const adopted = await worktrees.adopt(repo, checkout)
    expect(adopted.managed).toBe(false)
    expect(adopted.worktreeBranch).toBeNull()
    expect(fs.readFileSync(path.join(checkout, 'file.txt'), 'utf8')).toBe('dirty detached checkout')
  })

  it('rejects invalid names and name collisions without touching an existing checkout', async () => {
    await expect(worktrees.create(repo, '../escape')).rejects.toThrow('Invalid worktree name')
    const resource = await worktrees.create(repo, 'one')
    await expect(worktrees.create(repo, 'one')).rejects.toThrow('already exists')
    expect(fs.existsSync(path.join(resource.worktreePath, 'file.txt'))).toBe(true)
    expect(store.listResources()).toHaveLength(1)
  })
})
