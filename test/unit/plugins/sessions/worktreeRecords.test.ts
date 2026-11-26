import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'

vi.mock('electron', async () => {
  const nfs = await import('node:fs')
  const nos = await import('node:os')
  const npath = await import('node:path')
  const base = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'koloft-worktree-records-'))
  return { app: { getPath: () => base, getName: () => 'koloft-dev', isPackaged: false } }
})

afterAll(() => fs.rmSync(app.getPath('userData'), { recursive: true, force: true }))

import { SESSION_BACKENDS } from '@shared/sessionBackend'
import type { BackendId, WorktreeInfo } from '@shared/types'
import type { MainIpc } from '@core/ipc'
import { BackgroundFile } from '../../../../src/main/backgroundFile'
import { SessionBackends, type SessionBackend } from '../../../../src/core/agent/sessionBackends'
import type {
  WorktreeRecordsOfEveryAgent,
  WorktreeResource
} from '../../../../src/core/agent/worktreeRecords'
import { SessionStore, codexSessionKey } from '../../../../src/agents/kit/main/sessionStore'
import { SessionWorktrees } from '../../../../src/agents/kit/main/sessionWorktrees'
import { agyBackend } from '../../../../src/agents/agy/main/backend'
import { codexBackend } from '../../../../src/agents/codex/main/backend'
import type { ResumeProbes } from '../../../../src/main/resumePlan'
import {
  agySessionsIn,
  claudeBackendIn,
  codexSessionsIn,
  makeWorld,
  recordingPty,
  recordingSsh,
  type World
} from '../../helpers/agentTabs'
import { lifecycle, stubBackend } from '../../helpers/sessionBackendStub'
import { registerChannels } from '../../../../src/plugins/sessions/main/channels'
import { CHANNELS } from '../../../../src/plugins/sessions/shared/ipc'

const [KEEPS_NO_RECORDS, FIRST_KEEPER, SECOND_KEEPER] = SESSION_BACKENDS
const KEEPERS: readonly BackendId[] = [FIRST_KEEPER, SECOND_KEEPER]

interface Keeper {
  store: SessionStore
  worktrees: SessionWorktrees
}

interface EveryAgent {
  registry: SessionBackends
  records: WorktreeRecordsOfEveryAgent
  store(id: BackendId): SessionStore
  worktrees(id: BackendId): SessionWorktrees
}

let directory: string

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-worktree-records-')))
})

afterEach(async () => {
  await BackgroundFile.whenAllWritten()
  fs.rmSync(directory, { recursive: true, force: true })
})

function everyAgent(built: readonly BackendId[] = SESSION_BACKENDS): EveryAgent {
  const kept = new Map<BackendId, Keeper>()
  const registry = new SessionBackends(lifecycle())
  const worktreesOfEveryAgent = {
    recorded: (dir: string) => registry.worktreeRecords.recorded(dir),
    preparing: new Map<string, Promise<unknown>>()
  }
  for (const id of KEEPERS.filter((keeper) => built.includes(keeper))) {
    const store = new SessionStore(path.join(directory, `${id}-sessions.json`))
    kept.set(id, { store, worktrees: new SessionWorktrees(store, worktreesOfEveryAgent) })
  }
  for (const id of [...built].reverse()) {
    const records = kept.get(id)?.worktrees.records
    registry.register({ ...stubBackend(id), ...(records && { worktreeRecords: records }) })
  }
  return {
    registry,
    records: registry.worktreeRecords,
    store: (id) => kept.get(id)!.store,
    worktrees: (id) => kept.get(id)!.worktrees
  }
}

const REPO = '/repo'
const treeNamed = (name: string): string => `${REPO}/.claude/worktrees/${name}`

function recordOf(name: string, over: Partial<WorktreeResource> = {}): WorktreeResource {
  return {
    id: randomUUID(),
    originalCwd: REPO,
    worktreePath: treeNamed(name),
    worktreeName: name,
    worktreeBranch: `worktree-${name}`,
    originalHeadCommit: 'a'.repeat(40),
    state: 'ready',
    managed: true,
    ...over
  }
}

function gitRepo(): string {
  const repo = path.join(directory, 'repo')
  fs.mkdirSync(repo)
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('init', '--initial-branch=main')
  git('config', 'user.name', 'Worktree test')
  git('config', 'user.email', 'test@example.invalid')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n')
  git('add', 'file.txt')
  git('commit', '-m', 'Initial')
  return repo
}

function worktreeList(
  registry: SessionBackends,
  listedByGit: WorktreeInfo[],
  onDisk: string[]
): (workspace: string) => Promise<WorktreeInfo[]> {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const ipc: MainIpc = {
    handle: (channel, handler) => void handlers.set(channel, handler),
    on: () => {},
    onEvent: () => {},
    push: () => true
  }
  registerChannels(ipc, {
    backends: registry,
    worktrees: async () => listedByGit,
    dirExists: async (dir: string) => onDisk.includes(dir)
  } as unknown as Parameters<typeof registerChannels>[1])
  const list = handlers.get(CHANNELS.worktrees) as (workspace: string) => Promise<WorktreeInfo[]>
  return (workspace) => list(workspace)
}

describe('what each agent says about worktrees', () => {
  let world: World
  beforeEach(() => {
    world = makeWorld()
  })
  afterEach(() => world.gone())

  it('an agent that says it rebuilds worktrees answers with the record it keeps, and one that does not say so holds no record', async () => {
    const pty = recordingPty('pty-t1').pty
    const machine = { run: recordingSsh().run }
    const codex = codexSessionsIn(world, pty, {
      run: () => ({ code: 0, stdout: '', stderr: '' }),
      ranOnTheMachine: []
    })
    const agy = agySessionsIn(world, pty, { machine })
    const probes: ResumeProbes = {
      dirExists: () => true,
      occupantOf: () => null,
      branchExists: async () => false,
      headAt: async () => null
    }
    const backends: SessionBackend[] = [
      claudeBackendIn(world, pty, { machine }),
      codexBackend(
        codex,
        probes,
        () => probes,
        async () => {},
        async () => undefined
      ),
      agyBackend(agy, probes, () => probes)
    ]
    expect(backends.map((backend) => backend.id)).toEqual(SESSION_BACKENDS)
    const kept = recordOf('one')
    for (const sessions of [codex, agy]) sessions.store.putResource(kept)
    for (const backend of backends) {
      const records = backend.worktreeRecords
      const held = { of: records.of(REPO), at: records.at(kept.worktreePath) }
      expect(held, backend.id).toEqual(
        backend.recoversWorktrees ? { of: [kept], at: kept } : { of: [], at: undefined }
      )
      if (!backend.recoversWorktrees) expect(await records.untouched(kept), backend.id).toBe(false)
    }
  })
})

describe('the records agents keep of the worktrees they made', () => {
  it('a folder counts as recorded when any agent keeps a record of a worktree there', () => {
    const { records, store } = everyAgent()
    store(SECOND_KEEPER).putResource(recordOf('one'))
    expect(records.recorded(treeNamed('one'))).toBe(true)
    expect(records.recorded(treeNamed('two'))).toBe(false)
  })

  it('the record of a worktree is asked of the agent that ran the tab there, not of another agent that recorded the same folder, and that agent says whether anything touched the worktree since it was made', async () => {
    const repo = gitRepo()
    const { records, store, worktrees } = everyAgent()
    const made = await worktrees(FIRST_KEEPER).create(repo, 'one')
    const sameFolder = recordOf('one', { originalCwd: repo, worktreePath: made.worktreePath })
    store(SECOND_KEEPER).putResource(sameFolder)
    expect(records.at(FIRST_KEEPER, made.worktreePath)).toEqual(made)
    expect(records.at(SECOND_KEEPER, made.worktreePath)).toEqual(sameFolder)
    expect(records.at(KEEPS_NO_RECORDS, made.worktreePath)).toBeUndefined()
    expect(await records.untouched(FIRST_KEEPER, made)).toBe(true)
    fs.writeFileSync(path.join(made.worktreePath, 'new.txt'), 'work nobody committed\n')
    expect(await records.untouched(FIRST_KEEPER, made)).toBe(false)
  })

  it('once a worktree is removed every agent forgets its record of it, but keeps a record one of its own sessions still uses', () => {
    const { records, store } = everyAgent()
    const elsewhere = recordOf('two')
    const stillUsed = recordOf('one')
    store(FIRST_KEEPER).putResource(recordOf('one'))
    store(FIRST_KEEPER).putResource(elsewhere)
    store(SECOND_KEEPER).putResource(recordOf('one'))
    store(SECOND_KEEPER).putResource(stillUsed)
    const sessionId = randomUUID()
    store(SECOND_KEEPER).upsertMember({
      id: sessionId,
      key: codexSessionKey(sessionId),
      workspacePath: REPO,
      cwd: treeNamed('one'),
      title: 'Uses the worktree',
      createdAt: 1,
      updatedAt: 1,
      worktreeResourceId: stillUsed.id
    })
    records.forgetUnusedAt(treeNamed('one'))
    expect(store(FIRST_KEEPER).listResources()).toEqual([elsewhere])
    expect(store(SECOND_KEEPER).listResources()).toEqual([stillUsed])
  })

  it('the list of a workspace’s worktrees adds the ones an agent records that are gone from disk, each marked with the agent that can rebuild it, in the order of the list of agents', async () => {
    const { registry, store } = everyAgent()
    const goneAndUnlisted = recordOf('gone')
    const goneButListed = recordOf('listed')
    const failedHalfMade = recordOf('half-made', { state: 'failed', worktreeBranch: null })
    const goneOfTheLaterAgent = recordOf('gone-too')
    store(SECOND_KEEPER).putResource(goneButListed)
    store(SECOND_KEEPER).putResource(goneOfTheLaterAgent)
    store(SECOND_KEEPER).putResource(recordOf('still-there'))
    store(SECOND_KEEPER).putResource(recordOf('elsewhere', { originalCwd: '/another-repo' }))
    store(FIRST_KEEPER).putResource(goneAndUnlisted)
    store(FIRST_KEEPER).putResource(failedHalfMade)
    const list = worktreeList(
      registry,
      [
        { name: 'listed', dir: treeNamed('listed'), branch: 'worktree-listed' },
        { name: 'still-there', dir: treeNamed('still-there') }
      ],
      [treeNamed('still-there'), treeNamed('half-made')]
    )
    expect(await list(REPO)).toEqual([
      {
        name: 'listed',
        dir: treeNamed('listed'),
        branch: 'worktree-listed',
        recoveryResourceId: goneButListed.id,
        recoveryBackend: SECOND_KEEPER
      },
      { name: 'still-there', dir: treeNamed('still-there') },
      {
        name: 'gone',
        dir: treeNamed('gone'),
        branch: 'worktree-gone',
        recoveryResourceId: goneAndUnlisted.id,
        recoveryBackend: FIRST_KEEPER
      },
      {
        name: 'half-made',
        dir: treeNamed('half-made'),
        branch: undefined,
        recoveryResourceId: failedHalfMade.id,
        recoveryBackend: FIRST_KEEPER
      },
      {
        name: 'gone-too',
        dir: treeNamed('gone-too'),
        branch: 'worktree-gone-too',
        recoveryResourceId: goneOfTheLaterAgent.id,
        recoveryBackend: SECOND_KEEPER
      }
    ])
  })

  it('an agent whose session data could not be loaded is passed over by every question, without an error', async () => {
    const notBuilt = FIRST_KEEPER
    const { records, store } = everyAgent(SESSION_BACKENDS.filter((id) => id !== notBuilt))
    const kept = recordOf('one')
    store(SECOND_KEEPER).putResource(kept)
    expect(records.recorded(kept.worktreePath)).toBe(true)
    expect(records.at(notBuilt, kept.worktreePath)).toBeUndefined()
    expect(await records.untouched(notBuilt, kept)).toBe(false)
    expect(records.of(REPO)).toEqual([{ backendId: SECOND_KEEPER, record: kept }])
    records.forgetUnusedAt(kept.worktreePath)
    expect(store(SECOND_KEEPER).listResources()).toEqual([])
  })
})
