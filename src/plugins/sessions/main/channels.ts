import type { MainIpc } from '@core/ipc'
import { errorText } from '@core/errorText'
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
  SessionSearchHits
} from '@shared/types'
import { CHANNELS, type WorkspaceInstructionsChanged } from '../shared/ipc'
import { changeToUndo, NOT_READ, type ChangeToUndo } from '@core/ownerInstructions'

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
  instructionsSeen(workspacePath: string): Promise<void>
  undoInstructions(workspacePath: string, change: ChangeToUndo): Promise<void>
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
    done(deps.writeDefaults(workspacePath, raw))
  )
  ipc.handle(CHANNELS.instructionsSeen, (workspacePath: string) =>
    done(deps.instructionsSeen(workspacePath))
  )
  ipc.handle(CHANNELS.undoInstructions, (workspacePath: string, change: unknown) => {
    const read = changeToUndo(change)
    return read ? done(deps.undoInstructions(workspacePath, read)) : { ok: false, error: NOT_READ }
  })
}

const done = (work: Promise<void>): Promise<{ ok: boolean; error?: string }> =>
  work.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error: errorText(error) })
  )

export const pushes = (ipc: MainIpc) => ({
  sessions: (sessions: SessionInfo[]): boolean => ipc.push(CHANNELS.update, sessions),
  toolsChanged: (): boolean => ipc.push(CHANNELS.toolsChanged),
  relocated: (e: { tabId: string; dir: string }): boolean => ipc.push(CHANNELS.relocated, e),
  leftovers: (leftovers: Record<string, LeftoverProcess[]>): boolean =>
    ipc.push(CHANNELS.leftovers, leftovers),
  searchHits: (found: SessionSearchHits): boolean => ipc.push(CHANNELS.searchHits, found),
  attention: (pending: AttentionEvent[]): boolean => ipc.push(CHANNELS.attentionChanged, pending),
  activateTab: (tabId: string): boolean => ipc.push(CHANNELS.activateTab, { tabId }),
  instructionsChanged: (c: WorkspaceInstructionsChanged): boolean =>
    ipc.push(CHANNELS.instructionsChanged, c)
})
