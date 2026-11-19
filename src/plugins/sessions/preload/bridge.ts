import type { PreloadIpc } from '@core/ipc'
import type {
  AttentionEvent,
  BackendAvailability,
  BackendId,
  LeftoverProcess,
  ListeningPort,
  ResumePlan,
  SessionDefaultsDraft,
  SessionDefaultsRead,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionSearchHits
} from '@shared/types'
import type { ChangeToUndo } from '@core/ownerInstructions'
import { CHANNELS, type WorkspaceInstructionsChanged } from '../shared/ipc'

export interface SessionsBridge {
  sessions: {
    backends(recheck?: boolean): Promise<BackendAvailability[]>
    installTool(backend: BackendId): Promise<{ tabId: string; cwd: string } | null>
    onToolsChanged(cb: () => void): () => void
    onUpdate(cb: (sessions: SessionInfo[]) => void): () => void
    onRelocated(cb: (e: { tabId: string; dir: string }) => void): () => void
    noteActivity(tabId: string): void
    list(): Promise<SessionInfo[]>
    resumePlan(sessionId: string): Promise<ResumePlan>
    resume(req: SessionResumeRequest): Promise<SessionResumeResult>
    archive(id: string): Promise<boolean>
    setResident(id: string, on: boolean): void
    forceClose(id: string): Promise<{ ok: boolean }>
    // CC§2
    transcriptExists(sessionId: string): Promise<boolean>
    noAccountToResume(sessionId: string): Promise<string | null>
    leftovers(): Promise<Record<string, LeftoverProcess[]>>
    onLeftovers(cb: (leftovers: Record<string, LeftoverProcess[]>) => void): () => void
    stopLeftover(sessionId: string, pid: number): Promise<boolean>
    ports(tabId: string): Promise<ListeningPort[] | null>
    search(searchId: number, term: string): void
    onSearchHits(cb: (found: SessionSearchHits) => void): () => void
  }
  attention: {
    list(): Promise<AttentionEvent[]>
    activeTab(id: string | null): void
    onActivateTab(cb: (tabId: string) => void): () => void
    onChanged(cb: (pending: AttentionEvent[]) => void): () => void
  }
  sessionDefaults: {
    read(workspacePath: string): Promise<SessionDefaultsRead>
    write(
      workspacePath: string,
      defaults: SessionDefaultsDraft
    ): Promise<{ ok: boolean; error?: string }>
    instructionsSeen(workspacePath: string): Promise<{ ok: boolean; error?: string }>
    undoInstructions(
      workspacePath: string,
      change: ChangeToUndo
    ): Promise<{ ok: boolean; error?: string }>
    onInstructionsChanged(cb: (c: WorkspaceInstructionsChanged) => void): () => void
  }
}

export const bridge = (ipc: PreloadIpc): SessionsBridge => ({
  sessions: {
    backends: (recheck) => ipc.invoke(CHANNELS.backends, recheck === true),
    installTool: (backend) => ipc.invoke(CHANNELS.installTool, backend),
    onToolsChanged: (cb) => ipc.listen(CHANNELS.toolsChanged, () => cb()),
    onUpdate: (cb) => ipc.listen(CHANNELS.update, cb),
    onRelocated: (cb) => ipc.listen(CHANNELS.relocated, cb),
    noteActivity: (tabId) => ipc.send(CHANNELS.activity, tabId),
    list: () => ipc.invoke(CHANNELS.list),
    resumePlan: (id) => ipc.invoke(CHANNELS.resumePlan, id),
    resume: (req) => ipc.invoke(CHANNELS.resume, req),
    archive: (id) => ipc.invoke(CHANNELS.archive, id),
    setResident: (id, on) => ipc.send(CHANNELS.setResident, id, on),
    forceClose: (id) => ipc.invoke(CHANNELS.forceClose, id),
    transcriptExists: (id) => ipc.invoke(CHANNELS.transcriptExists, id),
    noAccountToResume: (id) => ipc.invoke(CHANNELS.noAccountToResume, id),
    leftovers: () => ipc.invoke(CHANNELS.leftovers),
    onLeftovers: (cb) => ipc.listen(CHANNELS.leftovers, cb),
    stopLeftover: (sessionId, pid) => ipc.invoke(CHANNELS.stopLeftover, sessionId, pid),
    ports: (tabId) => ipc.invoke(CHANNELS.ports, tabId),
    search: (searchId, term) => ipc.send(CHANNELS.search, searchId, term),
    onSearchHits: (cb) => ipc.listen(CHANNELS.searchHits, cb)
  },
  attention: {
    list: () => ipc.invoke(CHANNELS.attentionList),
    activeTab: (id) => ipc.send(CHANNELS.activeTab, id),
    onActivateTab: (cb) => ipc.listen(CHANNELS.activateTab, (p: { tabId: string }) => cb(p.tabId)),
    onChanged: (cb) => ipc.listen(CHANNELS.attentionChanged, cb)
  },
  sessionDefaults: {
    read: (workspacePath) => ipc.invoke(CHANNELS.defaultsRead, workspacePath),
    write: (workspacePath, defaults) => ipc.invoke(CHANNELS.defaultsWrite, workspacePath, defaults),
    instructionsSeen: (workspacePath) => ipc.invoke(CHANNELS.instructionsSeen, workspacePath),
    undoInstructions: (workspacePath, change) =>
      ipc.invoke(CHANNELS.undoInstructions, workspacePath, change),
    onInstructionsChanged: (cb) => ipc.listen(CHANNELS.instructionsChanged, cb)
  }
})
