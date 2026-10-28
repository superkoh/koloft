import type { WebContents } from 'electron'

const holders = new Map<number, number>()
const ownSessions = new Set<string>()
const ownSessionsOpening = new Set<string>()

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

// PLATFORM§16
export async function openOwnSession(wc: WebContents, targetId: string): Promise<string> {
  ownSessionsOpening.add(targetId)
  try {
    const { sessionId } = (await wc.debugger.sendCommand('Target.attachToTarget', {
      targetId,
      flatten: true
    })) as { sessionId: string }
    ownSessions.add(sessionId)
    return sessionId
  } finally {
    ownSessionsOpening.delete(targetId)
  }
}

export function hiddenFromClients(method: string, params: unknown, sessionId?: string): boolean {
  if (sessionId && ownSessions.has(sessionId)) return true
  if (method !== 'Target.attachedToTarget' && method !== 'Target.detachedFromTarget') return false
  const p = (params ?? {}) as { sessionId?: string; targetInfo?: { targetId?: string } }
  return (
    (!!p.sessionId && ownSessions.has(p.sessionId)) ||
    ownSessionsOpening.has(p.targetInfo?.targetId ?? '')
  )
}
