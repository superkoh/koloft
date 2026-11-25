import type {
  AttentionSubject,
  BackendAvailability,
  BackendId,
  BackendSessionInfo,
  BackendSessionRow,
  CreateTabOptions,
  CreateTabResult,
  DocVerdict,
  ResumePlan,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionRow
} from '@shared/types'
import type { AskPayload, SessionEvent } from '@shared/sessionEvent'
import type { Turn } from '@shared/turns'
import {
  worktreeRecordsOfEveryAgent,
  type WorktreeRecords,
  type WorktreeRecordsOfEveryAgent
} from './worktreeRecords'
import { identityOf, sourceOf, SESSION_BACKENDS } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { TabEnded } from '../moment'
import type { TranscriptPlaces } from '../transcriptPlaces'
import { rowsOfEveryAgent, type RowsOfEveryAgent, type SessionRowsSource } from './sessionRows'
import type { MirrorFolder } from './mirrorFolders'

export type ModeClass = 'bypass' | 'prompting'

export type SentNote = { id: string } | { words: string }

export type MessageToSend = {
  text: string
  senderPermission: ModeClass
  koloftWroteTheOpening: boolean
} & ({ handedOverAs: string } | { sentBy: string; until: number })

export type SendOutcome = 'taken' | 'only-its-terminal-takes-it'

export interface SessionMessages {
  send(tabId: string, m: MessageToSend): Promise<SendOutcome>
  mightNotTakeAMessageNow(
    tabId: string,
    turnHasEnded: (tabId: string) => Promise<boolean>
  ): Promise<boolean>
}

export type TabExit = Pick<TabEnded, 'tabId' | 'exitCode' | 'signal' | 'crashed'>

export interface SessionBackend extends SessionRowsSource, SessionMessages {
  id: BackendId
  recoversWorktrees?: true
  availability(): Promise<BackendAvailability>
  forgetAvailability(): void
  list(): BackendSessionInfo[]
  historyRows(workspacePath: string): Promise<BackendSessionRow[]>
  create(spec: CreateTabOptions): Promise<CreateTabResult>
  resume(request: SessionResumeRequest): Promise<SessionResumeResult>
  resumePlan(key: string): Promise<ResumePlan>
  hasTab(tabId: string): boolean
  workspaceOfTab(tabId: string): string | undefined
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, restarting?: boolean): void | Promise<void>
  archive(key: string): boolean
  adopt(keys: string[]): void
  transcriptExists(key: string): boolean | Promise<boolean>
  observe(tabId: string, event: SessionEvent): void
  occupantOf(dir: string): string | null
  accountUsable(): boolean
  trustsFolder(dir: string): boolean | Promise<boolean>
  turns(key: string, n: number): Promise<Turn[]>
  transcriptPlaces(key: string): TranscriptPlaces | undefined
  permissionClass(tabId: string): ModeClass
  peerNames(): (key: string) => Promise<string | null>
  runningElsewhere(key: string): boolean | Promise<boolean>
  workStillRunning(tabId: string): Promise<boolean>
  worktreeRecords: WorktreeRecords
  tabExited(exit: TabExit): void | Promise<void>
  quitWaitsForIt(): boolean
  endBeforeQuit(): Promise<void>
  flushSync(): void
  beforeWorkspaceRemoved(workspace: string): Promise<void>
  showsPromptBeforeBind(tabId: string): boolean
  sessionGone(key: string): boolean
  noticeRemoteExits(host: string, sessionIds: string[]): void
  mirrorPulled(host: string): void
  foldersToMirrorFrom(host: string, landing: string): MirrorFolder[]
  tmuxOfTab(tabId: string): string | undefined
  tabOfTmuxSession(host: string, name: string): string | undefined
  showsAPanel(tabId: string, screen?: string[]): Promise<boolean | undefined>
}

export interface SessionLifecycle {
  prompted(tabId: string): void
  bound(tabId: string, key: string, idleCompaction: boolean): void
  exited(tabId: string, subject: AttentionSubject): void
  clearAttention(tabId: string): void
  open(tabId: string, target: string): void
  turnEnded(tabId: string, turn: Turn): void
  asked(tabId: string, ask: AskPayload, id: string): void
}

const CLEAN_EXIT_HIDES_A_LATER_EXIT_MS = 30_000

export class SessionBackends {
  private adapters = new Map<BackendId, SessionBackend>()
  private cleanExitAt = new Map<string, number>()
  private questionsAsked = 0
  private agentsAtQuit: 'not asked to end' | 'ending' | 'ended' = 'not asked to end'
  isKoloftsOwnSession: (tabOrSessionId: string) => boolean = () => false
  turnOver: (tabId: string) => boolean = () => false
  askingOf: (tabId: string) => string | undefined = () => undefined
  verdictsOnFilesOf: (sessionId: string) => Record<string, DocVerdict> | undefined = () => undefined
  noAccountMessage: (backend: BackendId) => string = (backend) => NO_USABLE_ACCOUNT[backend]
  turnedOff: (backend: BackendId) => string | null = () => null
  readonly rows: RowsOfEveryAgent = rowsOfEveryAgent(() =>
    this.builtInListOrder().map((backend) => ({ id: backend.id, rows: backend }))
  )
  readonly worktreeRecords: WorktreeRecordsOfEveryAgent = worktreeRecordsOfEveryAgent(() =>
    this.builtInListOrder()
  )

  constructor(private lifecycle: SessionLifecycle) {}

  private builtInListOrder(): SessionBackend[] {
    return SESSION_BACKENDS.flatMap((id) => {
      const backend = this.adapters.get(id)
      return backend ? [backend] : []
    })
  }

  observe(tabId: string, event: SessionEvent): void {
    switch (event.type) {
      case 'bound':
        this.cleanExitAt.delete(tabId)
        if (!event.idleCompaction) this.lifecycle.clearAttention(tabId)
        return this.lifecycle.bound(tabId, event.key, !!event.idleCompaction)
      case 'exited':
        return this.exited(tabId, event.clean, { title: event.title, sessionId: event.sessionId })
      case 'open':
        return this.lifecycle.open(tabId, event.target)
      case 'turn-ended':
        return this.lifecycle.turnEnded(tabId, event.turn)
      case 'asked':
        return this.lifecycle.asked(tabId, event.ask, String(++this.questionsAsked))
      case 'prompt':
        this.lifecycle.prompted(tabId)
    }
    this.ownerOfTab(tabId)?.observe(tabId, event)
  }

  private exited(tabId: string, clean: boolean, subject: AttentionSubject): void {
    const now = Date.now()
    for (const [id, at] of this.cleanExitAt) {
      if (now - at > CLEAN_EXIT_HIDES_A_LATER_EXIT_MS) this.cleanExitAt.delete(id)
    }
    if (clean) {
      this.cleanExitAt.set(tabId, now)
      this.lifecycle.clearAttention(tabId)
    } else if (!this.cleanExitAt.has(tabId)) this.lifecycle.exited(tabId, subject)
  }

  register(adapter: SessionBackend): void {
    if (this.adapters.has(adapter.id))
      throw new Error(`Session backend already registered: ${adapter.id}`)
    this.adapters.set(adapter.id, adapter)
  }

  get(id: BackendId): SessionBackend {
    const backend = this.adapters.get(id)
    if (!backend) throw new Error(`Session backend is unavailable: ${id}`)
    return backend
  }

  private ownerOfSession(key: string): SessionBackend | undefined {
    const identity = identityOf(key)
    return identity && this.get(identity.backendId)
  }

  aliveTabFor(key: string): string | undefined {
    return this.ownerOfSession(key)?.aliveTabFor(key)
  }

  transcriptExists(key: string): boolean | Promise<boolean> {
    return this.ownerOfSession(key)?.transcriptExists(key) ?? false
  }

  noAccountToResume(key: string): string | null {
    const owner = this.ownerOfSession(key)
    return owner ? this.noUsableAccount(owner.id) : null
  }

  resumePlan(key: string): Promise<ResumePlan> {
    return (
      this.ownerOfSession(key)?.resumePlan(key) ??
      Promise.resolve({ action: 'unavailable', reason: 'not-found' })
    )
  }

  resume(request: SessionResumeRequest): Promise<SessionResumeResult> {
    return (
      this.ownerOfSession(request.sessionId)?.resume(request) ??
      Promise.resolve({ ok: false, code: 'invalid-args' })
    )
  }

  archive(key: string): boolean {
    return this.ownerOfSession(key)?.archive(key) ?? false
  }

  occupantOf(dir: string): string | null {
    for (const backend of this.adapters.values()) {
      const occupant = backend.occupantOf(dir)
      if (occupant) return occupant
    }
    return null
  }

  ownerOfTab(tabId: string): SessionBackend | undefined {
    return [...this.adapters.values()].find((backend) => backend.hasTab(tabId))
  }

  workspaceOfTab(tabId: string): string | undefined {
    return this.ownerOfTab(tabId)?.workspaceOfTab(tabId)
  }

  showsAPanel(tabId: string, screen?: string[]): Promise<boolean | undefined> {
    const session = this.list().find((s) => s.tabId === tabId)
    return session
      ? this.get(session.backendId).showsAPanel(tabId, screen)
      : Promise.resolve(undefined)
  }

  availability(
    unregistered: (id: BackendId) => BackendAvailability
  ): Promise<BackendAvailability[]> {
    return Promise.all(
      SESSION_BACKENDS.map((id) => {
        const backend = this.adapters.get(id)
        return backend ? backend.availability() : unregistered(id)
      })
    )
  }

  forgetAvailability(): void {
    for (const backend of this.adapters.values()) backend.forgetAvailability()
  }

  list(): SessionInfo[] {
    return [...this.adapters.values()].flatMap((backend) =>
      backend.list().map((s): SessionInfo => ({
        ...s,
        backendId: backend.id,
        host: s.remote ? 'ssh' : hostOf(s.cwd),
        nativeSessionId: s.nativeSessionId ?? s.sessionId,
        overseer: this.isKoloftsOwnSession(s.tabId) || this.isKoloftsOwnSession(s.sessionId),
        turnOver: this.turnOver(s.tabId),
        asking: this.askingOf(s.tabId),
        docVerdicts: s.sessionId ? this.verdictsOnFilesOf(s.sessionId) : undefined
      }))
    )
  }

  turns(key: string, n: number): Promise<Turn[]> {
    return this.ownerOfSession(key)?.turns(key, n) ?? Promise.resolve([])
  }

  transcriptPlaces(key: string): TranscriptPlaces | undefined {
    return this.ownerOfSession(key)?.transcriptPlaces(key)
  }

  permissionClass(tabId: string): ModeClass {
    return this.ownerOfTab(tabId)?.permissionClass(tabId) ?? 'prompting'
  }

  send(backend: BackendId, tabId: string, m: MessageToSend): Promise<SendOutcome> {
    return this.get(backend).send(tabId, m)
  }

  mightNotTakeAMessageNow(
    backend: BackendId,
    tabId: string,
    turnHasEnded: (tabId: string) => Promise<boolean>
  ): Promise<boolean> {
    return this.get(backend).mightNotTakeAMessageNow(tabId, turnHasEnded)
  }

  peerNames(): (s: { backendId: BackendId; sessionId: string }) => Promise<string | null> {
    const lookups = new Map<BackendId, (key: string) => Promise<string | null>>()
    return async ({ backendId, sessionId }) => {
      const backend = this.adapters.get(backendId)
      if (!backend) return null
      const lookup = lookups.get(backendId) ?? backend.peerNames()
      lookups.set(backendId, lookup)
      return lookup(sessionId)
    }
  }

  async runningElsewhere(backendId: BackendId, key: string): Promise<boolean> {
    return (await this.adapters.get(backendId)?.runningElsewhere(key)) ?? false
  }

  async workStillRunning(tabId: string): Promise<boolean> {
    return (await this.ownerOfTab(tabId)?.workStillRunning(tabId)) ?? false
  }

  tabExited(exit: TabExit, endFailed: (error: unknown) => void): void {
    for (const backend of this.builtInListOrder())
      void Promise.resolve(backend.tabExited(exit)).catch(endFailed)
  }

  holdsQuitUntilAgentsEnded(
    quit: () => void,
    endFailed: (backend: BackendId, error: unknown) => void
  ): boolean {
    const backends = this.builtInListOrder()
    if (this.agentsAtQuit === 'ended' || !backends.some((b) => b.quitWaitsForIt())) return false
    if (this.agentsAtQuit === 'not asked to end') {
      this.agentsAtQuit = 'ending'
      void Promise.all(
        backends.map((b) => b.endBeforeQuit().catch((error) => endFailed(b.id, error)))
      ).finally(() => {
        this.agentsAtQuit = 'ended'
        quit()
      })
    }
    return true
  }

  flushSync(): void {
    for (const backend of this.builtInListOrder()) backend.flushSync()
  }

  async beforeWorkspaceRemoved(workspace: string): Promise<void> {
    await Promise.all(this.builtInListOrder().map((b) => b.beforeWorkspaceRemoved(workspace)))
  }

  showsPromptBeforeBind(tabId: string): boolean {
    return this.builtInListOrder().some((backend) => backend.showsPromptBeforeBind(tabId))
  }

  sessionStillThere(key: string, foundOrRunning: ReadonlySet<string>): boolean {
    if (foundOrRunning.has(key)) return true
    const identity = identityOf(key)
    if (!identity) return false
    const backend = this.adapters.get(identity.backendId)
    return !backend || !backend.sessionGone(key)
  }

  noticeRemoteExits(host: string, sessionIds: string[]): void {
    for (const backend of this.builtInListOrder()) backend.noticeRemoteExits(host, sessionIds)
  }

  mirrorPulled(host: string): void {
    for (const backend of this.builtInListOrder()) backend.mirrorPulled(host)
  }

  foldersToMirrorFrom(host: string, landing: string): MirrorFolder[] {
    const folders = this.builtInListOrder().flatMap((b) => b.foldersToMirrorFrom(host, landing))
    return [
      ...folders.filter((f) => f.holds === 'records'),
      ...folders.filter((f) => f.holds === 'usage')
    ]
  }

  tmuxOfTab(tabId: string): string | undefined {
    for (const backend of this.builtInListOrder()) {
      const name = backend.tmuxOfTab(tabId)
      if (name !== undefined) return name
    }
    return undefined
  }

  tabOfTmuxSession(host: string, name: string): string | undefined {
    for (const backend of this.builtInListOrder()) {
      const tabId = backend.tabOfTmuxSession(host, name)
      if (tabId !== undefined) return tabId
    }
    return undefined
  }

  async historyRows(
    workspacePath: string,
    partlyUnread: (backend: BackendId, error: unknown) => void
  ): Promise<SessionRow[]> {
    const backends = [...this.adapters.values()]
    const answers = await Promise.allSettled(backends.map((b) => b.historyRows(workspacePath)))
    const rows: SessionRow[] = []
    const failures: { id: BackendId; error: unknown }[] = []
    answers.forEach((answer, i) => {
      if (answer.status === 'fulfilled')
        rows.push(
          ...answer.value.map((r) => ({ ...r, ...sourceOf(backends[i].id, workspacePath) }))
        )
      else failures.push({ id: backends[i].id, error: answer.reason })
    })
    if (failures.length && !rows.length) throw failures[0].error
    for (const f of failures) partlyUnread(f.id, f.error)
    return rows.filter((r) => !this.isKoloftsOwnSession(r.id)).sort((a, b) => b.mtime - a.mtime)
  }

  adopt(rows: readonly Pick<SessionRow, 'id' | 'backendId'>[]): void {
    for (const backend of this.adapters.values())
      backend.adopt(rows.filter((r) => r.backendId === backend.id).map((r) => r.id))
  }

  create(options: CreateTabOptions): Promise<CreateTabResult> {
    if (options.kind === 'shell') throw new Error('A utility terminal is not a session.')
    if (
      !SESSION_BACKENDS.includes(options.kind) ||
      options.util ||
      (options.worktreeResourceId && !this.adapters.get(options.kind)?.recoversWorktrees)
    ) {
      return Promise.resolve({ ok: false, code: 'invalid-args' })
    }
    const refused =
      (!options.resumeSessionId && this.turnedOff(options.kind)) ||
      this.noUsableAccount(options.kind)
    if (refused) return Promise.reject(new Error(refused))
    return this.get(options.kind).create(options)
  }

  // ADR-0030
  noUsableAccount(kind: BackendId): string | null {
    return this.get(kind).accountUsable() ? null : this.noAccountMessage(kind)
  }
}
