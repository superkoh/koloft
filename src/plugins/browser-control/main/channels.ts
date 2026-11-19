import type { MainIpc } from '@core/ipc'
import type { BrowserStripTarget } from '@shared/types'
import { CHANNELS } from '../shared/ipc'
import type { CdpOps } from './cdpOps'

export interface ChannelDeps {
  cdpOps: Pick<CdpOps, 'done'>
  stripChanged(sessionId: string, targets: BrowserStripTarget[]): void
}

export function registerChannels(ipc: MainIpc, deps: ChannelDeps): void {
  ipc.on(CHANNELS.cdpOpDone, (res: unknown) => deps.cdpOps.done(res))
  ipc.on(CHANNELS.strip, (sessionId: unknown, targets: unknown) => {
    if (typeof sessionId !== 'string' || !Array.isArray(targets)) return
    deps.stripChanged(sessionId, targets as BrowserStripTarget[])
  })
}
