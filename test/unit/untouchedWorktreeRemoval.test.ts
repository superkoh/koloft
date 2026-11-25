import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackgroundFile } from '../../src/main/backgroundFile'
import { SessionStore } from '../../src/agents/kit/main/sessionStore'
import {
  SessionWorktrees,
  type WorktreesOfEveryAgent
} from '../../src/agents/kit/main/sessionWorktrees'
import type { TreeIo } from '../../src/main/sessionWorktrees'
import { worktreeRecordsOfEveryAgent } from '../../src/core/agent/worktreeRecords'
import { TreeRemovals } from '../../src/main/treeRemovals'
import { localGitOut } from '../../src/main/host/localHost'
import { removeTree } from '../../src/plugins/sessions/main/sessionClose'
import { removeUntouchedWorktreeWith } from '../../src/main/untouchedWorktreeRemoval'
import type { GitOut } from '../../src/core/worktree'
import type { BackendId } from '../../src/shared/types'
import { barePath, formatRemoteKey } from '../../src/shared/remoteKey'

const MACHINE = 'lab'

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

const gitOnTheirHost: GitOut = (dir, args, timeoutMs, onFailure) =>
  localGitOut(barePath(dir), args, timeoutMs, onFailure)

const SIDES = [
  { where: 'on this Mac', io: undefined, at: (p: string) => p },
  {
    where: 'on another machine over ssh',
    io: () => machineIo,
    at: (p: string) => formatRemoteKey(MACHINE, p)
  }
]

const LONG_ENOUGH_TO_TAKE_A_FOLDER_MS = 1000

const A = 'first-agent' as unknown as BackendId
const B = 'second-agent' as unknown as BackendId

let directory: string
let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-untouched-removal-')))
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
  await BackgroundFile.whenAllWritten()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe.each(SIDES)(
  'closing a tab whose untouched worktree is shared with another agent, $where',
  (side) => {
    let everyAgent: WorktreesOfEveryAgent
    let mine: SessionWorktrees
    let theirs: SessionWorktrees
    let close: (
      owner: BackendId,
      resource: Parameters<typeof removeUntouchedWorktreeWith>[2]
    ) => Promise<void>
    let removalHeld: Promise<void> | undefined
    let removalReached: () => void

    beforeEach(() => {
      removalHeld = undefined
      removalReached = () => {}
      const myStore = new SessionStore(path.join(directory, 'a-sessions.json'))
      const theirStore = new SessionStore(path.join(directory, 'b-sessions.json'))
      const records = worktreeRecordsOfEveryAgent(() => [
        { id: A, worktreeRecords: mine.records },
        { id: B, worktreeRecords: theirs.records }
      ])
      everyAgent = { recorded: (dir) => records.recorded(dir), preparing: new Map() }
      mine = new SessionWorktrees(myStore, everyAgent, side.io)
      theirs = new SessionWorktrees(theirStore, everyAgent, side.io)
      close = (owner, resource) =>
        removeUntouchedWorktreeWith(
          {
            sleeperTrees: () => [],
            cronRunner: null,
            sessionBackends: { occupantOf: () => null, worktreeRecords: records },
            worktreesOfEveryAgent: everyAgent,
            treeRemovals: new TreeRemovals(),
            removeTree: async (...args) => {
              removalReached()
              await removalHeld
              return removeTree(...args)
            },
            hostGitOut: gitOnTheirHost,
            dirExists: async (dir) => fs.existsSync(barePath(dir)),
            toast: (text) => {
              throw new Error(text)
            }
          },
          { id: owner },
          resource
        )
    })

    const stillThere = (tree: string): boolean =>
      fs.existsSync(path.join(barePath(tree), 'file.txt')) &&
      git('branch', '--list', 'worktree-foo') !== ''

    it('removes the folder and its branch when no other agent records it and none is preparing it', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      await close(A, made)
      expect(fs.existsSync(barePath(made.worktreePath))).toBe(false)
      expect(git('branch', '--list', 'worktree-foo')).toBe('')
    })

    it('keeps the folder and its branch while another agent that took it over has not launched in it yet', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      await theirs.adopt(side.at(repo), made.worktreePath)
      await close(A, made)
      expect(stillThere(made.worktreePath)).toBe(true)
    })

    it('keeps the folder and its branch while any agent, the closing one too, is still preparing it', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      let done = (): void => {}
      everyAgent.preparing.set(made.worktreePath, new Promise<void>((r) => (done = r)))
      await close(A, made)
      done()
      expect(stillThere(made.worktreePath)).toBe(true)
    })

    it('keeps the folder and its branch while another agent is still in the middle of taking it over for the first time', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      const taking = theirs.adopt(side.at(repo), made.worktreePath)
      await close(A, made)
      await taking
      expect(stillThere(made.worktreePath)).toBe(true)
    })

    it('a session of any agent that asks for the folder while the closing tab still checks whether it is untouched waits until the removal is over', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      const closing = close(A, made)
      let closed = false
      void closing.then(() => (closed = true))
      await mine.whenSettled(made.worktreePath)
      expect(closed).toBe(true)
      expect(fs.existsSync(barePath(made.worktreePath))).toBe(false)
    })

    async function whileTheRemovalRuns<T>(
      made: Parameters<typeof removeUntouchedWorktreeWith>[2],
      meanwhile: () => Promise<T>
    ): Promise<PromiseSettledResult<T>> {
      let release = (): void => {}
      removalHeld = new Promise<void>((r) => (release = r))
      const reached = new Promise<void>((r) => (removalReached = r))
      const closing = close(A, made)
      await reached
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

    it('another agent that starts a session in the folder while the removal runs waits for it and is refused, and records nothing ready', async () => {
      const made = await mine.create(side.at(repo), 'foo')
      const taking = await whileTheRemovalRuns(made, () =>
        theirs.adopt(side.at(repo), made.worktreePath)
      )
      expect(taking).toMatchObject({
        status: 'rejected',
        reason: new Error('The checkout is not a worktree of this repository')
      })
      expect(theirs.records.at(made.worktreePath)).toBeUndefined()
    })

    it.skipIf(side.io)(
      'another agent that recovers the folder while the removal runs waits for it, then makes the folder again and takes that',
      async () => {
        const made = await mine.create(side.at(repo), 'foo')
        const recovered = await whileTheRemovalRuns(made, () => theirs.recover(made.worktreePath))
        expect(recovered).toMatchObject({ status: 'fulfilled', value: { state: 'ready' } })
        expect(fs.existsSync(path.join(made.worktreePath, 'file.txt'))).toBe(true)
      }
    )
  }
)
