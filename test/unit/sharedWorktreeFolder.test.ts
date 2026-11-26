import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-shared-worktree-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

import { BackgroundFile } from '../../src/main/backgroundFile'
import { SessionStore } from '../../src/agents/kit/main/sessionStore'
import {
  SessionWorktrees,
  type WorktreesOfEveryAgent
} from '../../src/agents/kit/main/sessionWorktrees'
import type { TreeIo } from '../../src/main/sessionWorktrees'
import { worktreeRecordsOfEveryAgent } from '../../src/core/agent/worktreeRecords'
import { TreeRemovals } from '../../src/main/treeRemovals'
import { localGitOut, localGitRun, localHost } from '../../src/main/host/localHost'
import { GithubRepos } from '../../src/main/githubRepos'
import { removeTree } from '../../src/plugins/sessions/main/sessionClose'
import { preparedKeyOf, removingTheWorktree } from '../../src/main/worktreesBeingPrepared'
import { dirExistsSync, gitProbes } from '../../src/main/resumePlan'
import { ClaudeBackend, type ClaudeBackendDeps } from '../../src/agents/claude/main/backend'
import { barePath, formatRemoteKey, isRemoteKey } from '../../src/shared/remoteKey'
import type { BackendId } from '../../src/shared/types'

const MACHINE = 'lab'
const SID = '5b0c7a52-3f1e-4d2a-9c8b-7e6f5d4c3b2a'
const OTHER = 'other-agent' as unknown as BackendId
const LONG_ENOUGH_TO_TAKE_A_FOLDER_MS = 1000
const ROUNDS = 4

function shOnMachine(script: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile('sh', ['-c', script, 'sh', ...args], (error, stdout) => resolve(error ? null : stdout))
  )
}

const machineIo: TreeIo = {
  git: async (dir, args) =>
    (await promisify(execFile)('git', ['-C', barePath(dir), ...args])).stdout.trimEnd(),
  exists: async (p) => fs.existsSync(barePath(p)),
  real: (p) => p,
  keyed: (listed) => formatRemoteKey(MACHINE, listed),
  machine: { runScript: shOnMachine }
}

const machineHost = {
  keyed: (p: string) => (isRemoteKey(p) ? p : formatRemoteKey(MACHINE, p)),
  dirExists: async (p: string) => fs.existsSync(barePath(p)),
  gitOut: (dir: string, args: string[]) => localGitOut(barePath(dir), args),
  gitRun: (dir: string, args: string[]) => localGitRun(barePath(dir), args)
}

const SIDES = [
  {
    where: 'on this Mac',
    io: undefined,
    at: (p: string) => p,
    workspaceOf: (repo: string) => repo,
    host: () => localHost(new GithubRepos({}), {} as never),
    machine: undefined
  },
  {
    where: 'on another machine over ssh',
    io: () => machineIo,
    at: (p: string) => formatRemoteKey(MACHINE, p),
    workspaceOf: (repo: string) => formatRemoteKey(MACHINE, repo),
    host: () => machineHost,
    machine: { runScript: shOnMachine }
  }
]

let directory: string
let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-shared-worktree-'))
  repo = path.join(directory, 'repo')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Worktree test')
  git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n')
  git('add', 'file.txt')
  git('commit', '-m', 'Initial')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await BackgroundFile.whenAllWritten()
  fs.rmSync(directory, { recursive: true, force: true })
})

function sharedFolder(
  side: (typeof SIDES)[number],
  unboundIn?: string,
  anotherAgentIn: (dir: string) => string | null = () => null
) {
  const store = new SessionStore(path.join(directory, `other-sessions-${Math.random()}.json`))
  const preparing = new Map<string, Promise<unknown>>()
  let theirs: SessionWorktrees
  const records = worktreeRecordsOfEveryAgent(() => [
    { id: OTHER, worktreeRecords: theirs.records }
  ])
  const everyAgent: WorktreesOfEveryAgent = { recorded: (dir) => records.recorded(dir), preparing }
  theirs = new SessionWorktrees(store, everyAgent, side.io)
  const claudeRepo = side.io ? fs.realpathSync(repo) : repo
  const tree = path.join(claudeRepo, '.claude', 'worktrees', 'foo')
  const launched: { cwd: string; folderThere: boolean; worktree?: string }[] = []
  const tabs = ClaudeBackend.prototype as unknown as {
    createTab(spec: { cwd: string; worktree?: string }): Promise<unknown>
  }
  vi.spyOn(tabs, 'createTab').mockImplementation(async (spec) => {
    launched.push({
      cwd: spec.cwd,
      folderThere: fs.existsSync(barePath(spec.cwd ?? '')),
      worktree: spec.worktree
    })
    return { ok: true, id: 'claude-tab', cwd: spec.cwd }
  })
  const claudeGit: string[] = []
  const realHost = side.host()
  const host = {
    ...realHost,
    gitRun: (dir: string, args: string[]) => {
      claudeGit.push(args.slice(0, 2).join(' '))
      return realHost.gitRun(dir, args)
    }
  }
  const claude: ClaudeBackend = new ClaudeBackend({
    tracker: { list: () => [], remoteOf: () => undefined },
    store: () => ({
      findRow: (id: string) =>
        id !== SID
          ? undefined
          : unboundIn
            ? { id: SID, cwd: path.join(tree, unboundIn) }
            : {
                id: SID,
                cwd: tree,
                worktreeState: {
                  worktreePath: tree,
                  worktreeName: 'foo',
                  originalCwd: claudeRepo,
                  worktreeBranch: 'worktree-foo',
                  originalHeadCommit: git('rev-parse', 'HEAD')
                }
              },
      workspaceOf: () => side.workspaceOf(claudeRepo),
      bucketDirOf: () => undefined
    }),
    hosts: { of: () => host, machineOf: () => side.machine },
    resumeProbes: {
      dirExists: dirExistsSync,
      occupantOf: (dir: string) => claude.occupantOf(dir) ?? anotherAgentIn(dir),
      recorded: (dir: string) => records.recorded(dir),
      ...gitProbes(localGitOut)
    },
    worktreesBeingPrepared: preparing
  } as unknown as ClaudeBackendDeps)
  return {
    theirs,
    preparing,
    tree,
    launched,
    claudeGit,
    claudePlan: () => claude.resumePlan(SID),
    claudeResumes: () =>
      claude.resume({ sessionId: SID, cwd: side.at(path.join(tree, unboundIn ?? '')) }),
    claudeResumesRenamed: (worktree: string) =>
      claude.resume({ sessionId: SID, cwd: side.at(tree), mode: 'renamed', worktree }),
    claudeStartsIn: (worktree: string, workspace = claudeRepo) =>
      claude.create({ kind: 'claude', cwd: side.at(workspace), worktree })
  }
}

describe.each(SIDES)(
  'a new Claude Code session in a worktree name only another agent still records, $where',
  (side) => {
    it('is refused with the sentence the other agents use, and Claude Code is not started on that name', async () => {
      const s = sharedFolder(side)
      const made = await s.theirs.create(side.at(repo), 'foo')
      git('worktree', 'remove', '--force', barePath(made.worktreePath))
      git('branch', '-D', 'worktree-foo')
      await expect(s.claudeStartsIn('foo')).rejects.toThrow(
        'This worktree name has a recovery record; recover it or choose a different name'
      )
      expect(s.launched).toEqual([])
      await expect(s.claudeStartsIn('bar')).resolves.toMatchObject({ ok: true })
      expect(s.launched).toEqual([expect.objectContaining({ worktree: 'bar' })])
    })

    it('is refused with the words the other agents use while any agent prepares or removes that folder', async () => {
      const s = sharedFolder(side)
      let done = (): void => {}
      const tree = side.at(path.join(fs.realpathSync(repo), '.claude', 'worktrees', 'foo'))
      s.preparing.set(preparedKeyOf(tree), new Promise<void>((r) => (done = r)))
      await expect(s.claudeStartsIn('foo')).rejects.toThrow(
        'Worktree preparation is already in progress'
      )
      done()
      expect(s.launched).toEqual([])
    })

    it('is refused the same way when the workspace is a subfolder of the repository', async () => {
      const s = sharedFolder(side)
      const made = await s.theirs.create(side.at(repo), 'foo')
      git('worktree', 'remove', '--force', barePath(made.worktreePath))
      git('branch', '-D', 'worktree-foo')
      fs.mkdirSync(path.join(repo, 'app'))
      await expect(s.claudeStartsIn('foo', path.join(repo, 'app'))).rejects.toThrow(
        'This worktree name has a recovery record; recover it or choose a different name'
      )
      expect(s.launched).toEqual([])
    })

    it('a Claude Code resume into a new worktree of that name is refused the same way', async () => {
      const s = sharedFolder(side)
      git('worktree', 'add', '-q', '-b', 'worktree-foo', s.tree)
      const made = await s.theirs.create(side.at(repo), 'foo-2')
      git('worktree', 'remove', '--force', barePath(made.worktreePath))
      git('branch', '-D', 'worktree-foo-2')
      await expect(s.claudeResumesRenamed('foo-2')).resolves.toEqual({
        ok: false,
        code: 'backend',
        message: 'This worktree name has a recovery record; recover it or choose a different name'
      })
      expect(s.launched).toEqual([])
      await expect(s.claudeResumesRenamed('foo-3')).resolves.toMatchObject({ ok: true })
      expect(s.launched).toEqual([expect.objectContaining({ worktree: 'foo-3' })])
    })
  }
)

async function onTheListBefore(
  preparing: Map<string, Promise<unknown>>,
  first: Promise<unknown>
): Promise<boolean> {
  let settled = false
  void first.finally(() => (settled = true))
  while (!preparing.size && !settled) await new Promise((r) => setImmediate(r))
  return preparing.size > 0
}

describe.each(SIDES)(
  'Claude Code and another agent rebuilding one missing worktree, $where',
  (side) => {
    async function missingFolder(): Promise<{
      s: ReturnType<typeof sharedFolder>
      id: string
      at: string
    }> {
      const s = sharedFolder(side)
      const made = await s.theirs.create(side.at(repo), 'foo')
      git('worktree', 'remove', '--force', barePath(made.worktreePath))
      return { s, id: made.id, at: made.worktreePath }
    }

    function bothEndInTheFolder(
      s: ReturnType<typeof sharedFolder>,
      at: string,
      claude: PromiseSettledResult<unknown>,
      other: PromiseSettledResult<unknown>
    ): void {
      expect(other).toMatchObject({ status: 'fulfilled', value: { state: 'ready' } })
      expect(claude).toMatchObject({ status: 'fulfilled', value: { ok: true } })
      expect(s.theirs.records.at(at)).toMatchObject({ state: 'ready' })
      expect(s.launched).toEqual([expect.objectContaining({ folderThere: true })])
      expect(fs.existsSync(path.join(s.tree, 'file.txt'))).toBe(true)
      expect(s.preparing.size).toBe(0)
    }

    it('when both start at the same moment, both resume in the folder and the other agent records it ready, not failed', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { s, id, at } = await missingFolder()
        const [other, claude] = await Promise.allSettled([s.theirs.rebuild(id), s.claudeResumes()])
        bothEndInTheFolder(s, at, claude, other)
        git('worktree', 'remove', '--force', s.tree)
        git('branch', '-D', 'worktree-foo')
      }
    }, 30_000)

    it('when the other agent is already rebuilding it, Claude Code waits and resumes in the folder that agent made, without removing or making it again', async () => {
      const { s, id, at } = await missingFolder()
      const other = s.theirs.rebuild(id)
      expect(await onTheListBefore(s.preparing, other)).toBe(true)
      const claude = s.claudeResumes()
      bothEndInTheFolder(s, at, ...(await Promise.allSettled([claude, other])))
      expect(s.claudeGit).not.toContain('worktree add')
      expect(s.claudeGit).not.toContain('worktree remove')
    })

    it('when Claude Code is already rebuilding it, the other agent waits and takes the folder Claude Code made, recording it ready', async () => {
      const { s, id, at } = await missingFolder()
      const claude = s.claudeResumes()
      expect(await onTheListBefore(s.preparing, claude)).toBe(true)
      const other = s.theirs.rebuild(id)
      bothEndInTheFolder(s, at, ...(await Promise.allSettled([claude, other])))
      expect(s.claudeGit).toContain('worktree add')
    })
  }
)

describe.each(SIDES)(
  'resuming a Claude Code session into its worktree while another agent works there, $where',
  (side) => {
    it('asks where to resume, naming that session, and resumes straight in once nobody works there', async () => {
      let atWork: string | null = 'A Codex session at work'
      const s = sharedFolder(side, undefined, (dir) => (dir === side.at(s.tree) ? atWork : null))
      git('worktree', 'add', '-q', '-b', 'worktree-foo', s.tree)
      await expect(s.claudePlan()).resolves.toMatchObject({
        action: 'dialog',
        occupiedBy: 'A Codex session at work'
      })
      atWork = null
      await expect(s.claudePlan()).resolves.toMatchObject({ action: 'direct' })
    })
  }
)

describe('a session closed for good while another agent wants its worktree, on this Mac', () => {
  const side = SIDES[0]

  async function whileTheCloseRemovesIt<T>(
    s: ReturnType<typeof sharedFolder>,
    meanwhile: () => Promise<T>
  ): Promise<PromiseSettledResult<T>> {
    let release = (): void => {}
    const removalHeld = new Promise<void>((r) => (release = r))
    let reached = (): void => {}
    const removalReached = new Promise<void>((r) => (reached = r))
    const closing = removingTheWorktree(
      { preparing: s.preparing, treeRemovals: new TreeRemovals() },
      s.tree,
      async () => {
        reached()
        await removalHeld
        return removeTree(localGitOut, {
          root: repo,
          treeRoot: s.tree,
          worktreeName: 'foo',
          branches: []
        })
      }
    )
    await removalReached
    const other = meanwhile()
    await Promise.race([
      other.catch(() => undefined),
      new Promise((r) => setTimeout(r, LONG_ENOUGH_TO_TAKE_A_FOLDER_MS))
    ])
    release()
    await closing
    const [settled] = await Promise.allSettled([other])
    return settled
  }

  it('another agent that starts a session in the folder while the close removes it waits, and is refused instead of taking a folder that is then deleted', async () => {
    const s = sharedFolder(side)
    const made = await s.theirs.create(side.at(repo), 'foo')
    const taking = await whileTheCloseRemovesIt(s, () =>
      s.theirs.adopt(side.at(repo), made.worktreePath)
    )
    expect(taking).toMatchObject({
      status: 'rejected',
      reason: new Error('The checkout is not a worktree of this repository')
    })
    expect(fs.existsSync(s.tree)).toBe(false)
  })

  it('a Claude Code resume into the folder while the close removes it waits for the removal, then makes the folder again and starts in it', async () => {
    const s = sharedFolder(side)
    await s.theirs.create(side.at(repo), 'foo')
    const resumed = await whileTheCloseRemovesIt(s, s.claudeResumes)
    expect(resumed).toMatchObject({ status: 'fulfilled', value: { ok: true } })
    expect(s.launched).toEqual([expect.objectContaining({ folderThere: true })])
    expect(fs.existsSync(path.join(s.tree, 'file.txt'))).toBe(true)
  })

  it('a Claude Code resume of a session with no worktree record, last in a subfolder of the folder, waits for the removal and does not start in the deleted folder', async () => {
    const s = sharedFolder(side, 'src')
    await s.theirs.create(side.at(repo), 'foo')
    fs.mkdirSync(path.join(s.tree, 'src'))
    const resumed = await whileTheCloseRemovesIt(s, s.claudeResumes)
    expect(resumed).toMatchObject({
      status: 'fulfilled',
      value: { ok: false, code: 'cwd-missing' }
    })
    expect(s.launched).toEqual([])
  })
})
