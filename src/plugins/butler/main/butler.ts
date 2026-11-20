import fs from 'fs'
import path from 'path'
import type { BackendId, ConductorOpenResult, CronEffort } from '@shared/types'
import { BACKEND_LABEL, conversationAtFirstPrompt, identityOf } from '@shared/sessionBackend'
import { butlerNames, peerNamesOf } from '../shared/names'
import {
  isKnownBy,
  type ButlerSession,
  type ButlerSetting,
  type OldConversationNews,
  type PluginsOn
} from '../shared/types'
import { instructionsOf } from '../shared/instructions'
import { errorText } from '@core/errorText'
import { FROM_KOLOFT } from '@plugins/sessions/api'
import { butlerRole, ownerInstructionsPart } from '../prompts/role'
import { conductorFolder } from './folder'

interface ButlerPrompt {
  role: string
  ownerText?: string
}

export interface ButlerLaunch extends ButlerPrompt {
  backend: BackendId
  cwd: string
  title: string
  firstPrompt?: string
  model?: string
  effort?: CronEffort
}

export type AssistBackendPick = {
  backend: BackendId
  because?: string
  model?: string
  effort?: CronEffort
}
export type AssistBackendChoice = AssistBackendPick | { error: string }

export interface ButlerDeps {
  userData: string
  realpath(folder: string): string
  butler(): ButlerSetting
  roleFacts(): readonly string[]
  loadSession(): ButlerSession
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
  news: OldConversationNews
  noticeWhileOpen(text: string): Promise<boolean>
  pluginsOn(): PluginsOn
  pluginsNews(changed: PluginsOn): string
  showsPromptBeforeBind(tabId: string): boolean
  bindDeadlineMs: number
}

function knownListsOnDisk(
  s: ButlerSession,
  stillOnDisk: (key: string) => boolean
): Partial<ButlerSession> {
  return Object.fromEntries(
    Object.entries(s).flatMap(([knownBy, keys]) =>
      isKnownBy(knownBy) && Array.isArray(keys) ? [[knownBy, keys.filter(stillOnDisk)]] : []
    )
  )
}

function refusal(error: string): ConductorOpenResult {
  return { ok: false, error }
}

export class Butler {
  private session: ButlerSession
  private resident: string | undefined
  private stopping = new Set<string>()
  private opening: Promise<ConductorOpenResult> | undefined
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private waitingForWords: string | undefined
  private launchedWith: PluginsOn | undefined

  constructor(private d: ButlerDeps) {
    this.session = d.loadSession()
  }

  private changeSession(change: (s: ButlerSession) => ButlerSession): void {
    this.session = change(this.session)
    this.d.saveSession(this.session)
    this.d.rowsChanged()
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

  // ADR-0029 CC§23
  identityOfLaunch(cwd: string, resumeKey?: string): ButlerPrompt | undefined {
    const launched = this.d.realpath(path.resolve(cwd))
    if (this.d.realpath(conductorFolder(this.d.userData)) !== launched || !resumeKey)
      return undefined
    if (!this.recorded(resumeKey)) return undefined
    return this.prompt()
  }

  private prompt(): ButlerPrompt {
    const butler = this.d.butler()
    const instructions = instructionsOf(butler)
    // CC§13 CC§23
    return {
      role: butlerRole(butler.name, this.d.roleFacts()),
      ...(instructions && { ownerText: ownerInstructionsPart(instructions) })
    }
  }

  forgetGone(stillOnDisk: (key: string) => boolean): void {
    const s = this.session
    const sessionIds = s.sessionIds.filter(stillOnDisk)
    const keepLast = !s.lastSessionKey || stillOnDisk(s.lastSessionKey)
    if (sessionIds.length === s.sessionIds.length && keepLast) return
    this.changeSession(() => ({
      sessionIds,
      ...(keepLast && s.lastSessionKey ? { lastSessionKey: s.lastSessionKey } : {}),
      ...(s.pluginsSeen && stillOnDisk(s.pluginsSeen.key) ? { pluginsSeen: s.pluginsSeen } : {}),
      ...knownListsOnDisk(s, stillOnDisk),
      ...(keepLast && s.carried ? { carried: s.carried } : {})
    }))
  }

  startFresh(): Promise<ConductorOpenResult> {
    this.stopResident()
    this.changeSession(({ lastSessionKey, ...kept }) => {
      void lastSessionKey
      return kept
    })
    return this.open()
  }

  async open(firstPrompt?: string): Promise<ConductorOpenResult> {
    this.opening ??= this.openNow(firstPrompt).finally(() => (this.opening = undefined))
    const opened = await this.opening
    // AGY§8
    if (opened.ok && firstPrompt && this.firstWordsComing(opened.tabId))
      void this.d.notice(firstPrompt)
    return opened
  }

  private launchFor(backend: BackendId): ButlerLaunch {
    const cwd = conductorFolder(this.d.userData)
    fs.mkdirSync(cwd, { recursive: true })
    return { backend, cwd, ...this.prompt(), title: this.d.butler().name }
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
    const launch: ButlerLaunch = {
      ...this.launchFor(choice.backend),
      ...(choice.model && { model: choice.model }),
      ...(choice.effort && { effort: choice.effort })
    }
    const last = this.session.lastSessionKey
    const sameAgent = last !== undefined && identityOf(last).backendId === launch.backend
    // CC§3 CODEX§11
    const carried = this.session.carried
    const keepsWhatItNoLongerNames =
      sameAgent && ((!!carried?.model && !launch.model) || (!!carried?.effort && !launch.effort))
    const key = keepsWhatItNoLongerNames ? undefined : last
    const resumable = key !== undefined && sameAgent
    if (keepsWhatItNoLongerNames)
      this.d.toast(
        `${launch.title} goes back to ${BACKEND_LABEL[launch.backend]}’s own model or thinking, so it starts a new conversation.`
      )
    else if (last !== undefined && !resumable)
      this.d.toast(
        `${launch.title} now runs on ${BACKEND_LABEL[launch.backend]}, so it starts a new conversation.`
      )
    else if (choice.because) this.d.toast(choice.because)
    let tabId: string | null
    let resumedOld = false
    let started = false
    const launchedWith = this.d.pluginsOn()
    try {
      if (resumable) {
        const live = this.d.liveTabFor(launch.backend, key)
        if (live) {
          this.resident = live
          this.launchedWith = undefined
          return { ok: true, tabId: live }
        }
        if (await this.d.runningElsewhere(launch.backend, key))
          return refusal(`${launch.title} is already running in another ${launch.backend} process.`)
      }
      const hasTranscript =
        resumable && (await this.d.transcriptExists(launch.backend, key).catch(() => false))
      resumedOld = hasTranscript
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
    this.changeSession(({ carried: _before, ...kept }) => ({
      ...kept,
      ...((launch.model || launch.effort) && {
        carried: {
          ...(launch.model && { model: launch.model }),
          ...(launch.effort && { effort: launch.effort })
        }
      })
    }))
    this.resident = tabId
    this.launchedWith = launchedWith
    if (resumedOld && key !== undefined) this.tellWhatChanged(key)
    // AGY§8
    if (started && !firstPrompt && conversationAtFirstPrompt(launch.backend))
      this.waitingForWords = tabId
    this.armDeadline(tabId, launch.title)
    return { ok: true, tabId }
  }

  firstWordsComing(tabId: string): boolean {
    if (tabId !== this.waitingForWords) return false
    this.waitingForWords = undefined
    this.armDeadline(tabId, this.d.butler().name)
    return true
  }

  private pluginsChangedSince(key: string, now: PluginsOn): PluginsOn {
    const seen = this.session.pluginsSeen
    if (seen?.key !== key) return {}
    return Object.fromEntries(Object.entries(now).filter(([id, on]) => (seen.on[id] ?? on) !== on))
  }

  // CC§23 CODEX§17 MUSE§9 AGY§8
  private tellWhatChanged(key: string): void {
    const { knownBy, on, text } = this.d.news
    const before = this.session.pluginsSeen
    const seen = { key, on: this.d.pluginsOn() }
    const changed = this.pluginsChangedSince(key, seen.on)
    const withNews = on() && !this.session[knownBy]?.includes(key)
    const parts = [
      ...(withNews ? [text] : []),
      ...(Object.keys(changed).length > 0 ? [this.d.pluginsNews(changed)] : [])
    ]
    if (before?.key === key && parts.length === 0) return
    this.changeSession((s) => ({
      ...s,
      pluginsSeen: seen,
      ...(withNews && { [knownBy]: [...(s[knownBy] ?? []), key] })
    }))
    if (parts.length === 0) return
    void this.d
      .noticeWhileOpen(withNews ? parts.join(' ') : `${FROM_KOLOFT}${parts[0]}`)
      .catch(() => false)
      .then((told) => {
        if (!told) this.untold(key, changed, withNews)
      })
  }

  private untold(key: string, changed: PluginsOn, withNews: boolean): void {
    const { knownBy } = this.d.news
    this.changeSession((s) => {
      const seen = s.pluginsSeen
      const asBefore = Object.fromEntries(Object.entries(changed).map(([id, on]) => [id, !on]))
      return {
        ...s,
        ...(seen?.key === key && { pluginsSeen: { key, on: { ...seen.on, ...asBefore } } }),
        ...(withNews && { [knownBy]: (s[knownBy] ?? []).filter((k) => k !== key) })
      }
    })
  }

  pluginsSwitched(): void {
    const tab = this.liveTab()
    const key = this.session.lastSessionKey
    if (!tab || this.deadlines.has(tab) || tab === this.waitingForWords || key === undefined) return
    this.tellWhatChanged(key)
  }

  private armDeadline(tabId: string, title: string): void {
    clearTimeout(this.deadlines.get(tabId))
    const timer = setTimeout(() => {
      this.deadlines.delete(tabId)
      if (this.resident !== tabId) return
      // AGY§8 AGY§10
      if (this.d.showsPromptBeforeBind(tabId)) {
        this.waitingForWords = tabId
        return
      }
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
      this.launchedWith = undefined
    }
    this.forgetTab(tabId)
    this.changeSession((s) => {
      const pluginsSeen =
        s.pluginsSeen?.key === key
          ? s.pluginsSeen
          : { key, on: this.launchedWith ?? this.d.pluginsOn() }
      return s.sessionIds.includes(key)
        ? { ...s, lastSessionKey: key, pluginsSeen }
        : {
            ...s,
            sessionIds: [...s.sessionIds, key],
            lastSessionKey: key,
            pluginsSeen,
            ...(this.d.news.on() && {
              [this.d.news.knownBy]: [...(s[this.d.news.knownBy] ?? []), key]
            })
          }
    })
    this.pluginsSwitched()
  }

  onPtyExit(tabId: string): void {
    this.stopping.delete(tabId)
    if (tabId === this.resident) this.resident = undefined
    this.forgetTab(tabId)
  }
}
