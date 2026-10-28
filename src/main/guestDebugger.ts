import type { WebContents } from 'electron'

const holders = new Map<number, number>()

// PLATFORM§16
export function holdDebugger(wc: WebContents): () => void {
  const id = wc.id
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  holders.set(id, (holders.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holders.get(id) ?? 1) - 1
    if (left > 0) {
      holders.set(id, left)
      return
    }
    holders.delete(id)
    try {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    } catch {}
  }
}
