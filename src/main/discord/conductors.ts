import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  BackendId,
  ConductorBinding,
  ConductorOpenResult,
  ConductorSaveInput,
  ConductorSaveResult,
  DiscordSettings
} from '@shared/types'
import { BACKEND_LABEL, identityOf } from '@shared/sessionBackend'
import {
  bindingProblem,
  GLOBAL_SCOPE,
  keepPinnedBindings,
  newerSnowflake,
  scopeName
} from '@shared/conductors'
import { conductorRole } from '@shared/agentGuide'
import { isRemoteKey } from '@shared/remoteKey'
import { errorText } from '../agentRequests'

export interface ConductorLaunch {
  backend: BackendId
  cwd: string
  role: string
  title: string
}

export interface ConductorDeps {
  userData: string
  load(): DiscordSettings
  save(discord: DiscordSettings): void
  saveQuietly(discord: DiscordSettings): void
  isPinned(scope: string): boolean
  backendEnabled(backend: BackendId): boolean
  tabAlive(tabId: string): boolean
  liveTabFor(backend: BackendId, key: string): string | undefined
  runningElsewhere(backend: BackendId, key: string): Promise<boolean>
  transcriptExists(backend: BackendId, key: string): Promise<boolean>
  start(launch: ConductorLaunch): Promise<string | null>
  resume(launch: ConductorLaunch & { key: string }): Promise<string | null>
  kill(tabId: string): void
  rowsChanged(): void
  toast(text: string): void
  bindDeadlineMs: number
}

export const NOT_BOUND = 'That conductor is no longer bound.'
export const GLOBAL_HAS_NO_WORKSPACE = 'The global conductor has no workspace.'
export const REMOTE_CONDUCTOR_HAS_NO_WORKSPACE =
  'This conductor runs on this Mac, outside its remote workspace, so it has no workspace.'

const FOLDER_NAME_HASH_CHARS = 16
const LAST_MESSAGE_SAVE_DELAY_MS = 1000

export function conductorFolder(userData: string, scope: string): string {
  if (scope === GLOBAL_SCOPE) return path.join(userData, 'conductors', 'global')
  if (!isRemoteKey(scope)) return scope
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, FOLDER_NAME_HASH_CHARS)
  return path.join(userData, 'conductors', hash)
}

function refusal(error: string): ConductorOpenResult {
  return { ok: false, error }
}

export class Conductors {
  private discord: DiscordSettings
  private tabs = new Map<string, string>()
  private pendingSave: ReturnType<typeof setTimeout> | null = null
  private stopping = new Map<string, string>()
  private opening = new Map<string, Promise<ConductorOpenResult>>()
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTouch = new Map<string, string>()

  constructor(private d: ConductorDeps) {
    this.discord = d.load()
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

  flush(): void {
    if (!this.pendingSave) return
    clearTimeout(this.pendingSave)
    this.pendingSave = null
    this.d.saveQuietly(this.discord)
  }

  private find(id: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.id === id)
  }

  bindingOfTab(tabId: string): ConductorBinding | undefined {
    for (const [id, tab] of this.tabs) if (tab === tabId) return this.find(id)
    return undefined
  }

  bindingOfChannel(channelId: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) => b.channel.channelId === channelId)
  }

  bindingOfSession(ref: string): ConductorBinding | undefined {
    return this.discord.bindings.find((b) =>
      b.sessionIds.some((key) => key === ref || identityOf(key).nativeSessionId === ref)
    )
  }

  touchWhenBound(conductorTab: string, tabId: string): void {
    const b = this.bindingOfTab(conductorTab)
    if (b) this.pendingTouch.set(tabId, b.id)
  }

  liveTab(id: string): string | undefined {
    const tab = this.tabs.get(id)
    return tab && this.d.tabAlive(tab) ? tab : undefined
  }

  setLastMessage(id: string, messageId: string): void {
    const last = this.find(id)?.lastMessageId
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
    for (const [id, tab] of this.tabs) if (tab === tabOrSessionId) return id
    return (
      this.stopping.get(tabOrSessionId) ??
      this.discord.bindings.find((b) => b.sessionIds.includes(tabOrSessionId))?.id
    )
  }

  covers(workspace: string | undefined): boolean {
    return this.discord.bindings.some((b) => b.scope === GLOBAL_SCOPE || b.scope === workspace)
  }

  scopeOfTab(tabId: string): string | undefined {
    return this.bindingOfTab(tabId)?.scope
  }

  touch(tabId: string, key: string): void {
    const b = this.bindingOfTab(tabId)
    if (b) this.touchFor(b.id, key)
  }

  private touchFor(id: string, key: string): void {
    if (this.find(id)?.touched.includes(key)) return
    this.change(id, (x) => ({ ...x, touched: [...x.touched, key] }))
    this.d.saveQuietly(this.discord)
  }

  forgetGone(stillOnDisk: (key: string) => boolean): void {
    let changed = false
    const bindings = this.discord.bindings.map((b) => {
      const sessionIds = b.sessionIds.filter(stillOnDisk)
      const touched = b.touched.filter(stillOnDisk)
      if (sessionIds.length === b.sessionIds.length && touched.length === b.touched.length) return b
      changed = true
      return { ...b, sessionIds, touched }
    })
    if (!changed) return
    this.discord = { ...this.discord, bindings }
    this.d.saveQuietly(this.discord)
  }

  noWorkspaceReason(tabId: string): string | undefined {
    const b = this.bindingOfTab(tabId)
    if (!b) return undefined
    if (b.scope === GLOBAL_SCOPE) return GLOBAL_HAS_NO_WORKSPACE
    return isRemoteKey(b.scope) ? REMOTE_CONDUCTOR_HAS_NO_WORKSPACE : undefined
  }

  save(input: ConductorSaveInput): ConductorSaveResult {
    const { channel } = input
    if (!this.d.backendEnabled(input.backend))
      return {
        ok: false,
        error: `${BACKEND_LABEL[input.backend]} is turned off in Settings ▸ Sessions.`
      }
    const current = input.id ? this.find(input.id) : undefined
    if (input.id && !current) return { ok: false, error: NOT_BOUND }
    const scope = current?.scope ?? input.scope
    if (scope !== GLOBAL_SCOPE && !this.d.isPinned(scope))
      return { ok: false, error: 'Pick a workspace from the sidebar, or Global.' }
    const problem = bindingProblem(this.discord.bindings, {
      id: input.id,
      scope,
      channelId: channel.channelId
    })
    if (problem) return { ok: false, error: problem }
    if (current) this.update(current.id, (b) => ({ ...b, backend: input.backend, channel }))
    else
      this.write({
        bindings: [
          ...this.discord.bindings,
          { id: randomUUID(), scope, backend: input.backend, channel, sessionIds: [], touched: [] }
        ]
      })
    return { ok: true }
  }

  unbind(id: string): void {
    this.stopTab(id)
    this.write({ bindings: this.discord.bindings.filter((b) => b.id !== id) })
  }

  switchBackend(id: string): void {
    this.update(id, (b) => ({ ...b, backend: b.backend === 'claude' ? 'codex' : 'claude' }))
  }

  startFresh(id: string): Promise<ConductorOpenResult> {
    if (!this.find(id)) return Promise.resolve(refusal(NOT_BOUND))
    this.stopTab(id)
    this.update(id, (b) => ({ ...b, lastSessionKey: undefined }))
    return this.open(id)
  }

  owner(): string | undefined {
    return this.discord.userId
  }

  setOwner(owner: { id: string; name: string } | null): void {
    const { userId: droppedId, userName: droppedName, ...rest } = this.discord
    void droppedId
    void droppedName
    this.discord = owner ? { ...rest, userId: owner.id, userName: owner.name } : rest
    this.d.save(this.discord)
  }

  keepPinned(pinned: string[]): void {
    const kept = keepPinnedBindings(this.discord.bindings, pinned)
    if (kept.length !== this.discord.bindings.length) this.write({ bindings: kept })
  }

  removeWorkspace(wsPath: string): void {
    const b = this.discord.bindings.find((x) => x.scope === wsPath)
    if (b) this.unbind(b.id)
  }

  open(id: string): Promise<ConductorOpenResult> {
    const inflight = this.opening.get(id)
    if (inflight) return inflight
    const opening = this.openNow(id).finally(() => this.opening.delete(id))
    this.opening.set(id, opening)
    return opening
  }

  private async openNow(id: string): Promise<ConductorOpenResult> {
    const b = this.find(id)
    if (!b) return refusal(NOT_BOUND)
    const tab = this.tabs.get(id)
    if (tab && this.d.tabAlive(tab)) return { ok: true, tabId: tab }
    if (!this.d.backendEnabled(b.backend))
      return refusal(`${BACKEND_LABEL[b.backend]} is turned off in Settings ▸ Sessions.`)
    const cwd = conductorFolder(this.d.userData, b.scope)
    if (cwd !== b.scope) fs.mkdirSync(cwd, { recursive: true })
    const launch: ConductorLaunch = {
      backend: b.backend,
      cwd,
      role: conductorRole(b.scope),
      title: `${scopeName(b.scope)} conductor`
    }
    const key = b.lastSessionKey
    const resumable = key !== undefined && identityOf(key).backendId === b.backend
    let tabId: string | null
    try {
      if (resumable) {
        const live = this.d.liveTabFor(b.backend, key)
        if (live) {
          this.tabs.set(id, live)
          return { ok: true, tabId: live }
        }
        if (await this.d.runningElsewhere(b.backend, key))
          return refusal('This conductor is already running in another claude process.')
      }
      const hasTranscript =
        resumable && (await this.d.transcriptExists(b.backend, key).catch(() => false))
      tabId = hasTranscript ? await this.d.resume({ ...launch, key }) : await this.d.start(launch)
    } catch (error) {
      return refusal(errorText(error))
    }
    if (!tabId) return refusal(`The ${launch.title} could not start.`)
    this.tabs.set(id, tabId)
    this.armDeadline(id, tabId, launch.title)
    return { ok: true, tabId }
  }

  private armDeadline(id: string, tabId: string, title: string): void {
    const timer = setTimeout(() => {
      this.deadlines.delete(tabId)
      if (this.tabs.get(id) !== tabId) return
      this.stopTab(id)
      this.d.toast(`The ${title} did not start.`)
    }, this.d.bindDeadlineMs)
    this.deadlines.set(tabId, timer)
  }

  private stopTab(id: string): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.tabs.delete(id)
    this.forgetTab(tab)
    this.stopping.set(tab, id)
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
    let b = this.bindingOfTab(tabId)
    if (!b) {
      b = this.discord.bindings.find((x) => x.sessionIds.includes(key))
      const current = b && this.tabs.get(b.id)
      if (!b || (current && this.d.tabAlive(current))) return
      this.tabs.set(b.id, tabId)
    }
    this.forgetTab(tabId)
    this.update(b.id, (x) => ({
      ...x,
      sessionIds: x.sessionIds.includes(key) ? x.sessionIds : [...x.sessionIds, key],
      lastSessionKey: key
    }))
  }

  onPtyExit(tabId: string): void {
    this.stopping.delete(tabId)
    this.pendingTouch.delete(tabId)
    for (const [id, tab] of this.tabs) if (tab === tabId) this.tabs.delete(id)
    this.forgetTab(tabId)
  }
}
