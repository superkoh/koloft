import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  AssistRecord,
  AssistTaskRow,
  BackendId,
  ConductorBinding,
  ConductorOpenResult,
  ConductorSaveInput,
  NewChannelInput,
  ConductorSaveResult,
  DiscordChannel,
  DiscordSettings,
  SessionThread
} from '@shared/types'
import { CannotMakeChannels, type NewChannel } from './link'
import { BACKEND_LABEL, identityOf } from '@shared/sessionBackend'
import {
  assistTaskName,
  bindingProblem,
  GLOBAL_SCOPE,
  keepPinnedScopes,
  newerSnowflake,
  conductorName,
  peerNamesOf
} from '@shared/conductors'
import { assistTaskRole, conductorRole } from '@shared/agentGuide'
import { isRemoteKey } from '@shared/remoteKey'
import { errorText } from '../agentRequests'
import { realpathSafe } from '../projectInfo'
import { CODEX_GATE_NOT_TRUSTED } from '../conductorGate'

export interface ConductorLaunch {
  backend: BackendId
  cwd: string
  role: string
  allow?: string[]
  title: string
  firstPrompt?: string
}

export const TASK_KICKOFF = 'Do the task in your instructions now.'

export type AssistBackendPick = { backend: BackendId; because?: string }
export type AssistBackendChoice = AssistBackendPick | { error: string }

export interface AssistTask {
  name: string
  brief: string
  allow?: string[]
  typedInPalette?: true
}

export interface AssistIdentity {
  scope: string
  role: string
  allow: string[]
  task?: string
}

export interface ConductorDeps {
  userData: string
  load(): DiscordSettings
  loadRecords(): AssistRecord[]
  save(discord: DiscordSettings): void
  saveQuietly(discord: DiscordSettings): void
  saveRecords(records: AssistRecord[]): void
  isPinned(scope: string): boolean
  backend(avoid?: BackendId): Promise<AssistBackendChoice>
  tabAlive(tabId: string): boolean
  liveTabFor(backend: BackendId, key: string): string | undefined
  runningElsewhere(backend: BackendId, key: string): Promise<boolean>
  transcriptExists(backend: BackendId, key: string): Promise<boolean>
  start(launch: ConductorLaunch): Promise<string | null>
  resume(launch: ConductorLaunch & { key: string }): Promise<string | null>
  kill(tabId: string): void
  say(channelId: string, text: string): void
  rowsChanged(): void
  tasksChanged(): void
  toast(text: string): void
  bindDeadlineMs: number
}

export const NOT_BOUND = 'That Assist is no longer bound.'
export const GLOBAL_HAS_NO_WORKSPACE = 'The global Assist has no workspace.'
export const REMOTE_CONDUCTOR_HAS_NO_WORKSPACE =
  'This Assist runs on this Mac, outside its remote workspace, so it has no workspace.'
const NOT_AN_ASSIST_SCOPE = 'Pick a workspace from the sidebar, or Global.'

const FOLDER_NAME_HASH_CHARS = 16
const LAST_MESSAGE_SAVE_DELAY_MS = 1000

// ADR-0029 CC§3 CODEX§2
export function conductorFolder(userData: string, scope: string): string {
  if (scope === GLOBAL_SCOPE) return path.join(userData, 'conductors', 'global')
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, FOLDER_NAME_HASH_CHARS)
  return path.join(userData, 'conductors', hash)
}

export function workspaceRemovedLine(scope: string): string {
  return `The ${conductorName(scope)} was removed with its workspace, so it no longer answers here. This channel stays; bind it again from Koloft to use it.`
}

interface BoundThread {
  binding: ConductorBinding
  thread: SessionThread
}

interface RunningTask extends AssistTask {
  scope: string
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
  private tabs = new Map<string, string>()
  private tasks: RunningTask[] = []
  private pendingSave: ReturnType<typeof setTimeout> | null = null
  private stopping = new Map<string, string>()
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

  private changeRecord(scope: string, change: (r: AssistRecord) => AssistRecord): void {
    const at = this.records.findIndex((r) => r.scope === scope)
    const current = at < 0 ? { scope, sessionIds: [] } : this.records[at]
    const next = change(current)
    this.writeRecords(
      at < 0 ? [...this.records, next] : this.records.map((r, i) => (i === at ? next : r))
    )
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

  bindingOfScope(scope: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.scope === scope)
  }

  record(scope: string): AssistRecord | undefined {
    return this.records.find((r) => r.scope === scope)
  }

  private scopeOfResident(tabId: string): string | undefined {
    for (const [scope, tab] of this.tabs) if (tab === tabId) return scope
    return undefined
  }

  private taskOfTab(tabId: string): RunningTask | undefined {
    return this.tasks.find((t) => t.tabId === tabId)
  }

  bindingOfTab(tabId: string): ConductorBinding | undefined {
    const scope = this.scopeOfResident(tabId)
    return scope ? this.bindingOfScope(scope) : undefined
  }

  bindingOfChannel(channelId: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.channel.channelId === channelId)
  }

  scopeOf(ref: string): string | undefined {
    const bySession = this.records.find((r) =>
      r.sessionIds.some((key) => key === ref || identityOf(key).nativeSessionId === ref)
    )?.scope
    if (bySession) return bySession
    return this.knownScopes().find((scope) => peerNamesOf(scope).includes(ref))
  }

  private knownScopes(): string[] {
    return [
      ...new Set([
        GLOBAL_SCOPE,
        ...this.records.map((r) => r.scope),
        ...this.discord.bindings.map((b) => b.scope)
      ])
    ]
  }

  touchWhenBound(conductorTab: string, tabId: string): void {
    const b = this.bindingOfTab(conductorTab)
    if (b) this.pendingTouch.set(tabId, b.id)
  }

  touchNowAndNext(id: string, key: string, tabId: string | undefined): void {
    this.touchFor(id, key)
    if (tabId) this.pendingTouch.set(tabId, id)
  }

  liveTab(scope: string): string | undefined {
    const tab = this.tabs.get(scope)
    return tab && this.d.tabAlive(tab) ? tab : undefined
  }

  setLastMessage(id: string, messageId: string): void {
    const last = this.binding(id)?.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.change(id, (b) => ({ ...b, lastMessageId: messageId }))
    this.pendingSave ??= setTimeout(() => this.flush(), LAST_MESSAGE_SAVE_DELAY_MS)
  }

  private update(id: string, change: (b: ConductorBinding) => ConductorBinding): void {
    this.change(id, change)
    this.d.save(this.discord)
    this.d.rowsChanged()
  }

  conductorOf(tabOrSessionId: string): string | undefined {
    return (
      this.scopeOfResident(tabOrSessionId) ??
      this.taskOfTab(tabOrSessionId)?.scope ??
      this.stopping.get(tabOrSessionId) ??
      this.records.find((r) => r.sessionIds.includes(tabOrSessionId))?.scope
    )
  }

  taskNameOf(tabId: string): string | undefined {
    return this.taskOfTab(tabId)?.name
  }

  heldResident(tabId: string): boolean {
    const scope = this.scopeOfResident(tabId)
    return !!scope && !!this.bindingOfScope(scope)
  }

  covers(workspace: string | undefined): boolean {
    return this.discord.bindings.some((b) => b.scope === GLOBAL_SCOPE || b.scope === workspace)
  }

  scopeOfTab(tabId: string): string | undefined {
    return this.scopeOfResident(tabId) ?? this.taskOfTab(tabId)?.scope
  }

  // ADR-0029
  workspaceOfTab(tabId: string): string | undefined {
    const scope = this.scopeOfTab(tabId)
    return scope && !this.noWorkspaceReason(tabId) ? scope : undefined
  }

  // ADR-0029
  identityOfLaunch(cwd: string, resumeKey?: string): AssistIdentity | undefined {
    const launched = realpathSafe(path.resolve(cwd))
    const scope = this.knownScopes().find(
      (s) => realpathSafe(conductorFolder(this.d.userData, s)) === launched
    )
    if (!scope) return undefined
    const task = resumeKey ? this.tasks.find((t) => t.key === resumeKey) : undefined
    if (task) return { scope, role: task.role, allow: task.allow ?? [], task: task.name }
    return { scope, role: conductorRole(scope, !!this.bindingOfScope(scope)), allow: [] }
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
    let recordsChanged = false
    const records = this.records.map((r) => {
      const sessionIds = r.sessionIds.filter(stillOnDisk)
      const keepLast = !r.lastSessionKey || stillOnDisk(r.lastSessionKey)
      if (sessionIds.length === r.sessionIds.length && keepLast) return r
      recordsChanged = true
      const { lastSessionKey, ...rest } = r
      return { ...rest, sessionIds, ...(keepLast && lastSessionKey ? { lastSessionKey } : {}) }
    })
    if (recordsChanged) this.writeRecords(records)
  }

  noWorkspaceReason(tabId: string): string | undefined {
    const scope = this.scopeOfTab(tabId)
    if (!scope) return undefined
    if (scope === GLOBAL_SCOPE) return GLOBAL_HAS_NO_WORKSPACE
    return isRemoteKey(scope) ? REMOTE_CONDUCTOR_HAS_NO_WORKSPACE : undefined
  }

  private canHaveAssist(scope: string): boolean {
    return scope === GLOBAL_SCOPE || this.d.isPinned(scope)
  }

  private saveProblem(input: NewChannelInput, channelId?: string): string | undefined {
    if (input.id && !this.binding(input.id)) return NOT_BOUND
    const scope = this.scopeToSave(input)
    if (!this.canHaveAssist(scope)) return NOT_AN_ASSIST_SCOPE
    return bindingProblem(this.discord.bindings, { id: input.id, scope, channelId })
  }

  private scopeToSave(input: NewChannelInput): string {
    return (input.id && this.binding(input.id)?.scope) || input.scope
  }

  async saveWithNewChannel(
    input: NewChannelInput,
    backend: BackendId,
    make: (scope: string, category: DiscordChannel | undefined) => Promise<NewChannel>
  ): Promise<ConductorSaveResult> {
    const problem = this.saveProblem(input)
    if (problem) return { ok: false, error: problem }
    let made: NewChannel
    try {
      made = await make(this.scopeToSave(input), this.discord.category)
    } catch (error) {
      return {
        ok: false,
        error: errorText(error),
        ...(error instanceof CannotMakeChannels ? { cannotMakeChannels: true } : {})
      }
    }
    this.discord = { ...this.discord, category: made.category }
    return this.save({ ...input, channel: made.channel }, backend)
  }

  save(input: ConductorSaveInput, backend: BackendId): ConductorSaveResult {
    const { channel } = input
    const problem = this.saveProblem(input, channel.channelId)
    if (problem) return { ok: false, error: problem }
    const current = input.id ? this.binding(input.id) : undefined
    const scope = this.scopeToSave(input)
    if (current) this.update(current.id, (b) => ({ ...b, backend, channel }))
    else
      this.write({
        bindings: [
          ...this.discord.bindings,
          { id: randomUUID(), scope, backend, channel, touched: [] }
        ]
      })
    return { ok: true }
  }

  followBackend(backend: BackendId): void {
    if (this.discord.bindings.every((b) => b.backend === backend)) return
    this.write({ bindings: this.discord.bindings.map((b) => ({ ...b, backend })) })
  }

  unbind(id: string): void {
    this.write({ bindings: this.discord.bindings.filter((b) => b.id !== id) })
  }

  startFresh(scope: string): Promise<ConductorOpenResult> {
    if (!this.canHaveAssist(scope)) return Promise.resolve(refusal(NOT_AN_ASSIST_SCOPE))
    this.stopResident(scope)
    this.changeRecord(scope, (r) => {
      const { lastSessionKey, ...rest } = r
      void lastSessionKey
      return rest
    })
    return this.open(scope)
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

  keepPinned(pinned: string[]): void {
    const kept = keepPinnedScopes(this.discord.bindings, pinned)
    if (kept.length !== this.discord.bindings.length) this.write({ bindings: kept })
    const keptRecords = keepPinnedScopes(this.records, pinned)
    if (keptRecords.length !== this.records.length) this.writeRecords(keptRecords)
  }

  removeWorkspace(scope: string): void {
    const b = this.bindingOfScope(scope)
    if (b) {
      this.d.say(b.channel.channelId, workspaceRemovedLine(scope))
      this.unbind(b.id)
    }
    this.stopResident(scope)
    for (const t of this.tasks.filter((x) => x.scope === scope)) this.closeTask(t.tabId)
    if (this.record(scope)) this.writeRecords(this.records.filter((r) => r.scope !== scope))
  }

  open(scope: string): Promise<ConductorOpenResult> {
    return this.once(scope, () => this.openNow(scope))
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

  private launchFor(scope: string, backend: BackendId): ConductorLaunch {
    const cwd = conductorFolder(this.d.userData, scope)
    fs.mkdirSync(cwd, { recursive: true })
    const title = conductorName(scope)
    return {
      backend,
      cwd,
      role: conductorRole(scope, !!this.bindingOfScope(scope)),
      title
    }
  }

  // ADR-0029 CODEX§27
  private async onClaudeIfCodexRefusedTheGate(
    choice: AssistBackendPick,
    open: (choice: AssistBackendPick) => Promise<ConductorOpenResult>
  ): Promise<ConductorOpenResult> {
    const result = await open(choice)
    if (result.ok || choice.backend !== 'codex' || result.error !== CODEX_GATE_NOT_TRUSTED)
      return result
    const fallback = await this.d.backend('codex')
    if ('error' in fallback) return refusal(fallback.error)
    this.d.toast(`Assist runs on Claude this time: ${CODEX_GATE_NOT_TRUSTED}`)
    return open({ backend: fallback.backend })
  }

  private async openNow(scope: string): Promise<ConductorOpenResult> {
    if (!this.canHaveAssist(scope)) return refusal(NOT_AN_ASSIST_SCOPE)
    const tab = this.tabs.get(scope)
    if (tab && this.d.tabAlive(tab)) return { ok: true, tabId: tab }
    const choice = await this.d.backend()
    if ('error' in choice) return refusal(choice.error)
    return this.onClaudeIfCodexRefusedTheGate(choice, (c) => this.openOn(scope, c))
  }

  private async openOn(scope: string, choice: AssistBackendPick): Promise<ConductorOpenResult> {
    if (!this.record(scope)) this.changeRecord(scope, (r) => r)
    const launch = this.launchFor(scope, choice.backend)
    const key = this.record(scope)?.lastSessionKey
    const resumable = key !== undefined && identityOf(key).backendId === launch.backend
    if (key !== undefined && !resumable)
      this.d.toast(
        `The ${launch.title} now runs on ${BACKEND_LABEL[launch.backend]}, so it starts a new conversation.`
      )
    else if (choice.because) this.d.toast(choice.because)
    let tabId: string | null
    try {
      if (resumable) {
        const live = this.d.liveTabFor(launch.backend, key)
        if (live) {
          this.tabs.set(scope, live)
          return { ok: true, tabId: live }
        }
        if (await this.d.runningElsewhere(launch.backend, key))
          return refusal('This Assist is already running in another claude process.')
      }
      const hasTranscript =
        resumable && (await this.d.transcriptExists(launch.backend, key).catch(() => false))
      tabId = hasTranscript ? await this.d.resume({ ...launch, key }) : await this.d.start(launch)
    } catch (error) {
      return refusal(errorText(error))
    }
    if (!tabId) return refusal(`The ${launch.title} could not start.`)
    this.tabs.set(scope, tabId)
    this.armDeadline(tabId, launch.title, () => this.tabs.get(scope) === tabId)
    return { ok: true, tabId }
  }

  openTask(scope: string, task: AssistTask): Promise<ConductorOpenResult> {
    return this.once(`${scope}\n${task.name}`, () => this.openTaskNow(scope, task))
  }

  private async openTaskNow(scope: string, task: AssistTask): Promise<ConductorOpenResult> {
    if (!this.canHaveAssist(scope)) return refusal(NOT_AN_ASSIST_SCOPE)
    const running = this.tasks.find((t) => t.scope === scope && t.name === task.name)
    if (running) return { ok: true, tabId: running.tabId }
    const choice = await this.d.backend()
    if ('error' in choice) return refusal(choice.error)
    return this.onClaudeIfCodexRefusedTheGate(choice, (c) => this.openTaskOn(scope, task, c))
  }

  private async openTaskOn(
    scope: string,
    task: AssistTask,
    choice: AssistBackendPick
  ): Promise<ConductorOpenResult> {
    if (choice.because) this.d.toast(choice.because)
    if (!this.record(scope)) this.changeRecord(scope, (r) => r)
    const role = assistTaskRole(scope, task.brief, task.typedInPalette)
    const title = assistTaskName(scope, task.name)
    const launch: ConductorLaunch = {
      ...this.launchFor(scope, choice.backend),
      role,
      allow: task.allow ?? [],
      title,
      firstPrompt: TASK_KICKOFF
    }
    const placeholder: RunningTask = { ...task, scope, role, tabId: '' }
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

  runningTaskTab(scope: string, name: string): string | undefined {
    return this.tasks.find((t) => t.scope === scope && t.name === name && t.tabId)?.tabId
  }

  taskRows(): AssistTaskRow[] {
    return this.tasks
      .filter((t) => t.tabId)
      .map((t) => ({ tabId: t.tabId, scope: t.scope, name: t.name }))
  }

  closeTask(tabId: string): void {
    const task = this.taskOfTab(tabId)
    if (!task) return
    this.tasks = this.tasks.filter((t) => t !== task)
    this.forgetTab(tabId)
    this.stopping.set(tabId, task.scope)
    this.d.kill(tabId)
    this.d.tasksChanged()
  }

  private armDeadline(tabId: string, title: string, stillWaiting: () => boolean): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(tabId)
      if (!stillWaiting()) return
      const scope = this.scopeOfResident(tabId)
      if (scope) this.stopResident(scope)
      else this.closeTask(tabId)
      this.d.toast(`The ${title} did not start.`)
    }, this.d.bindDeadlineMs)
    this.deadlines.set(tabId, timer)
  }

  private stopResident(scope: string): void {
    const tab = this.tabs.get(scope)
    if (!tab) return
    this.tabs.delete(scope)
    this.forgetTab(tab)
    this.stopping.set(tab, scope)
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
      this.changeRecord(task.scope, (r) =>
        r.sessionIds.includes(key) ? r : { ...r, sessionIds: [...r.sessionIds, key] }
      )
      if (moved) this.d.tasksChanged()
      return
    }
    let scope = this.scopeOfResident(tabId)
    if (!scope) {
      scope = this.records.find((r) => r.lastSessionKey === key)?.scope
      const current = scope && this.tabs.get(scope)
      if (!scope || (current && this.d.tabAlive(current))) return
      this.tabs.set(scope, tabId)
    }
    this.forgetTab(tabId)
    this.changeRecord(scope, (r) => ({
      ...r,
      sessionIds: r.sessionIds.includes(key) ? r.sessionIds : [...r.sessionIds, key],
      lastSessionKey: key
    }))
  }

  onPtyExit(tabId: string, asleep: boolean): void {
    this.stopping.delete(tabId)
    this.pendingTouch.delete(tabId)
    for (const [scope, tab] of this.tabs) if (tab === tabId) this.tabs.delete(scope)
    this.forgetTab(tabId)
    const task = asleep ? undefined : this.taskOfTab(tabId)
    if (!task) return
    this.tasks = this.tasks.filter((t) => t !== task)
    this.d.tasksChanged()
  }
}
