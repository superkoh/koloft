import type { MainIpc } from '@core/ipc'
import { errorText } from '@core/errorText'
import { ChangedWhileOpen } from '@core/ownerInstructions'
import { backendIdOf } from '@shared/sessionBackend'
import type {
  AttentionEvent,
  BackendAvailability,
  BackendId,
  LeftoverProcess,
  ListeningPort,
  ResumePlan,
  SessionDefaultsRead,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionSearchHits,
  WorktreeInfo
} from '@shared/types'
import { CHANNELS, type InstructionsSaveResult } from '../shared/ipc'
import type { InstructionAskView } from '../shared/instructionAsks'
import type { InstructionAsks } from './instructionAsks'
import type { SessionsWithStore } from './storedSessions'

interface SessionBackend {
  id: BackendId
  aliveTabFor(key: string): string | undefined
  transcriptExists(key: string): boolean | Promise<boolean>
  resumePlan(key: string): Promise<ResumePlan>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
}

export interface Backends {
  forSession(key: string): SessionBackend
  noUsableAccount(kind: BackendId): string | null
  forgetAvailability(): void
}

export interface ChannelDeps {
  backends: Backends
  noteActivity(tabId: string): void
  installed(): Promise<BackendAvailability[]>
  installTool(backend: BackendId): { tabId: string; cwd: string } | null
  list(): SessionInfo[]
  archive(id: string): boolean
  setResident(id: string, on: boolean): void
  killTab(tabId: string): Promise<boolean>
  closingLoses(sessionId: string): Promise<string[]>
  closeFully(sessionId: string): Promise<boolean>
  leftovers(): Record<string, LeftoverProcess[]>
  stopLeftover(sessionId: string, pid: number): Promise<boolean>
  ports(tabId: string): Promise<ListeningPort[] | null>
  search(searchId: number, term: string): void
  attention(): AttentionEvent[]
  lookedAt(tabId: string | null): void
  readDefaults(
    workspacePath: string
  ): Promise<Omit<Extract<SessionDefaultsRead, { ok: true }>, 'ok'>>
  writeDefaults(workspacePath: string, raw: unknown): Promise<void>
  saveEveryWorkspace(text: string, opened: string): InstructionsSaveResult
  instructionAsks(): Pick<InstructionAsks, 'views' | 'answer'>
  worktrees(workspacePath: string): Promise<WorktreeInfo[]>
  storedSessions(): Pick<SessionsWithStore, 'id' | 'store'>[]
  dirExists(dir: string): Promise<boolean>
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  const { backends } = deps
  // PLATFORM§21
  ipc.on(CHANNELS.activity, (id: unknown) => {
    if (typeof id === 'string' && id) deps.noteActivity(id)
  })
  ipc.handle(CHANNELS.list, () => deps.list())
  ipc.handle(CHANNELS.backends, (recheck: unknown) => {
    if (recheck === true) backends.forgetAvailability()
    return deps.installed()
  })
  ipc.handle(CHANNELS.installTool, (backend: unknown) => {
    const id = backendIdOf(backend)
    return id ? deps.installTool(id) : null
  })
  ipc.handle(CHANNELS.archive, (id: unknown): boolean => {
    if (typeof id !== 'string' || !id) return false
    return deps.archive(id)
  })
  ipc.on(CHANNELS.setResident, (id: unknown, on: unknown) => {
    if (typeof id !== 'string' || !id || typeof on !== 'boolean') return
    deps.setResident(id, on)
  })
  ipc.handle(CHANNELS.forceClose, async (id: unknown): Promise<{ ok: boolean }> => {
    if (typeof id !== 'string' || !id) return { ok: false }
    const tabId = backends.forSession(id).aliveTabFor(id)
    if (!tabId) return { ok: false }
    return { ok: await deps.killTab(tabId) }
  })
  ipc.handle(CHANNELS.closingLoses, async (id: unknown): Promise<string[]> =>
    typeof id === 'string' && id ? deps.closingLoses(id) : []
  )
  ipc.handle(CHANNELS.closeFully, async (id: unknown): Promise<boolean> =>
    typeof id === 'string' && id ? deps.closeFully(id) : false
  )
  // CC§2
  ipc.handle(CHANNELS.transcriptExists, (id: unknown): boolean | Promise<boolean> => {
    if (typeof id !== 'string' || !id) return false
    return backends.forSession(id).transcriptExists(id)
  })
  ipc.handle(CHANNELS.noAccountToResume, (id: unknown): string | null => {
    if (typeof id !== 'string' || !id) return null
    return backends.noUsableAccount(backends.forSession(id).id)
  })
  ipc.on(CHANNELS.search, (searchId: unknown, term: unknown) => {
    if (typeof searchId !== 'number' || typeof term !== 'string') return
    deps.search(searchId, term)
  })
  ipc.handle(CHANNELS.leftovers, () => deps.leftovers())
  ipc.handle(CHANNELS.ports, (tabId: unknown) =>
    typeof tabId === 'string' ? deps.ports(tabId) : null
  )
  ipc.handle(CHANNELS.stopLeftover, (sessionId: unknown, pid: unknown) =>
    typeof sessionId === 'string' && typeof pid === 'number'
      ? deps.stopLeftover(sessionId, pid)
      : false
  )
  ipc.handle(CHANNELS.resumePlan, (id: unknown): Promise<ResumePlan> => {
    if (typeof id !== 'string' || !id) {
      return Promise.resolve({ action: 'unavailable', reason: 'not-found' })
    }
    return backends.forSession(id).resumePlan(id)
  })
  ipc.handle(CHANNELS.resume, (req: SessionResumeRequest) => {
    if (typeof req?.sessionId !== 'string') return { ok: false, code: 'invalid-args' }
    return backends.forSession(req.sessionId).resume(req)
  })
  ipc.handle(CHANNELS.attentionList, () => deps.attention())
  ipc.on(CHANNELS.activeTab, (id: string | null) => {
    deps.lookedAt(typeof id === 'string' && id ? id : null)
  })
  ipc.handle(CHANNELS.defaultsRead, async (workspacePath: string): Promise<SessionDefaultsRead> => {
    try {
      return { ok: true, ...(await deps.readDefaults(workspacePath)) }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
  ipc.handle(CHANNELS.defaultsWrite, (workspacePath: string, raw: unknown) =>
    deps.writeDefaults(workspacePath, raw).then(
      () => ({ ok: true }),
      (error: unknown) => ({
        ok: false,
        error: errorText(error),
        ...(error instanceof ChangedWhileOpen && { inUse: error.inUse })
      })
    )
  )
  ipc.handle(
    CHANNELS.everyWorkspaceSave,
    (text: unknown, opened: unknown): InstructionsSaveResult =>
      typeof text === 'string' && typeof opened === 'string'
        ? deps.saveEveryWorkspace(text, opened)
        : { ok: false, error: 'Koloft could not read the text.' }
  )
  ipc.handle(CHANNELS.instructionAsksList, () => deps.instructionAsks().views())
  ipc.on(CHANNELS.instructionAnswer, (id: unknown, agreed: unknown) => {
    if (typeof id === 'string' && typeof agreed === 'boolean')
      deps.instructionAsks().answer(id, agreed)
  })
  ipc.handle(CHANNELS.worktrees, async (p: string) => {
    const trees = await deps.worktrees(p)
    for (const stored of deps.storedSessions()) {
      const mine = stored.store.listResources().filter((r) => r.originalCwd === p)
      const there = await Promise.all(
        mine.map((r) => r.state === 'ready' && deps.dirExists(r.worktreePath))
      )
      for (const [i, resource] of mine.entries()) {
        if (there[i]) continue
        const existing = trees.find((t) => t.dir === resource.worktreePath)
        if (existing) {
          existing.recoveryResourceId = resource.id
          existing.recoveryBackend = stored.id
        } else
          trees.push({
            name: resource.worktreeName,
            dir: resource.worktreePath,
            branch: resource.worktreeBranch ?? undefined,
            recoveryResourceId: resource.id,
            recoveryBackend: stored.id
          })
      }
    }
    return trees
  })
}

export const pushes = (ipc: MainIpc) => ({
  sessions: (sessions: SessionInfo[]): boolean => ipc.push(CHANNELS.update, sessions),
  toolsChanged: (): boolean => ipc.push(CHANNELS.toolsChanged),
  relocated: (e: { tabId: string; dir: string }): boolean => ipc.push(CHANNELS.relocated, e),
  leftovers: (leftovers: Record<string, LeftoverProcess[]>): boolean =>
    ipc.push(CHANNELS.leftovers, leftovers),
  searchHits: (found: SessionSearchHits): boolean => ipc.push(CHANNELS.searchHits, found),
  attention: (pending: AttentionEvent[]): boolean => ipc.push(CHANNELS.attentionChanged, pending),
  activateTab: (tabId: string): boolean => ipc.push(CHANNELS.activateTab, { tabId }),
  instructionAsks: (asks: InstructionAskView[]): boolean => ipc.push(CHANNELS.instructionAsks, asks)
})
