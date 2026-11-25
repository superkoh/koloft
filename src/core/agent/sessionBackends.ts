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
import { identityOf, sourceOf, SESSION_BACKENDS } from '@shared/sessionBackend'
import { hostOf } from '@shared/remoteKey'
import { NO_USABLE_ACCOUNT } from '@shared/accountUsage'
import type { TabEnded } from '../moment'
import type { TranscriptPlaces } from '../transcriptPlaces'
import { rowsOfEveryAgent, type RowsOfEveryAgent, type SessionRowsSource } from './sessionRows'

export type ModeClass = 'bypass' | 'prompting'

export type TabExit = Pick<TabEnded, 'tabId' | 'exitCode' | 'signal' | 'crashed'>

export interface TabEndsWiredByHand {
  id: BackendId
  onPtyExit(tabId: string, crashed: boolean): void
  setAlive(tabId: string, alive: boolean): void
  launchEnded(tabId: string): void
}

export interface StoredWiredByHand {
  id: BackendId
  store: { flushSync(): void }
  rows(workspace: string): BackendSessionRow[]
  threadGone(key: string): boolean
  hasProcesses(): boolean
  stopAll(): Promise<void>
  hasTab(tabId: string): boolean
  aliveTabFor(key: string): string | undefined
  stop(tabId: string, nativeExitCode?: number): Promise<void>
  showsPromptBeforeBind?(tabId: string): boolean
}

export interface SessionBackend extends SessionRowsSource {
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
  private quitEnding = false
  private quitEnded = false
  tabEndsByHand: TabEndsWiredByHand | undefined
  storedByHand: () => readonly StoredWiredByHand[] = () => []
  isOverseerSession: (tabOrSessionId: string) => boolean = () => false
  turnOver: (tabId: string) => boolean = () => false
  askingOf: (tabId: string) => string | undefined = () => undefined
  docVerdictsOf: (sessionId: string) => Record<string, DocVerdict> | undefined = () => undefined
  noAccountMessage: (backend: BackendId) => string = (backend) => NO_USABLE_ACCOUNT[backend]
  turnedOff: (backend: BackendId) => string | null = () => null
  readonly rows: RowsOfEveryAgent = rowsOfEveryAgent(() =>
    SESSION_BACKENDS.flatMap((id) => {
      const backend = this.adapters.get(id)
      return backend ? [{ id, rows: backend }] : []
    })
  )

  constructor(private lifecycle: SessionLifecycle) {}

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

  forSession(key: string): SessionBackend {
    return this.get(identityOf(key).backendId)
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
        overseer: this.isOverseerSession(s.tabId) || this.isOverseerSession(s.sessionId),
        turnOver: this.turnOver(s.tabId),
        asking: this.askingOf(s.tabId),
        docVerdicts: s.sessionId ? this.docVerdictsOf(s.sessionId) : undefined
      }))
    )
  }

  turns(key: string, n: number): Promise<Turn[]> {
    return this.forSession(key).turns(key, n)
  }

  transcriptPlaces(key: string): TranscriptPlaces | undefined {
    return this.forSession(key).transcriptPlaces(key)
  }

  permissionClass(tabId: string): ModeClass {
    return this.ownerOfTab(tabId)?.permissionClass(tabId) ?? 'prompting'
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
    this.tabEndsByHand?.onPtyExit(exit.tabId, exit.crashed)
    this.tabEndsByHand?.setAlive(exit.tabId, false)
    void this.storedByHand()
      .find((s) => s.hasTab(exit.tabId))
      ?.stop(exit.tabId, exit.signal ? -1 : exit.exitCode)
      .catch(endFailed)
    this.tabEndsByHand?.launchEnded(exit.tabId)
  }

  quitWaits(quit: () => void, endFailed: (backend: BackendId, error: unknown) => void): boolean {
    if (this.quitEnded || !this.storedByHand().some((s) => s.hasProcesses())) return false
    if (!this.quitEnding) {
      this.quitEnding = true
      void Promise.all(
        this.storedByHand().map((s) => s.stopAll().catch((error) => endFailed(s.id, error)))
      ).finally(() => {
        this.quitEnded = true
        quit()
      })
    }
    return true
  }

  flushSync(): void {
    for (const stored of this.storedByHand()) stored.store.flushSync()
  }

  async beforeWorkspaceRemoved(workspace: string): Promise<void> {
    await Promise.all(
      this.storedByHand().flatMap((stored) => {
        const tabs = new Set(
          stored
            .rows(workspace)
            .filter((r) => r.running || r.pending)
            .map((r) => (r.pending ? r.id : stored.aliveTabFor(r.id)))
            .filter((id): id is string => !!id)
        )
        return [...tabs].map((id) => stored.stop(id))
      })
    )
  }

  showsPromptBeforeBind(tabId: string): boolean {
    return !!this.storedByHand()
      .find((s) => s.hasTab(tabId))
      ?.showsPromptBeforeBind?.(tabId)
  }

  sessionStillThere(key: string, foundOrRunning: ReadonlySet<string>): boolean {
    return (
      foundOrRunning.has(key) ||
      (identityOf(key).backendId !== this.tabEndsByHand?.id &&
        !this.storedByHand().some((s) => s.id === identityOf(key).backendId && s.threadGone(key)))
    )
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
    return rows.filter((r) => !this.isOverseerSession(r.id)).sort((a, b) => b.mtime - a.mtime)
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
