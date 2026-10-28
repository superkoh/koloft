import type { WebContents } from 'electron'

const holders = new Map<number, number>()
const ownSessions = new Set<string>()
const ownTargetsOpening = new Set<string>()

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

function sendOn(wc: WebContents, parent: string, method: string, params: object): Promise<unknown> {
  return parent
    ? wc.debugger.sendCommand(method, params, parent)
    : wc.debugger.sendCommand(method, params)
}

// PLATFORM§16
export async function openOwnSession(
  wc: WebContents,
  targetId: string,
  parent = ''
): Promise<string> {
  if (!parent) ownTargetsOpening.add(targetId)
  try {
    const { sessionId } = (await sendOn(wc, parent, 'Target.attachToTarget', {
      targetId,
      flatten: true
    })) as { sessionId: string }
    ownSessions.add(sessionId)
    return sessionId
  } finally {
    ownTargetsOpening.delete(targetId)
  }
}

// PLATFORM§16
export async function closeOwnSession(
  wc: WebContents,
  sessionId: string,
  parent = ''
): Promise<void> {
  const forget = (): void => {
    wc.debugger.off('message', onMessage)
    setTimeout(() => ownSessions.delete(sessionId), 0)
  }
  const onMessage = (_e: unknown, method: string, params: { sessionId?: string }): void => {
    if (method === 'Target.detachedFromTarget' && params.sessionId === sessionId) forget()
  }
  if (!parent) wc.debugger.on('message', onMessage as never)
  try {
    await sendOn(wc, parent, 'Target.detachFromTarget', { sessionId })
    if (parent) forget()
  } catch {
    forget()
  }
}

export function hiddenFromClients(method: string, params: unknown, sessionId?: string): boolean {
  if (sessionId && ownSessions.has(sessionId)) return true
  if (method !== 'Target.attachedToTarget' && method !== 'Target.detachedFromTarget') return false
  const p = (params ?? {}) as { sessionId?: string; targetInfo?: { targetId?: string } }
  return (
    (!!p.sessionId && ownSessions.has(p.sessionId)) ||
    ownTargetsOpening.has(p.targetInfo?.targetId ?? '')
  )
}
