import fs from 'fs'
import path from 'path'
import type {
  BackendId,
  ButlerSession,
  ButlerSetting,
  ConductorOpenResult,
  ConductorSaveResult,
  DiscordChannel,
  DiscordSettings
} from '@shared/types'
import { CannotMakeChannels, type NewChannel } from './link'
import { BACKEND_LABEL, conversationAtFirstPrompt, identityOf } from '@shared/sessionBackend'
import { butlerNames, newerSnowflake, peerNamesOf } from '@shared/conductors'
import { butlerRole, TODO_NOTICE } from '@shared/agentGuide'
import { errorText } from '../agentRequests'
import { FROM_KOLOFT } from '../crossSessionMessage'
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
  toast(text: string): void
  notice(text: string): Promise<boolean>
  bindDeadlineMs: number
}

const LAST_MESSAGE_SAVE_DELAY_MS = 1000

// ADR-0029 CC§3 CODEX§2
export function conductorFolder(userData: string): string {
  return path.join(userData, 'conductors', 'global')
}

function refusal(error: string): ConductorOpenResult {
  return { ok: false, error }
}

export class Butler {
  private discord: DiscordSettings
  private session: ButlerSession
  private resident: string | undefined
  private pendingSave: ReturnType<typeof setTimeout> | null = null
  private stopping = new Set<string>()
  private opening: Promise<ConductorOpenResult> | undefined
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private waitingForWords: string | undefined

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

  oldThreadsArchived(): boolean {
    return !!this.discord.oldThreadsArchived
  }

  markOldThreadsArchived(): void {
    this.discord = { ...this.discord, oldThreadsArchived: true }
    this.d.saveQuietly(this.discord)
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
      this.stopping.has(tabOrSessionId) ||
      this.session.sessionIds.includes(tabOrSessionId)
    )
  }

  isButlerTab(tabId: string): boolean {
    return tabId === this.resident
  }

  // ADR-0029
  identityOfLaunch(cwd: string, resumeKey?: string): { role: string } | undefined {
    const launched = realpathSafe(path.resolve(cwd))
    if (realpathSafe(conductorFolder(this.d.userData)) !== launched || !resumeKey) return undefined
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
      ...(keepLast && s.lastSessionKey ? { lastSessionKey: s.lastSessionKey } : {}),
      ...(s.knowsTodo ? { knowsTodo: s.knowsTodo.filter(stillOnDisk) } : {})
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
    this.changeSession(({ lastSessionKey, ...kept }) => {
      void lastSessionKey
      return kept
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

  open(firstPrompt?: string): Promise<ConductorOpenResult> {
    this.opening ??= this.openNow(firstPrompt).finally(() => (this.opening = undefined))
    return this.opening
  }

  private launchFor(backend: BackendId): ButlerLaunch {
    const cwd = conductorFolder(this.d.userData)
    fs.mkdirSync(cwd, { recursive: true })
    return { backend, cwd, role: this.role(), title: this.d.butler().name }
  }

  private async openNow(firstPrompt?: string): Promise<ConductorOpenResult> {
    const tab = this.liveTab()
    if (tab) return { ok: true, tabId: tab }
    const choice = await this.d.backend()
    return 'error' in choice ? refusal(choice.error) : this.openOn(choice, firstPrompt)
  }

  private async openOn(
    choice: AssistBackendPick,
    firstPrompt?: string
  ): Promise<ConductorOpenResult> {
    const launch = this.launchFor(choice.backend)
    const key = this.session.lastSessionKey
    const resumable = key !== undefined && identityOf(key).backendId === launch.backend
    if (key !== undefined && !resumable)
      this.d.toast(
        `${launch.title} now runs on ${BACKEND_LABEL[launch.backend]}, so it starts a new conversation.`
      )
    else if (choice.because) this.d.toast(choice.because)
    let tabId: string | null
    let resumedOld = false
    let started = false
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
      resumedOld = hasTranscript && !this.session.knowsTodo?.includes(key)
      // AGY§8
      if (hasTranscript) tabId = await this.d.resume({ ...launch, key })
      else {
        started = true
        tabId = await this.d.start({ ...launch, firstPrompt })
      }
    } catch (error) {
      return refusal(errorText(error))
    }
    if (!tabId) return refusal(`${launch.title} could not start.`)
    if (resumedOld && key !== undefined) this.tellOfTodo(key)
    this.resident = tabId
    // AGY§8
    if (started && !firstPrompt && conversationAtFirstPrompt(launch.backend))
      this.waitingForWords = tabId
    else this.armDeadline(tabId, launch.title)
    return { ok: true, tabId }
  }

  awaitsFirstWords(tabId: string): boolean {
    return tabId === this.waitingForWords
  }

  firstWordsComing(tabId: string): void {
    if (tabId !== this.waitingForWords) return
    this.waitingForWords = undefined
    this.armDeadline(tabId, this.d.butler().name)
  }

  // CC§23 CODEX§17 MUSE§9 AGY§8
  private tellOfTodo(key: string): void {
    void this.d.notice(`${FROM_KOLOFT}${TODO_NOTICE}`).then((told) => {
      if (told && !this.session.knowsTodo?.includes(key))
        this.changeSession((s) => ({ ...s, knowsTodo: [...(s.knowsTodo ?? []), key] }))
    })
  }

  private armDeadline(tabId: string, title: string): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(tabId)
      if (this.resident !== tabId) return
      this.stopResident()
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
    if (tabId === this.waitingForWords) this.waitingForWords = undefined
    clearTimeout(this.deadlines.get(tabId))
    this.deadlines.delete(tabId)
  }

  onBound(tabId: string, key: string): void {
    if (tabId !== this.resident) {
      if (this.session.lastSessionKey !== key || this.liveTab()) return
      this.resident = tabId
    }
    this.forgetTab(tabId)
    this.changeSession((s) =>
      s.sessionIds.includes(key)
        ? { ...s, lastSessionKey: key }
        : {
            ...s,
            sessionIds: [...s.sessionIds, key],
            lastSessionKey: key,
            knowsTodo: [...(s.knowsTodo ?? []), key]
          }
    )
  }

  onPtyExit(tabId: string): void {
    this.stopping.delete(tabId)
    if (tabId === this.resident) this.resident = undefined
    this.forgetTab(tabId)
  }
}
