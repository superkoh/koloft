export interface HookReport {
  event?: string
  source?: string
  sessionId?: string
  tmux?: string
}

export const MOVED_CONVERSATION_SOURCE = 'moved'

export function replacesTheConversation(source: string): boolean {
  return source === 'clear' || source === MOVED_CONVERSATION_SOURCE
}

// CC§5
export function ownsHookReport(report: HookReport, boundSessionId: string | undefined): boolean {
  // CC§1
  if (report.event === 'start') {
    if (report.source === 'fork') return false
    if (
      report.source === 'clear' ||
      report.source === 'resume' ||
      report.source === 'startup' ||
      report.source === MOVED_CONVERSATION_SOURCE
    ) {
      return true
    }
  }
  if (!report.sessionId || !boundSessionId) return true
  return report.sessionId === boundSessionId
}

export function continuedInOf(transcriptTail: string): string | undefined {
  const last = transcriptTail.trimEnd().split('\n').pop()
  if (!last || !last.includes('"continued-in"')) return undefined
  try {
    const record = JSON.parse(last) as { type?: unknown; continuedInSessionId?: unknown }
    if (record.type !== 'continued-in' || typeof record.continuedInSessionId !== 'string') {
      return undefined
    }
    return record.continuedInSessionId
  } catch {
    return undefined
  }
}

// CC§5
export function conversationMovedTo(
  reportedSessionId: string | undefined,
  boundSessionId: string | undefined,
  bound: { exists: boolean; continuedIn?: string },
  reportedTranscriptExists: boolean
): boolean {
  if (!reportedSessionId || !boundSessionId || reportedSessionId === boundSessionId) return false
  if (!reportedTranscriptExists) return false
  return bound.continuedIn === reportedSessionId || !bound.exists
}

// PLATFORM§34
export function makeDropDedupe(): (key: string, text: string) => boolean {
  const last = new Map<string, string>()
  return (key, text) => {
    if (last.get(key) === text) return false
    last.set(key, text)
    return true
  }
}
