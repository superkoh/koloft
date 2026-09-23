export interface HookReport {
  event?: string
  source?: string
  sessionId?: string
  tmux?: string
}

// CC§5
export function ownsHookReport(report: HookReport, boundSessionId: string | undefined): boolean {
  // CC§1
  if (report.event === 'start') {
    if (report.source === 'fork') return false
    if (report.source === 'clear' || report.source === 'resume' || report.source === 'startup') {
      return true
    }
  }
  if (!report.sessionId || !boundSessionId) return true
  return report.sessionId === boundSessionId
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
