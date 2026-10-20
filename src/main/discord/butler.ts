import fs from 'fs'
import path from 'path'
import type {
  AssistTaskRow,
  BackendId,
  ButlerSession,
  ButlerSetting,
  ConductorOpenResult,
  ConductorSaveResult,
  DiscordChannel,
  DiscordSettings
} from '@shared/types'
import { CannotMakeChannels, type NewChannel } from './link'
import { BACKEND_LABEL, identityOf } from '@shared/sessionBackend'
import { assistTaskName, butlerNames, newerSnowflake, peerNamesOf } from '@shared/conductors'
import { assistTaskRole, butlerRole } from '@shared/agentGuide'
import { errorText } from '../agentRequests'
import { realpathSafe } from '../projectInfo'

export interface ButlerLaunch {
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

export interface ButlerDeps {
  userData: string
  butler(): ButlerSetting
  load(): DiscordSettings
  loadSession(): ButlerSession
  save(discord: DiscordSettings): void
  saveQuietly(discord: DiscordSettings): void
  saveSession(session: ButlerSession): void
  backend(): Promise<AssistBackendChoice>
  tabAlive(tabId: string): boolean
  liveTabFor(backend: BackendId, key: string): string | undefined
  runningElsewhere(backend: BackendId, key: string): Promise<boolean>
  transcriptExists(backend: BackendId, key: string): Promise<boolean>
  start(launch: ButlerLaunch): Promise<string | null>
  resume(launch: ButlerLaunch & { key: string }): Promise<string | null>
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

interface RunningTask extends AssistTask {
  role: string
  tabId: string
  key?: string
}

function refusal(error: string): ConductorOpenResult {
  return { ok: false, error }
}

export class Butler {
  private discord: DiscordSettings
  private session: ButlerSession
  private resident: string | undefined
  private tasks: RunningTask[] = []
  private pendingSave: ReturnType<typeof setTimeout> | null = null
  private stopping = new Set<string>()
  private opening = new Map<string, Promise<ConductorOpenResult>>()
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private d: ButlerDeps) {
    this.discord = d.load()
    this.session = d.loadSession()
  }

  channel(): DiscordChannel | undefined {
    return this.discord.channel
  }

  lastMessageId(): string | undefined {
    return this.discord.lastMessageId
  }

  private write(patch: Partial<DiscordSettings>): void {
    this.discord = { ...this.discord, ...patch }
    this.d.save(this.discord)
    this.d.rowsChanged()
  }

  private changeSession(change: (s: ButlerSession) => ButlerSession): void {
    this.session = change(this.session)
    this.d.saveSession(this.session)
    this.d.rowsChanged()
  }

  flush(): void {
    if (!this.pendingSave) return
    clearTimeout(this.pendingSave)
    this.pendingSave = null
    this.d.saveQuietly(this.discord)
  }

  private taskOfTab(tabId: string): RunningTask | undefined {
    return this.tasks.find((t) => t.tabId === tabId)
  }

  channelOfTab(tabId: string): string | undefined {
    return tabId === this.resident ? this.discord.channel?.channelId : undefined
  }

  isButlerChannel(channelId: string): boolean {
    return this.discord.channel?.channelId === channelId
  }

  isButler(ref: string): boolean {
    return (
      butlerNames(this.d.butler()).some((name) => peerNamesOf(name).includes(ref)) ||
      this.recorded(ref)
    )
  }

  private recorded(ref: string): boolean {
    return this.session.sessionIds.some(
      (key) => key === ref || identityOf(key).nativeSessionId === ref
    )
  }

  liveTab(): string | undefined {
    const tab = this.resident
    return tab && this.d.tabAlive(tab) ? tab : undefined
  }

  setLastMessage(messageId: string): void {
    const last = this.discord.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.discord = { ...this.discord, lastMessageId: messageId }
    this.pendingSave ??= setTimeout(() => this.flush(), LAST_MESSAGE_SAVE_DELAY_MS)
  }

  isButlerSession(tabOrSessionId: string): boolean {
    if (!tabOrSessionId) return false
    return (
      tabOrSessionId === this.resident ||
      !!this.taskOfTab(tabOrSessionId) ||
      this.stopping.has(tabOrSessionId) ||
      this.session.sessionIds.includes(tabOrSessionId)
    )
  }

  taskNameOf(tabId: string): string | undefined {
    return this.taskOfTab(tabId)?.name
  }

  heldResident(tabId: string): boolean {
    return tabId === this.resident && !!this.discord.channel
  }

  isButlerTab(tabId: string): boolean {
    return tabId === this.resident || !!this.taskOfTab(tabId)
  }

  // ADR-0029
  identityOfLaunch(cwd: string, resumeKey?: string): { role: string } | undefined {
    const launched = realpathSafe(path.resolve(cwd))
    if (realpathSafe(conductorFolder(this.d.userData)) !== launched || !resumeKey) return undefined
    const task = this.tasks.find((t) => t.key === resumeKey)
    if (task) return { role: task.role }
    if (!this.recorded(resumeKey)) return undefined
    return { role: this.role() }
  }

  private role(): string {
    return butlerRole(this.d.butler().name, !!this.discord.channel)
  }

  forgetGone(stillOnDisk: (key: string) => boolean): void {
    const s = this.session
    const sessionIds = s.sessionIds.filter(stillOnDisk)
    const keepLast = !s.lastSessionKey || stillOnDisk(s.lastSessionKey)
    if (sessionIds.length === s.sessionIds.length && keepLast) return
    this.changeSession(() => ({
      sessionIds,
      ...(keepLast && s.lastSessionKey ? { lastSessionKey: s.lastSessionKey } : {})
    }))
  }

  async bindNewChannel(
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
    return this.bind(made.channel)
  }

  bind(channel: DiscordChannel): ConductorSaveResult {
    const same = this.discord.channel?.channelId === channel.channelId
    this.write({ channel, lastMessageId: same ? this.discord.lastMessageId : undefined })
    return { ok: true }
  }

  unbind(): void {
    this.write({ channel: undefined, lastMessageId: undefined })
  }

  startFresh(): Promise<ConductorOpenResult> {
    this.stopResident()
    this.changeSession((s) => ({ sessionIds: s.sessionIds }))
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

  private launchFor(backend: BackendId): ButlerLaunch {
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
    const launch = this.launchFor(choice.backend)
    const key = this.session.lastSessionKey
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
    const { name } = this.d.butler()
    const role = assistTaskRole(name, task.brief)
    const title = assistTaskName(name, task.name)
    const launch: ButlerLaunch = {
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

  private remember(key: string, last: boolean): void {
    this.changeSession((s) => ({
      ...s,
      sessionIds: s.sessionIds.includes(key) ? s.sessionIds : [...s.sessionIds, key],
      ...(last ? { lastSessionKey: key } : {})
    }))
  }

  onBound(tabId: string, key: string): void {
    const task = this.taskOfTab(tabId) ?? this.tasks.find((t) => t.key === key)
    if (task) {
      this.forgetTab(tabId)
      const moved = task.tabId !== tabId
      task.tabId = tabId
      task.key = key
      this.remember(key, false)
      if (moved) this.d.tasksChanged()
      return
    }
    if (tabId !== this.resident) {
      if (this.session.lastSessionKey !== key || this.liveTab()) return
      this.resident = tabId
    }
    this.forgetTab(tabId)
    this.remember(key, true)
  }

  onPtyExit(tabId: string, asleep: boolean): void {
    this.stopping.delete(tabId)
    if (tabId === this.resident) this.resident = undefined
    this.forgetTab(tabId)
    const task = asleep ? undefined : this.taskOfTab(tabId)
    if (!task) return
    this.tasks = this.tasks.filter((t) => t !== task)
    this.d.tasksChanged()
  }
}
