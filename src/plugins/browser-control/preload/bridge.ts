import type { PreloadIpc } from '@core/ipc'
import type {
  BrowserCdpAttached,
  BrowserCdpOp,
  BrowserCdpOpResult,
  BrowserStripTarget
} from '@shared/types'
import { CHANNELS } from '../shared/ipc'

export interface BrowserControlBridge {
  browserControl: {
    reportStrip(sessionId: string, targets: BrowserStripTarget[]): void
    onCdpOp(cb: (op: BrowserCdpOp) => void): () => void
    answerCdpOp(res: BrowserCdpOpResult): void
    onCdpAttached(cb: (a: BrowserCdpAttached) => void): () => void
  }
}

export const bridge = (ipc: PreloadIpc): BrowserControlBridge => ({
  browserControl: {
    reportStrip: (sessionId, targets) => ipc.send(CHANNELS.strip, sessionId, targets),
    onCdpOp: (cb) => ipc.listen(CHANNELS.cdpOp, cb),
    answerCdpOp: (res) => ipc.send(CHANNELS.cdpOpDone, res),
    onCdpAttached: (cb) => ipc.listen(CHANNELS.cdpAttached, cb)
  }
})
