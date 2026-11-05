import { PROGRAM_STATUS_REPLY, ProgramStatusParser } from './programStatus'

export interface ClaudeDialogWatchDeps {
  watches(tabId: string): boolean
  reply(tabId: string, text: string): void
  closed(tabId: string): void
}

// CC§12 CC§14
export class ClaudeDialogWatch {
  private parsers = new Map<string, ProgramStatusParser | null>()
  private reporting = new Set<string>()
  private blocked = new Set<string>()

  constructor(private d: ClaudeDialogWatchDeps) {}

  data(tabId: string, chunk: string): void {
    let parser = this.parsers.get(tabId)
    if (parser === undefined) {
      parser = this.d.watches(tabId) ? new ProgramStatusParser() : null
      this.parsers.set(tabId, parser)
    }
    if (!parser) return
    const { asked, states } = parser.push(chunk)
    if (asked) {
      this.reporting.add(tabId)
      this.d.reply(tabId, PROGRAM_STATUS_REPLY)
    }
    for (const { state } of states) {
      if (state === 'blocked') this.blocked.add(tabId)
      else if (this.blocked.delete(tabId)) this.d.closed(tabId)
    }
  }

  showsDialogsClosing(tabId: string): boolean {
    return this.reporting.has(tabId)
  }

  forget(tabId: string): void {
    this.parsers.delete(tabId)
    this.reporting.delete(tabId)
    this.blocked.delete(tabId)
  }
}
