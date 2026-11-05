import type { BackendId, DiscordChannel, SessionRoom } from '@shared/types'
import { newerSnowflake, scopeName } from '@shared/conductors'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { accentOf, type Card } from './cards'
import type { DiscordLink } from './link'

export const CLOSED_IN_ROOM = '⏹ Closed.'
export const STOPPED_IN_ROOM = '⚠ It stopped unexpectedly.'
export const STARTED_OVER_IN_ROOM =
  '🧹 Started over: it is a new conversation now, in this same room.'
export const NO_LOBBY = 'No Discord channel is bound, so there is nowhere to open a room.'

export interface RoomSubject {
  tabId?: string
  key?: string
  name: string
  backend: BackendId
  workspace?: string
}

export interface RoomDeps {
  link: Pick<DiscordLink, 'card' | 'startThread' | 'addToThread' | 'archiveThread' | 'post'>
  owner(): string | undefined
  lobby(): DiscordChannel | undefined
  rooms(): SessionRoom[]
  save(rooms: SessionRoom[]): void
}

export function whereOf(s: Pick<RoomSubject, 'backend' | 'workspace'>): string {
  const where = [s.workspace && scopeName(s.workspace), BACKEND_LABEL[s.backend]]
  return where.filter(Boolean).join(' · ')
}

export function openerCard(s: RoomSubject): Card {
  return { accent: accentOf(s.name), header: `🧵 **${s.name}**`, body: `-# ${whereOf(s)}` }
}

export const roomLink = (threadId: string): string => `<#${threadId}>`

export class Rooms {
  private keyOfTab = new Map<string, string>()
  private unbound = new Map<string, SessionRoom>()
  private opening = new Map<string, Promise<string>>()

  constructor(private d: RoomDeps) {}

  ofThread(threadId: string): SessionRoom | undefined {
    return (
      this.d.rooms().find((r) => r.threadId === threadId) ??
      [...this.unbound.values()].find((r) => r.threadId === threadId)
    )
  }

  ofKey(key: string): SessionRoom | undefined {
    return this.d.rooms().find((r) => r.keys.includes(key))
  }

  ofTab(tabId: string): SessionRoom | undefined {
    const key = this.keyOfTab.get(tabId)
    return (key && this.ofKey(key)) || this.unbound.get(tabId)
  }

  carried(tabId: string): string | undefined {
    const room = this.ofTab(tabId)
    return room && !room.putDown ? room.threadId : undefined
  }

  tabOfThread(threadId: string): string | undefined {
    for (const [tabId, room] of this.unbound) if (room.threadId === threadId) return tabId
    const room = this.ofThread(threadId)
    for (const [tabId, key] of this.keyOfTab) if (room?.keys.includes(key)) return tabId
    return undefined
  }

  private change(threadId: string, patch: Partial<SessionRoom>): void {
    const waiting = [...this.unbound.values()].find((r) => r.threadId === threadId)
    if (waiting) Object.assign(waiting, patch)
    const stored = this.d.rooms()
    if (stored.some((r) => r.threadId === threadId))
      this.d.save(stored.map((r) => (r.threadId === threadId ? { ...r, ...patch } : r)))
  }

  private store(room: SessionRoom): void {
    this.d.save([...this.d.rooms().filter((r) => r.threadId !== room.threadId), room])
  }

  open(s: RoomSubject, show: (threadId: string) => Promise<void>): Promise<string> {
    const slot = s.key ?? `tab:${s.tabId}`
    const inflight = this.opening.get(slot)
    if (inflight) return inflight
    const opening = this.openNow(s, show).finally(() => this.opening.delete(slot))
    this.opening.set(slot, opening)
    return opening
  }

  private async openNow(
    s: RoomSubject,
    show: (threadId: string) => Promise<void>
  ): Promise<string> {
    const known = (s.key && this.ofKey(s.key)) || (s.tabId && this.ofTab(s.tabId)) || undefined
    const threadId = known ? known.threadId : await this.make(s)
    if (known?.putDown) this.change(threadId, { putDown: undefined })
    if (s.tabId && s.key) this.keyOfTab.set(s.tabId, s.key)
    // PLATFORM§39
    await show(threadId)
    const owner = this.d.owner()
    if (owner) await this.d.link.addToThread(threadId, owner).catch(() => undefined)
    return threadId
  }

  private async make(s: RoomSubject): Promise<string> {
    const lobby = this.d.lobby()
    if (!lobby) throw new Error(NO_LOBBY)
    const [opener] = await this.d.link.card(lobby.channelId, openerCard(s))
    const threadId = await this.d.link.startThread(lobby.channelId, opener, s.name)
    const key = s.key ?? (s.tabId && this.keyOfTab.get(s.tabId))
    // PLATFORM§39
    const room: SessionRoom = {
      threadId,
      keys: key ? [key] : [],
      name: s.name,
      lastMessageId: threadId
    }
    if (key) this.store(room)
    else if (s.tabId) this.unbound.set(s.tabId, room)
    return threadId
  }

  async bound(tabId: string, key: string, newConversation: () => Promise<boolean>): Promise<void> {
    const before = this.keyOfTab.get(tabId)
    this.keyOfTab.set(tabId, key)
    if (this.ofKey(key)) return
    const waiting = this.unbound.get(tabId)
    if (waiting) {
      this.unbound.delete(tabId)
      this.store({ ...waiting, keys: [key] })
      return
    }
    const carried = before ? this.ofKey(before) : undefined
    if (!carried || !(await newConversation()) || this.keyOfTab.get(tabId) !== key) return
    this.change(carried.threadId, { keys: [...carried.keys, key] })
    if (!carried.putDown) void this.say(carried.threadId, STARTED_OVER_IN_ROOM)
  }

  private say(threadId: string, text: string): Promise<unknown> {
    return this.d.link.post(threadId, text).catch(() => undefined)
  }

  handsOn(tabId: string): void {
    const threadId = this.carried(tabId)
    if (!threadId) return
    this.change(threadId, { putDown: true })
    void this.d.link.archiveThread(threadId).catch(() => undefined)
  }

  ownerSpoke(threadId: string): void {
    if (this.ofThread(threadId)?.putDown) this.change(threadId, { putDown: undefined })
  }

  seen(threadId: string, messageId: string): void {
    const last = this.ofThread(threadId)?.lastMessageId
    if (last && !newerSnowflake(messageId, last)) return
    this.change(threadId, { lastMessageId: messageId })
  }

  // PLATFORM§39
  async closed(tabId: string): Promise<void> {
    const threadId = this.carried(tabId)
    this.forget(tabId)
    if (!threadId) return
    this.change(threadId, { putDown: true })
    await this.say(threadId, CLOSED_IN_ROOM)
    await this.d.link.archiveThread(threadId).catch(() => undefined)
  }

  stopped(tabId: string): void {
    const threadId = this.carried(tabId)
    this.forget(tabId)
    if (threadId) void this.say(threadId, STOPPED_IN_ROOM)
  }

  forget(tabId: string): void {
    this.keyOfTab.delete(tabId)
    this.unbound.delete(tabId)
  }
}
