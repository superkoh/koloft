import type { BackendId, ConductorBinding } from '@shared/types'
import { GLOBAL_SCOPE, scopeName } from '@shared/conductors'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { accentOf, type Card } from './cards'
import type { Conductors } from './conductors'
import type { DiscordLink } from './link'

export interface ThreadSubject {
  tabId?: string
  key?: string
  name: string
  backend: BackendId
  workspace?: string
}

export interface ThreadDeps {
  link: Pick<DiscordLink, 'card' | 'startThread' | 'addToThread' | 'archiveThread'>
  conductors: Pick<Conductors, 'owner' | 'threadOfKey' | 'keepThread'>
}

interface TabThread {
  bindingId: string
  threadId: string
}

export function openerCard(s: ThreadSubject, started: boolean): Card {
  const where = [s.workspace && scopeName(s.workspace), BACKEND_LABEL[s.backend]]
    .filter(Boolean)
    .join(' · ')
  return {
    accent: accentOf(s.name),
    header: `${started ? '▶ Started' : '🧵'} **${s.name}**`,
    body: `-# ${where}`,
    silent: true
  }
}

export function threadName(b: ConductorBinding, s: ThreadSubject): string {
  return b.scope === GLOBAL_SCOPE && s.workspace ? `${s.name} · ${scopeName(s.workspace)}` : s.name
}

export class SessionThreads {
  private byTab = new Map<string, TabThread>()
  private keyOfTab = new Map<string, string>()
  private opening = new Map<string, Promise<string>>()
  private threadless = new Set<string>()

  constructor(private d: ThreadDeps) {}

  hasThread(key: string): boolean {
    return !!this.d.conductors.threadOfKey(key)
  }

  place(b: ConductorBinding, s: ThreadSubject, started = false): Promise<string> {
    const slot = s.tabId ?? `key:${s.key}`
    const known = s.key ? this.d.conductors.threadOfKey(s.key) : undefined
    if (known) {
      if (s.tabId)
        this.byTab.set(s.tabId, { bindingId: known.binding.id, threadId: known.thread.threadId })
      return Promise.resolve(known.thread.threadId)
    }
    const mine = s.tabId ? this.byTab.get(s.tabId) : undefined
    if (mine) {
      if (s.key) this.d.conductors.keepThread(mine.bindingId, mine.threadId, s.key)
      return Promise.resolve(mine.threadId)
    }
    if (this.threadless.has(slot)) return Promise.resolve(b.channel.channelId)
    const inflight = this.opening.get(slot)
    if (inflight) return inflight
    const opening = this.open(b, s, slot, started).finally(() => this.opening.delete(slot))
    this.opening.set(slot, opening)
    return opening
  }

  private async open(
    b: ConductorBinding,
    s: ThreadSubject,
    slot: string,
    started: boolean
  ): Promise<string> {
    const channelId = b.channel.channelId
    try {
      const [opener] = await this.d.link.card(channelId, openerCard(s, started))
      const threadId = await this.d.link.startThread(channelId, opener, threadName(b, s))
      if (s.tabId) this.byTab.set(s.tabId, { bindingId: b.id, threadId })
      const key = s.key ?? (s.tabId && this.keyOfTab.get(s.tabId))
      if (key) this.d.conductors.keepThread(b.id, threadId, key)
      const owner = this.d.conductors.owner()
      if (owner) void this.d.link.addToThread(threadId, owner).catch(() => undefined)
      return threadId
    } catch {
      this.threadless.add(slot)
      return channelId
    }
  }

  bound(tabId: string, key: string): void {
    const before = this.keyOfTab.get(tabId)
    this.keyOfTab.set(tabId, key)
    const own = this.d.conductors.threadOfKey(key)
    if (own) {
      this.byTab.set(tabId, { bindingId: own.binding.id, threadId: own.thread.threadId })
      return
    }
    const previous = before ? this.d.conductors.threadOfKey(before) : undefined
    const carried =
      this.byTab.get(tabId) ??
      (previous && { bindingId: previous.binding.id, threadId: previous.thread.threadId })
    if (!carried) return
    this.byTab.set(tabId, carried)
    this.d.conductors.keepThread(carried.bindingId, carried.threadId, key)
  }

  archive(threadId: string): void {
    void this.d.link.archiveThread(threadId).catch(() => undefined)
  }

  forget(tabId: string): void {
    this.byTab.delete(tabId)
    this.keyOfTab.delete(tabId)
    this.threadless.delete(tabId)
  }
}
