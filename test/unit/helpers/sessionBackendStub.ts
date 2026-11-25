import { vi } from 'vitest'
import type { SessionBackend } from '../../../src/core/agent/sessionBackends'
import { KEEPS_NO_WORKTREE_RECORDS } from '../../../src/core/agent/worktreeRecords'
import { rowsKeptInMemory } from '../../../src/agents/kit/main/rowsKeptInMemory'
import type { BackendId, BackendSessionInfo, BackendSessionRow } from '@shared/types'

export function stubBackend(
  id: BackendId,
  rows: () => Promise<BackendSessionRow[]> = async () => [],
  sessions: BackendSessionInfo[] = []
) {
  return {
    id,
    availability: async () => ({ id, available: true }),
    list: () => sessions,
    historyRows: rows,
    create: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    resume: async () => ({ ok: true as const, id: 'tab', cwd: '/repo' }),
    forgetAvailability: () => {},
    resumePlan: async () => ({ action: 'unavailable' as const, reason: 'not-found' as const }),
    hasTab: () => false,
    workspaceOfTab: () => undefined,
    aliveTabFor: () => undefined,
    stop: () => {},
    archive: () => true,
    adopt: () => {},
    transcriptExists: () => true,
    observe: () => {},
    occupantOf: () => null,
    worktreeRecords: KEEPS_NO_WORKTREE_RECORDS,
    accountUsable: () => true,
    trustsFolder: () => true,
    turns: async () => [],
    transcriptPlaces: () => undefined,
    permissionClass: () => 'prompting' as const,
    peerNames: () => async () => null,
    runningElsewhere: () => false,
    workStillRunning: async () => false,
    tabExited: () => {},
    quitWaitsForIt: () => false,
    endBeforeQuit: async () => {},
    flushSync: () => {},
    beforeWorkspaceRemoved: async () => {},
    showsPromptBeforeBind: () => false,
    sessionGone: () => false,
    noticeRemoteExits: () => {},
    mirrorPulled: () => {},
    foldersToMirrorFrom: () => [],
    tmuxOfTab: () => undefined,
    showsAPanel: async () => undefined,
    send: async () => 'taken' as const,
    mightNotTakeAMessageNow: async () => false,
    handOverLaunch: (): never => {
      throw new Error('a stub backend starts no session handed over')
    },
    ...rowsKeptInMemory({
      rows: () => [],
      members: () => new Set<string>(),
      localHistoryFolders: async () => []
    })
  } satisfies SessionBackend
}

export const lifecycle = () => ({
  prompted: vi.fn(),
  bound: vi.fn(),
  exited: vi.fn(),
  clearAttention: vi.fn(),
  open: vi.fn(),
  turnEnded: vi.fn(),
  asked: vi.fn()
})
