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

  it('recovers a worktree that moved to another branch in place, and remembers that branch for later rebuilds', async () => {
    const resource = await worktrees.create(repo, 'one')
    git('-C', resource.worktreePath, 'switch', '-c', 'pr-branch')
    const recovered = await worktrees.rebuild(resource.id)
    expect(recovered.id).toBe(resource.id)
    expect(recovered.worktreeBranch).toBe('pr-branch')
    expect(git('-C', resource.worktreePath, 'branch', '--show-current')).toBe('pr-branch')
    fs.rmSync(resource.worktreePath, { recursive: true })
    const rebuilt = await worktrees.rebuild(resource.id)
    expect(git('-C', rebuilt.worktreePath, 'branch', '--show-current')).toBe('pr-branch')
  })

  it('copies into a new or rebuilt checkout exactly the files .worktreeinclude lists that git ignores, never a link', async () => {
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      fs.writeFileSync(path.join(repo, rel), text)
    }
    write('.gitignore', '.env\nsecrets/\nbuild/\nlink.env\n')
    write('.worktreeinclude', '.env\nsecrets/\nnotes.txt\nlink.env\n')
    git('add', '.gitignore', '.worktreeinclude')
    git('commit', '-m', 'Ignore rules')
    write('.env', 'PORT=3000\n')
    write('secrets/key.txt', 'k')
    write('build/out.js', 'built')
    write('notes.txt', 'untracked, not ignored')
    fs.symlinkSync('.env', path.join(repo, 'link.env'))
    const copied = (worktreePath: string): string[] =>
      ['.env', 'secrets/key.txt', 'build/out.js', 'notes.txt', 'link.env'].filter((rel) =>
        fs.existsSync(path.join(worktreePath, rel))
      )

    const resource = await worktrees.create(repo, 'one')
    expect(copied(resource.worktreePath)).toEqual(['.env', 'secrets/key.txt'])
    expect(fs.readFileSync(path.join(resource.worktreePath, '.env'), 'utf8')).toBe('PORT=3000\n')

    fs.rmSync(resource.worktreePath, { recursive: true })
    const rebuilt = await worktrees.rebuild(resource.id)
    expect(copied(rebuilt.worktreePath)).toEqual(['.env', 'secrets/key.txt'])
  })

  it('calls a worktree untouched only while it is a Koloft-made one on its own worktree-<name> branch at the commit it was made from, with no change, no new file and no ignored file but unchanged copies from the main checkout', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nbuild/\n')
    fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n')
    git('add', '.gitignore', '.worktreeinclude')
    git('commit', '-m', 'Ignore rules')
    fs.writeFileSync(path.join(repo, '.env'), 'PORT=3000\n')
    let n = 0
    const untouchedAfter = async (touch: (tree: string) => void): Promise<boolean> => {
      const resource = await worktrees.create(repo, `case-${++n}`)
      touch(resource.worktreePath)
      return worktrees.untouched(resource)
    }
    const inTree = (tree: string, ...args: string[]): string => git('-C', tree, ...args)

    expect(await untouchedAfter(() => {})).toBe(true)
    expect(
      await untouchedAfter((tree) => fs.writeFileSync(path.join(tree, 'file.txt'), 'edit\n'))
    ).toBe(false)
    expect(
      await untouchedAfter((tree) => fs.writeFileSync(path.join(tree, 'new.txt'), 'new\n'))
    ).toBe(false)
    expect(
      await untouchedAfter((tree) => fs.writeFileSync(path.join(tree, '.env'), 'PORT=4000\n'))
    ).toBe(false)
    expect(
      await untouchedAfter((tree) => {
        fs.mkdirSync(path.join(tree, 'build'))
        fs.writeFileSync(path.join(tree, 'build', 'out.js'), 'built')
      })
    ).toBe(false)
    expect(
      await untouchedAfter((tree) => {
        fs.writeFileSync(path.join(tree, 'new.txt'), 'new\n')
        inTree(tree, 'add', 'new.txt')
        inTree(tree, 'commit', '-m', 'Worktree change')
      })
    ).toBe(false)
    expect(await untouchedAfter((tree) => inTree(tree, 'switch', '-c', 'pr-branch'))).toBe(false)

    const checkout = path.join(directory, 'adopted')
    git('worktree', 'add', '-b', 'worktree-adopted', checkout)
    expect(await worktrees.untouched(await worktrees.adopt(repo, checkout))).toBe(false)
  })

  it('a worktree name stays recorded after its folder and branch are gone, so no new worktree takes it', async () => {
    const resource = await worktrees.create(repo, 'one')
    git('worktree', 'remove', resource.worktreePath)
    git('branch', '-D', 'worktree-one')
    expect(worktrees.recorded(resource.worktreePath)).toBe(true)
    await expect(worktrees.create(repo, 'one')).rejects.toThrow('recovery record')
  })

  it('refuses a locked missing worktree without modifying it', async () => {
    const resource = await worktrees.create(repo, 'one')
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
