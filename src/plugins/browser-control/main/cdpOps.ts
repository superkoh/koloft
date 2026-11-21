import crypto from 'crypto'
import type { BrowserCdpAttached, BrowserCdpOp, BrowserCdpOpResult } from '@shared/types'
import { CDP_OP_BUDGET_MS } from '@shared/cdpBudget'
import { CHANNELS } from '../shared/ipc'
import {
  guestDrivenFromAnotherMachine,
  openForMachine,
  sessionDrivingGuest,
  type RelayDeps
} from './cdpRelay'

export interface CdpOpsDeps extends Pick<
  RelayDeps,
  'sessionForTab' | 'anotherLiveKoloftOwns' | 'cameThroughAForward'
> {
  push(channel: string, ...args: unknown[]): boolean
}

export class CdpOps {
  private pending = new Map<string, (res: BrowserCdpOpResult) => void>()
  readonly relay: RelayDeps

  constructor(private d: CdpOpsDeps) {
    this.relay = {
      anotherLiveKoloftOwns: d.anotherLiveKoloftOwns,
      sessionForTab: d.sessionForTab,
      mount: async (sessionId, targetId) => {
        const r = await this.op('mount', sessionId, { targetId })
        if (!r.ok || typeof r.guestId !== 'number')
          throw new Error(r.error ?? 'could not open that tab')
        return r.guestId
      },
      create: async (sessionId, url) => {
        const r = await this.op('create', sessionId, { url })
        if (!r.ok || !r.targetId || typeof r.guestId !== 'number') {
          throw new Error(r.error ?? 'could not create a tab')
        }
        return { targetId: r.targetId, url, title: '', guestId: r.guestId }
      },
      close: async (sessionId, targetId) => {
        await this.op('close', sessionId, { targetId })
      },
      stage: async (sessionId, targetId) => {
        await this.op('stage', sessionId, { targetId })
      },
      setAttached: (sessionId, targetIds) => {
        const payload: BrowserCdpAttached = { sessionId, targetIds }
        d.push(CHANNELS.cdpAttached, payload)
      },
      cameThroughAForward: d.cameThroughAForward
    }
  }

  op(
    kind: BrowserCdpOp['kind'],
    sessionId: string,
    extra: { targetId?: string; url?: string } = {}
  ): Promise<BrowserCdpOpResult> {
    const opId = crypto.randomUUID()
    return new Promise<BrowserCdpOpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(opId)
        resolve({ opId, ok: false, error: 'the Koloft window did not answer' })
      }, CDP_OP_BUDGET_MS)
      this.pending.set(opId, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      const payload: BrowserCdpOp = { opId, kind, sessionId, ...extra }
      this.d.push(CHANNELS.cdpOp, payload)
    })
  }

  done(res: unknown): void {
    const r = res as BrowserCdpOpResult
    if (!r || typeof r.opId !== 'string') return
    const pending = this.pending.get(r.opId)
    if (!pending) return
    this.pending.delete(r.opId)
    pending(r)
  }

  openAsDrivingAgentsTab(guestId: number, url: string): boolean {
    const driver = sessionDrivingGuest(guestId)
    if (guestDrivenFromAnotherMachine(guestId)) {
      if (driver) void openForMachine(driver, url, this.relay.create).catch(() => {})
      return true
    }
    if (driver) void this.op('create', driver, { url })
    return driver !== null
  }
}
