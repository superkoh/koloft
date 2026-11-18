import type { BrowserStripTarget } from '@shared/types'

export type RelayTarget = BrowserStripTarget

export interface RelayBackend {
  targets(): RelayTarget[]
  mount(targetId: string): Promise<number>
  create(url: string): Promise<RelayTarget>
  close(targetId: string): Promise<void>
  attachGuest(targetId: string, guestId: number): Promise<void>
  detachGuest(targetId: string): void
  forward(
    targetId: string,
    guestId: number,
    method: string,
    params: unknown,
    sessionId?: string
  ): Promise<unknown>
  version(): { product: string; userAgent: string; revision: string; jsVersion: string }
}

// PLATFORM§17
export const RELAY_CONTEXT_ID = 'KOLOFT-BROWSER-CONTEXT'
// PLATFORM§17
export const SET_AUTO_ATTACH_REPLY_MS = 20_000

function raceBudget(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    void work.then(finish, finish)
  })
}

export const RELAY_BROWSER_TARGET_ID = 'KOLOFT-BROWSER'

interface Incoming {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface StripDiff {
  created: RelayTarget[]
  changed: RelayTarget[]
  destroyed: string[]
}

export function stripDiff(before: RelayTarget[], next: RelayTarget[]): StripDiff {
  const was = new Map(before.map((t) => [t.targetId, t]))
  const now = new Set(next.map((t) => t.targetId))
  const created: RelayTarget[] = []
  const changed: RelayTarget[] = []
  for (const t of next) {
    const prev = was.get(t.targetId)
    if (!prev) created.push(t)
    else if (prev.url !== t.url || prev.title !== t.title) changed.push(t)
  }
  return {
    created,
    changed,
    destroyed: before.filter((t) => !now.has(t.targetId)).map((t) => t.targetId)
  }
}

function targetInfo(t: RelayTarget, attached: boolean): Record<string, unknown> {
  return {
    targetId: t.targetId,
    // PLATFORM§17
    type: 'page',
    title: t.title,
    url: t.url,
    attached,
    browserContextId: RELAY_CONTEXT_ID
  }
}

export class CdpProtocol {
  private readonly sessions = new Map<string, string>()
  private readonly owners = new Map<string, string>()
  private readonly attaching = new Map<string, Promise<string>>()
  private readonly destroyCountsNeverPruned = new Map<string, number>()
  private autoAttach = false
  private discovering = false
  private nextSession = 1

  constructor(
    private readonly send: (msg: Record<string, unknown>) => void,
    private readonly backend: RelayBackend
  ) {}

  async handle(raw: string): Promise<void> {
    let msg: Incoming
    try {
      msg = JSON.parse(raw) as Incoming
    } catch {
      return
    }
    const { id, method, sessionId } = msg
    const params = msg.params ?? {}
    if (typeof id !== 'number' || typeof method !== 'string') return
    if (sessionId) {
      void this.onSessionCommand(sessionId, method, params).then(
        (result) => this.reply(id, result, sessionId),
        (e) => this.fail(id, e instanceof Error ? e.message : String(e), sessionId)
      )
      return
    }
    try {
      this.reply(id, await this.onBrowserCommand(method, params))
    } catch (e) {
      this.fail(id, e instanceof Error ? e.message : String(e))
    }
  }

  private async onBrowserCommand(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case 'Browser.getVersion': {
        const v = this.backend.version()
        return {
          protocolVersion: '1.3',
          product: v.product,
          revision: v.revision,
          userAgent: v.userAgent,
          jsVersion: v.jsVersion
        }
      }
      case 'Browser.setDownloadBehavior':
      case 'Browser.close':
        return {}
      case 'Target.getBrowserContexts':
        return { browserContextIds: [RELAY_CONTEXT_ID] }
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext':
        throw new Error('Target.createBrowserContext is not supported by the Koloft relay')
      case 'Target.getTargets':
        return { targetInfos: this.backend.targets().map((t) => targetInfo(t, this.attached(t))) }
      // PLATFORM§17
      case 'Target.getTargetInfo':
        return {
          targetInfo: {
            targetId: RELAY_BROWSER_TARGET_ID,
            type: 'browser',
            title: 'Koloft',
            url: '',
            attached: true
          }
        }
      case 'Target.setDiscoverTargets': {
        this.discovering = params.discover !== false
        if (this.discovering) {
          for (const t of this.backend.targets()) this.emitCreated(t)
        }
        return {}
      }
      case 'Target.setAutoAttach': {
        this.autoAttach = params.autoAttach !== false
        if (this.autoAttach) {
          const targets = this.backend.targets()
          const all = (async (): Promise<void> => {
            for (const t of targets) await this.tryAttach(t)
          })()
          await raceBudget(all, SET_AUTO_ATTACH_REPLY_MS)
        }
        return {}
      }
      case 'Target.attachToTarget': {
        const t = this.find(String(params.targetId ?? ''))
        return { sessionId: await this.attach(t) }
      }
      case 'Target.detachFromTarget': {
        const sid = String(params.sessionId ?? '')
        const owner = this.owners.get(sid)
        if (owner) this.detach(owner, 'Target.detachFromTarget')
        return {}
      }
      // PLATFORM§16
      case 'Target.createTarget': {
        const t = await this.backend.create(String(params.url ?? 'about:blank'))
        this.emitCreated(t)
        if (this.autoAttach) await this.tryAttach(t)
        return { targetId: t.targetId }
      }
      case 'Target.closeTarget': {
        const t = this.find(String(params.targetId ?? ''))
        await this.backend.close(t.targetId)
        return { success: true }
      }
      default:
        throw new Error(`'${method}' is not supported by the Koloft relay`)
    }
  }

  private async onSessionCommand(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const targetId = this.owners.get(sessionId)
    if (!targetId) throw new Error(`no session ${sessionId}`)
    if (method === 'Page.bringToFront') return {}
    const guestId = this.guestFor(targetId)
    const sub = this.sessions.get(targetId) === sessionId ? undefined : sessionId
    return await this.backend.forward(targetId, guestId, method, params, sub)
  }

  async targetCreated(t: RelayTarget): Promise<void> {
    this.emitCreated(t)
    // PLATFORM§16
    if (this.autoAttach) await this.tryAttach(t)
  }

  targetDestroyed(targetId: string): void {
    this.gone(targetId)
    this.detach(targetId, 'Target.targetDestroyed')
    this.send({ method: 'Target.targetDestroyed', params: { targetId } })
  }

  targetInfoChanged(t: RelayTarget): void {
    this.send({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: targetInfo(t, this.attached(t)) }
    })
  }

  fromGuest(targetId: string, method: string, params: unknown, sessionId?: string): void {
    const own = this.sessions.get(targetId)
    if (!own) return
    if (method === 'Target.attachedToTarget') {
      const child = (params as { sessionId?: unknown } | null)?.sessionId
      if (typeof child === 'string' && child) this.owners.set(child, targetId)
    }
    if (sessionId && !this.owners.has(sessionId)) this.owners.set(sessionId, targetId)
    // PLATFORM§16
    this.send({ method, params: params ?? {}, sessionId: sessionId || own })
  }

  forceDetach(targetId: string, reason: string): void {
    this.detach(targetId, reason)
  }

  private find(targetId: string): RelayTarget {
    const t = this.backend.targets().find((x) => x.targetId === targetId)
    if (!t) throw new Error(`no target ${targetId}`)
    return t
  }

  private attached(t: RelayTarget): boolean {
    return this.sessions.has(t.targetId)
  }

  private guestFor(targetId: string): number {
    const guestId = this.find(targetId).guestId
    if (guestId === null) throw new Error(`target ${targetId} has no live page`)
    return guestId
  }

  private emitCreated(t: RelayTarget): void {
    if (!this.discovering) return
    this.send({
      method: 'Target.targetCreated',
      params: { targetInfo: targetInfo(t, this.attached(t)) }
    })
  }

  // PLATFORM§17
  private async tryAttach(t: RelayTarget): Promise<void> {
    try {
      await this.attach(t)
    } catch {}
  }

  private async attach(t: RelayTarget): Promise<string> {
    const existing = this.sessions.get(t.targetId)
    if (existing) return existing
    // PLATFORM§17
    const already = this.attaching.get(t.targetId)
    if (already) return await already
    const pending = this.doAttach(t)
    this.attaching.set(t.targetId, pending)
    try {
      return await pending
    } finally {
      this.attaching.delete(t.targetId)
    }
  }

  private gone(targetId: string): void {
    this.destroyCountsNeverPruned.set(
      targetId,
      (this.destroyCountsNeverPruned.get(targetId) ?? 0) + 1
    )
  }

  private async doAttach(t: RelayTarget): Promise<string> {
    const era = this.destroyCountsNeverPruned.get(t.targetId) ?? 0
    const lost = (): boolean => (this.destroyCountsNeverPruned.get(t.targetId) ?? 0) !== era
    const abandon = (): never => {
      this.backend.detachGuest(t.targetId)
      throw new Error(`target ${t.targetId} was closed while attaching`)
    }
    const guestId = await this.backend.mount(t.targetId)
    if (lost()) abandon()
    await this.backend.attachGuest(t.targetId, guestId)
    if (lost()) abandon()
    const sessionId = `KOLOFT-${this.nextSession++}`
    this.sessions.set(t.targetId, sessionId)
    this.owners.set(sessionId, t.targetId)
    this.send({
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: targetInfo({ ...t, guestId }, true),
        waitingForDebugger: false
      }
    })
    return sessionId
  }

  private detach(targetId: string, reason: string): void {
    const sessionId = this.sessions.get(targetId)
    if (!sessionId) return
    this.sessions.delete(targetId)
    for (const [sid, owner] of this.owners) if (owner === targetId) this.owners.delete(sid)
    this.backend.detachGuest(targetId)
    this.send({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId, reason }
    })
  }

  private reply(id: number, result: unknown, sessionId?: string): void {
    this.send(sessionId ? { id, sessionId, result } : { id, result })
  }

  private fail(id: number, message: string, sessionId?: string): void {
    const error = { code: -32000, message }
    this.send(sessionId ? { id, sessionId, error } : { id, error })
  }
}
