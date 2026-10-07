import type { BackendId, ConductorBinding, SessionThread } from '@shared/types'
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
  link: Pick<
    DiscordLink,
    'card' | 'startThread' | 'addToThread' | 'archiveThread' | 'renameThread' | 'deleteThread'
  >
  conductors: Pick<
    Conductors,
    | 'owner'
    | 'binding'
    | 'threadOfKey'
    | 'threadOfChannel'
    | 'keepThread'
    | 'nameThread'
    | 'dropThread'
  >
  deleteFailed(threadName: string, error: unknown): void
}

interface TabThread {
  bindingId: string
  threadId: string
  global: boolean
  name?: string
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

function named(global: boolean, name: string, workspace?: string): string {
  return global && workspace ? `${name} · ${scopeName(workspace)}` : name
}

export function threadName(b: ConductorBinding, s: ThreadSubject): string {
  return named(b.scope === GLOBAL_SCOPE, s.name, s.workspace)
}

function tabThread(b: ConductorBinding, t: Pick<SessionThread, 'threadId' | 'name'>): TabThread {
  return { bindingId: b.id, threadId: t.threadId, global: b.scope === GLOBAL_SCOPE, name: t.name }
}

export class SessionThreads {
  private byTab = new Map<string, TabThread>()
  private keyOfTab = new Map<string, string>()
  private opening = new Map<string, Promise<string>>()
  private threadless = new Set<string>()
  private wanted = new Map<string, string>()
  private offTheSidebar = new Set<string>()

  constructor(private d: ThreadDeps) {}

  threadOf(key: string): string | undefined {
    if (this.offTheSidebar.has(key)) return undefined
    return this.d.conductors.threadOfKey(key)?.thread.threadId
  }

  place(b: ConductorBinding, s: ThreadSubject, started = false): Promise<string> {
    const slot = s.tabId ?? `key:${s.key}`
    const known = s.key ? this.d.conductors.threadOfKey(s.key) : undefined
    if (known) {
      if (s.tabId) this.byTab.set(s.tabId, tabThread(known.binding, known.thread))
      return Promise.resolve(known.thread.threadId)
    }
    const mine = s.tabId ? this.byTab.get(s.tabId) : undefined
    if (mine) {
      if (s.key) this.keep(mine, s.key)
      return Promise.resolve(mine.threadId)
    }
    if (this.threadless.has(slot)) return Promise.resolve(b.channel.channelId)
    const inflight = this.opening.get(slot)
    if (inflight) return inflight
    const opening = this.open(b, s, slot, started).finally(() => this.opening.delete(slot))
    this.opening.set(slot, opening)
    return opening
  }

  private keep(t: TabThread, key: string): void {
    this.d.conductors.keepThread(t.bindingId, t.threadId, key)
    if (t.name) this.d.conductors.nameThread(t.threadId, t.name)
  }

  private async open(
    b: ConductorBinding,
    s: ThreadSubject,
    slot: string,
    started: boolean
  ): Promise<string> {
    const channelId = b.channel.channelId
    try {
      const name = threadName(b, s)
      const [opener] = await this.d.link.card(channelId, openerCard(s, started))
      const threadId = await this.d.link.startThread(channelId, opener, name)
      const t = tabThread(b, { threadId, name })
      if (s.tabId) this.byTab.set(s.tabId, t)
      const key = s.key ?? (s.tabId && this.keyOfTab.get(s.tabId))
      if (key) this.keep(t, key)
      const owner = this.d.conductors.owner()
      if (owner) void this.d.link.addToThread(threadId, owner).catch(() => undefined)
      return threadId
    } catch {
      this.threadless.add(slot)
      return channelId
    }
  }

  bound(tabId: string, key: string): void {
    this.offTheSidebar.delete(key)
    const before = this.keyOfTab.get(tabId)
    this.keyOfTab.set(tabId, key)
    const own = this.d.conductors.threadOfKey(key)
    if (own) {
      this.byTab.set(tabId, tabThread(own.binding, own.thread))
      return
    }
    const previous = before ? this.d.conductors.threadOfKey(before) : undefined
    const carried =
      this.byTab.get(tabId) ?? (previous && tabThread(previous.binding, previous.thread))
    if (!carried) return
    this.byTab.set(tabId, carried)
    this.keep(carried, key)
  }

  retitle(tabId: string, title: string, workspace?: string): void {
    const t = this.byTab.get(tabId)
    if (!t) return
    const name = named(t.global, title, workspace)
    if (t.name === name) return
    t.name = name
    const idle = !this.wanted.has(t.threadId)
    this.wanted.set(t.threadId, name)
    if (idle) void this.rename(t.threadId)
  }

  // PLATFORM§39
  private async rename(threadId: string): Promise<void> {
    for (;;) {
      const name = this.wanted.get(threadId)!
      const renamed = await this.d.link.renameThread(threadId, name).then(
        () => true,
        () => false
      )
      if (renamed) this.d.conductors.nameThread(threadId, name)
      if (this.wanted.get(threadId) === name) break
    }
    this.wanted.delete(threadId)
  }

  archive(threadId: string): void {
    void this.d.link.archiveThread(threadId).catch(() => undefined)
  }

  left(key: string): void {
    const found = this.d.conductors.threadOfKey(key)
    if (!found) return
    this.offTheSidebar.add(key)
    this.deleteIfUnused(tabThread(found.binding, found.thread))
  }

  forget(tabId: string): void {
    const t = this.byTab.get(tabId)
    this.byTab.delete(tabId)
    this.keyOfTab.delete(tabId)
    this.threadless.delete(tabId)
    if (t) this.deleteIfUnused(t)
  }

  private deleteIfUnused(t: TabThread): void {
    const keys = this.d.conductors.threadOfChannel(t.threadId)?.thread.keys ?? []
    if (keys.some((k) => !this.offTheSidebar.has(k))) return
    if ([...this.byTab.values()].some((held) => held.threadId === t.threadId)) return
    const b = this.d.conductors.binding(t.bindingId)
    if (!b) return
    this.d.link.deleteThread(b.channel.channelId, t.threadId).then(
      () => this.d.conductors.dropThread(t.threadId),
      (error: unknown) => {
        this.archive(t.threadId)
        this.d.deleteFailed(t.name ?? t.threadId, error)
      }
    )
  }
}
