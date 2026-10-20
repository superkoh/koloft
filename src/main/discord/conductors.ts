import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  AssistRecord,
  AssistTaskRow,
  BackendId,
  ButlerSetting,
  ConductorBinding,
  ConductorOpenResult,
  ConductorSaveResult,
  DiscordChannel,
  DiscordSettings,
  SessionThread
} from '@shared/types'
import { CannotMakeChannels, type NewChannel } from './link'
import { BACKEND_LABEL, identityOf } from '@shared/sessionBackend'
import {
  assistTaskName,
  butlerNames,
  GLOBAL_SCOPE,
  newerSnowflake,
  peerNamesOf
} from '@shared/conductors'
import { assistTaskRole, butlerRole } from '@shared/agentGuide'
import { errorText } from '../agentRequests'
import { realpathSafe } from '../projectInfo'

export interface ConductorLaunch {
  backend: BackendId
  cwd: string
  role: string
  title: string
  firstPrompt?: string
}

export type AssistBackendPick = { backend: BackendId; because?: string }
export type AssistBackendChoice = AssistBackendPick | { error: string }

export interface AssistTask {
  name: string
  brief: string
  ownerWords: string
}

export interface AssistIdentity {
  scope: string
  role: string
  task?: string
}

export interface ConductorDeps {
  userData: string
  butler(): ButlerSetting
  load(): DiscordSettings
  loadRecords(): AssistRecord[]
  save(discord: DiscordSettings): void
  saveQuietly(discord: DiscordSettings): void
  saveRecords(records: AssistRecord[]): void
  backend(): Promise<AssistBackendChoice>
  tabAlive(tabId: string): boolean
  liveTabFor(backend: BackendId, key: string): string | undefined
  runningElsewhere(backend: BackendId, key: string): Promise<boolean>
  transcriptExists(backend: BackendId, key: string): Promise<boolean>
  start(launch: ConductorLaunch): Promise<string | null>
  resume(launch: ConductorLaunch & { key: string }): Promise<string | null>
  kill(tabId: string): void
  rowsChanged(): void
  tasksChanged(): void
  toast(text: string): void
  bindDeadlineMs: number
}

const LAST_MESSAGE_SAVE_DELAY_MS = 1000

// ADR-0029 CC§3 CODEX§2
export function conductorFolder(userData: string): string {
  return path.join(userData, 'conductors', 'global')
}

interface BoundThread {
  binding: ConductorBinding
  thread: SessionThread
}

interface RunningTask extends AssistTask {
  role: string
  tabId: string
  key?: string
}

function keptKeys(
  threads: SessionThread[] | undefined,
  keep: (key: string) => boolean,
  stays?: string
): SessionThread[] {
  return (threads ?? [])
    .map((t) => ({ ...t, keys: t.keys.filter(keep) }))
    .filter((t) => t.keys.length || t.threadId === stays)
}

function refusal(error: string): ConductorOpenResult {
  return { ok: false, error }
}

export class Conductors {
  private discord: DiscordSettings
  private records: AssistRecord[]
  private resident: string | undefined
  private tasks: RunningTask[] = []
  private pendingSave: ReturnType<typeof setTimeout> | null = null
  private stopping = new Set<string>()
  private opening = new Map<string, Promise<ConductorOpenResult>>()
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTouch = new Map<string, string>()

  constructor(private d: ConductorDeps) {
    this.discord = d.load()
    this.records = d.loadRecords()
  }

  bindings(): ConductorBinding[] {
    return this.discord.bindings
  }

  private write(patch: Partial<DiscordSettings>): void {
    this.discord = { ...this.discord, ...patch }
    this.d.save(this.discord)
    this.d.rowsChanged()
  }

  private change(id: string, change: (b: ConductorBinding) => ConductorBinding): void {
    this.discord = {
      ...this.discord,
      bindings: this.discord.bindings.map((b) => (b.id === id ? change(b) : b))
    }
  }

  private writeRecords(records: AssistRecord[]): void {
    this.records = records
    this.d.saveRecords(records)
    this.d.rowsChanged()
  }

  private changeRecord(change: (r: AssistRecord) => AssistRecord): void {
    const current = this.record() ?? { scope: GLOBAL_SCOPE, sessionIds: [] }
    this.writeRecords([change(current)])
  }

  flush(): void {
    if (!this.pendingSave) return
    clearTimeout(this.pendingSave)
    this.pendingSave = null
    this.d.saveQuietly(this.discord)
  }

  binding(id: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.id === id)
  }

  butlerBinding(): ConductorBinding | undefined {
    return this.discord.bindings[0]
  }

  record(): AssistRecord | undefined {
    return this.records[0]
  }

  private taskOfTab(tabId: string): RunningTask | undefined {
    return this.tasks.find((t) => t.tabId === tabId)
  }

  bindingOfTab(tabId: string): ConductorBinding | undefined {
    return tabId === this.resident ? this.butlerBinding() : undefined
  }

  bindingOfChannel(channelId: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.channel.channelId === channelId)
  }

  isButler(ref: string): boolean {
    return (
      butlerNames(this.d.butler()).some((name) => peerNamesOf(name).includes(ref)) ||
      this.recorded(ref)
    )
  }

  private recorded(ref: string): boolean {
    return !!this.record()?.sessionIds.some(
      (key) => key === ref || identityOf(key).nativeSessionId === ref
    )
  }

  touchWhenBound(butlerTab: string, tabId: string): void {
    const b = this.bindingOfTab(butlerTab)
    if (b) this.pendingTouch.set(tabId, b.id)
  }

  touchNowAndNext(id: string, key: string, tabId: string | undefined): void {
    this.touchFor(id, key)
    if (tabId) this.pendingTouch.set(tabId, id)
  }

  liveTab(): string | undefined {
    const tab = this.resident
    return tab && this.d.tabAlive(tab) ? tab : undefined
  }

  setLastMessage(id: string, messageId: string): void {
    const last = this.binding(id)?.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.change(id, (b) => ({ ...b, lastMessageId: messageId }))
    this.pendingSave ??= setTimeout(() => this.flush(), LAST_MESSAGE_SAVE_DELAY_MS)
  }

  conductorOf(tabOrSessionId: string): string | undefined {
    const ours =
      tabOrSessionId === this.resident ||
      !!this.taskOfTab(tabOrSessionId) ||
      this.stopping.has(tabOrSessionId) ||
      !!this.record()?.sessionIds.includes(tabOrSessionId)
    return ours ? GLOBAL_SCOPE : undefined
  }

  taskNameOf(tabId: string): string | undefined {
    return this.taskOfTab(tabId)?.name
  }

  heldResident(tabId: string): boolean {
    return tabId === this.resident && !!this.butlerBinding()
  }

  covers(): boolean {
    return !!this.butlerBinding()
  }

  isButlerTab(tabId: string): boolean {
    return tabId === this.resident || !!this.taskOfTab(tabId)
  }

  // ADR-0029
  identityOfLaunch(cwd: string, resumeKey?: string): AssistIdentity | undefined {
    const launched = realpathSafe(path.resolve(cwd))
    if (realpathSafe(conductorFolder(this.d.userData)) !== launched || !resumeKey) return undefined
    const task = this.tasks.find((t) => t.key === resumeKey)
    if (task) return { scope: GLOBAL_SCOPE, role: task.role, task: task.name }
    if (!this.recorded(resumeKey)) return undefined
    return { scope: GLOBAL_SCOPE, role: this.role() }
  }

  private role(): string {
    return butlerRole(this.d.butler().name, !!this.butlerBinding())
  }

  touch(tabId: string, key: string): void {
    const b = this.bindingOfTab(tabId)
    if (b) this.touchFor(b.id, key)
  }

  private touchFor(id: string, key: string): void {
    if (this.binding(id)?.touched.includes(key)) return
    this.change(id, (x) => ({ ...x, touched: [...x.touched, key] }))
    this.d.saveQuietly(this.discord)
  }

  private findThread(match: (t: SessionThread) => boolean): BoundThread | undefined {
    for (const binding of this.discord.bindings) {
      const thread = binding.threads?.find(match)
      if (thread) return { binding, thread }
    }
    return undefined
  }

  threadOfKey(key: string): BoundThread | undefined {
    return this.findThread((t) => t.keys.includes(key))
  }

  threadOfChannel(channelId: string): BoundThread | undefined {
    return this.findThread((t) => t.threadId === channelId)
  }

  routeOf(channelId: string): { binding: ConductorBinding; sessionKey?: string } | undefined {
    const binding = this.bindingOfChannel(channelId)
    if (binding) return { binding }
    const found = this.threadOfChannel(channelId)
    const sessionKey = found?.thread.keys.at(-1)
    return found && sessionKey ? { binding: found.binding, sessionKey } : undefined
  }

  keepThread(bindingId: string, threadId: string, key: string): void {
    if (this.threadOfKey(key)?.thread.threadId === threadId) return
    this.discord = {
      ...this.discord,
      bindings: this.discord.bindings.map((b) => {
        const others = keptKeys(b.threads, (k) => k !== key, threadId)
        if (b.id !== bindingId) return { ...b, threads: others }
        const known = others.some((t) => t.threadId === threadId)
        return {
          ...b,
          threads: known
            ? others.map((t) => (t.threadId === threadId ? { ...t, keys: [...t.keys, key] } : t))
            : [...others, { threadId, keys: [key] }]
        }
      })
    }
    this.d.saveQuietly(this.discord)
  }

  private changeThread(bindingId: string, threadId: string, patch: Partial<SessionThread>): void {
    this.change(bindingId, (b) => ({
      ...b,
      threads: (b.threads ?? []).map((t) => (t.threadId === threadId ? { ...t, ...patch } : t))
    }))
  }

  setThreadLastMessage(threadId: string, messageId: string): void {
    const found = this.threadOfChannel(threadId)
    if (!found) return
    const last = found.thread.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.changeThread(found.binding.id, threadId, { lastMessageId: messageId })
    this.pendingSave ??= setTimeout(() => this.flush(), LAST_MESSAGE_SAVE_DELAY_MS)
  }

  nameThread(threadId: string, name: string): void {
    const found = this.threadOfChannel(threadId)
    if (!found || found.thread.name === name) return
    this.changeThread(found.binding.id, threadId, { name })
    this.d.saveQuietly(this.discord)
  }

  dropThread(threadId: string): void {
    const found = this.threadOfChannel(threadId)
    if (!found) return
    this.change(found.binding.id, (b) => ({
      ...b,
      threads: (b.threads ?? []).filter((t) => t.threadId !== threadId)
    }))
    this.d.saveQuietly(this.discord)
  }

  forgetGone(stillOnDisk: (key: string) => boolean): void {
    let changed = false
    const bindings = this.discord.bindings.map((b) => {
      const touched = b.touched.filter(stillOnDisk)
      const threads = keptKeys(b.threads, stillOnDisk)
      const threadKeys = (list?: SessionThread[]): number =>
        (list ?? []).reduce((n, t) => n + t.keys.length, 0)
      if (touched.length === b.touched.length && threadKeys(threads) === threadKeys(b.threads))
        return b
      changed = true
      return { ...b, touched, threads }
    })
    if (changed) {
      this.discord = { ...this.discord, bindings }
      this.d.saveQuietly(this.discord)
    }
    const r = this.record()
    if (!r) return
    const sessionIds = r.sessionIds.filter(stillOnDisk)
    const keepLast = !r.lastSessionKey || stillOnDisk(r.lastSessionKey)
    if (sessionIds.length === r.sessionIds.length && keepLast) return
    const { lastSessionKey, ...rest } = r
    this.writeRecords([
      { ...rest, sessionIds, ...(keepLast && lastSessionKey ? { lastSessionKey } : {}) }
    ])
  }

  async bindNewChannel(
    backend: BackendId,
    make: (category: DiscordChannel | undefined) => Promise<NewChannel>
  ): Promise<ConductorSaveResult> {
    let made: NewChannel
    try {
      made = await make(this.discord.category)
    } catch (error) {
      return {
        ok: false,
        error: errorText(error),
        ...(error instanceof CannotMakeChannels ? { cannotMakeChannels: true } : {})
      }
    }
    this.discord = { ...this.discord, category: made.category }
    return this.bind(made.channel, backend)
  }

  bind(channel: DiscordChannel, backend: BackendId): ConductorSaveResult {
    const current = this.butlerBinding()
    this.write({
      bindings: [
        current
          ? { ...current, backend, channel }
          : { id: randomUUID(), scope: GLOBAL_SCOPE, backend, channel, touched: [] }
      ]
    })
    return { ok: true }
  }

  followBackend(backend: BackendId): void {
    if (this.discord.bindings.every((b) => b.backend === backend)) return
    this.write({ bindings: this.discord.bindings.map((b) => ({ ...b, backend })) })
  }

  unbind(): void {
    this.write({ bindings: [] })
  }

  startFresh(): Promise<ConductorOpenResult> {
    this.stopResident()
    this.changeRecord((r) => {
      const { lastSessionKey, ...rest } = r
      void lastSessionKey
      return rest
    })
    return this.open()
  }

  discordSettings(): DiscordSettings {
    return this.discord
  }

  owner(): string | undefined {
    return this.discord.userId
  }

  setOwner(owner: { id: string; name: string }): void {
    if (owner.id === this.discord.userId && owner.name === this.discord.userName) return
    this.discord = { ...this.discord, userId: owner.id, userName: owner.name }
    this.d.save(this.discord)
  }

  open(): Promise<ConductorOpenResult> {
    return this.once('', () => this.openNow())
  }

  private once(
    key: string,
    start: () => Promise<ConductorOpenResult>
  ): Promise<ConductorOpenResult> {
    const inflight = this.opening.get(key)
    if (inflight) return inflight
    const opening = start().finally(() => this.opening.delete(key))
    this.opening.set(key, opening)
    return opening
  }

  private launchFor(backend: BackendId): ConductorLaunch {
    const cwd = conductorFolder(this.d.userData)
    fs.mkdirSync(cwd, { recursive: true })
    return { backend, cwd, role: this.role(), title: this.d.butler().name }
  }

  private async openNow(): Promise<ConductorOpenResult> {
    const tab = this.liveTab()
    if (tab) return { ok: true, tabId: tab }
    const choice = await this.d.backend()
    return 'error' in choice ? refusal(choice.error) : this.openOn(choice)
  }

  private async openOn(choice: AssistBackendPick): Promise<ConductorOpenResult> {
    if (!this.record()) this.changeRecord((r) => r)
    const launch = this.launchFor(choice.backend)
    const key = this.record()?.lastSessionKey
    const resumable = key !== undefined && identityOf(key).backendId === launch.backend
    if (key !== undefined && !resumable)
      this.d.toast(
        `${launch.title} now runs on ${BACKEND_LABEL[launch.backend]}, so it starts a new conversation.`
      )
    else if (choice.because) this.d.toast(choice.because)
    let tabId: string | null
    try {
      if (resumable) {
        const live = this.d.liveTabFor(launch.backend, key)
        if (live) {
          this.resident = live
          return { ok: true, tabId: live }
        }
        if (await this.d.runningElsewhere(launch.backend, key))
          return refusal(`${launch.title} is already running in another ${launch.backend} process.`)
      }
      const hasTranscript =
        resumable && (await this.d.transcriptExists(launch.backend, key).catch(() => false))
      tabId = hasTranscript ? await this.d.resume({ ...launch, key }) : await this.d.start(launch)
    } catch (error) {
      return refusal(errorText(error))
    }
    if (!tabId) return refusal(`${launch.title} could not start.`)
    this.resident = tabId
    this.armDeadline(tabId, launch.title, () => this.resident === tabId)
    return { ok: true, tabId }
  }

  openTask(task: AssistTask): Promise<ConductorOpenResult> {
    return this.once(`task\n${task.name}`, () => this.openTaskNow(task))
  }

  private async openTaskNow(task: AssistTask): Promise<ConductorOpenResult> {
    const running = this.tasks.find((t) => t.name === task.name)
    if (running) return { ok: true, tabId: running.tabId }
    const choice = await this.d.backend()
    return 'error' in choice ? refusal(choice.error) : this.openTaskOn(task, choice)
  }

  private async openTaskOn(
    task: AssistTask,
    choice: AssistBackendPick
  ): Promise<ConductorOpenResult> {
    if (choice.because) this.d.toast(choice.because)
    if (!this.record()) this.changeRecord((r) => r)
    const { name } = this.d.butler()
    const role = assistTaskRole(name, task.brief)
    const title = assistTaskName(name, task.name)
    const launch: ConductorLaunch = {
      ...this.launchFor(choice.backend),
      role,
      title,
      // ADR-0031
      firstPrompt: task.ownerWords
    }
    const placeholder: RunningTask = { ...task, role, tabId: '' }
    this.tasks.push(placeholder)
    let tabId: string | null
    try {
      tabId = await this.d.start(launch)
    } catch (error) {
      this.tasks = this.tasks.filter((t) => t !== placeholder)
      return refusal(errorText(error))
    }
    if (!tabId) {
      this.tasks = this.tasks.filter((t) => t !== placeholder)
      return refusal(`The ${title} could not start.`)
    }
    placeholder.tabId = tabId
    this.d.tasksChanged()
    this.armDeadline(tabId, title, () => placeholder.tabId === tabId && !placeholder.key)
    return { ok: true, tabId }
  }

  runningTaskTab(name: string): string | undefined {
    return this.tasks.find((t) => t.name === name && t.tabId)?.tabId
  }

  taskRows(): AssistTaskRow[] {
    return this.tasks.filter((t) => t.tabId).map((t) => ({ tabId: t.tabId, name: t.name }))
  }

  closeTask(tabId: string): void {
    const task = this.taskOfTab(tabId)
    if (!task) return
    this.tasks = this.tasks.filter((t) => t !== task)
    this.forgetTab(tabId)
    this.stopping.add(tabId)
    this.d.kill(tabId)
    this.d.tasksChanged()
  }

  private armDeadline(tabId: string, title: string, stillWaiting: () => boolean): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(tabId)
      if (!stillWaiting()) return
      if (tabId === this.resident) this.stopResident()
      else this.closeTask(tabId)
      this.d.toast(`${title} did not start.`)
    }, this.d.bindDeadlineMs)
    this.deadlines.set(tabId, timer)
  }

  private stopResident(): void {
    const tab = this.resident
    if (!tab) return
    this.resident = undefined
    this.forgetTab(tab)
    this.stopping.add(tab)
    this.d.kill(tab)
  }

  private forgetTab(tabId: string): void {
    clearTimeout(this.deadlines.get(tabId))
    this.deadlines.delete(tabId)
  }

  onBound(tabId: string, key: string): void {
    const toucher = this.pendingTouch.get(tabId)
    if (toucher) {
      this.pendingTouch.delete(tabId)
      this.touchFor(toucher, key)
      return
    }
    const task = this.taskOfTab(tabId) ?? this.tasks.find((t) => t.key === key)
    if (task) {
      this.forgetTab(tabId)
      const moved = task.tabId !== tabId
      task.tabId = tabId
      task.key = key
      this.changeRecord((r) =>
        r.sessionIds.includes(key) ? r : { ...r, sessionIds: [...r.sessionIds, key] }
      )
      if (moved) this.d.tasksChanged()
      return
    }
    if (tabId !== this.resident) {
      if (this.record()?.lastSessionKey !== key || this.liveTab()) return
      this.resident = tabId
    }
    this.forgetTab(tabId)
    this.changeRecord((r) => ({
      ...r,
      sessionIds: r.sessionIds.includes(key) ? r.sessionIds : [...r.sessionIds, key],
      lastSessionKey: key
    }))
  }

  onPtyExit(tabId: string, asleep: boolean): void {
    this.stopping.delete(tabId)
    this.pendingTouch.delete(tabId)
    if (tabId === this.resident) this.resident = undefined
    this.forgetTab(tabId)
    const task = asleep ? undefined : this.taskOfTab(tabId)
    if (!task) return
    this.tasks = this.tasks.filter((t) => t !== task)
    this.d.tasksChanged()
  }
}
