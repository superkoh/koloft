import { PROGRAM_STATUS_REPLY, ProgramStatusParser } from './programStatus'

export interface ClaudeDialogWatchDeps {
  watchedProcess(tabId: string): object | undefined
  reply(tabId: string, text: string): void
  permissionDrawn(tabId: string): void
  closed(tabId: string, stateAfter: string): void
}

interface Watched {
  process: object
  parser: ProgramStatusParser
  reporting: boolean
  blocked?: string
  permission?: boolean
}

const STATES_AFTER_A_DIALOG = new Set(['working', 'idle', 'done'])

// CC§12 CC§14
export class ClaudeDialogWatch {
  private tabs = new Map<string, Watched>()

  constructor(private d: ClaudeDialogWatchDeps) {}

  data(tabId: string, chunk: string): void {
    const process = this.d.watchedProcess(tabId)
    if (!process) return
    let w = this.tabs.get(tabId)
    if (w?.process !== process) {
      w = { process, parser: new ProgramStatusParser(), reporting: false }
      this.tabs.set(tabId, w)
    }
    const { asked, states } = w.parser.push(chunk)
    if (asked) this.d.reply(tabId, PROGRAM_STATUS_REPLY)
    for (const { state, kind, msg } of states) {
      w.reporting = true
      const next = state === 'blocked' ? (msg ?? '') : undefined
      const left =
        w.blocked !== undefined &&
        next !== w.blocked &&
        (next !== undefined || STATES_AFTER_A_DIALOG.has(state))
      const drawn = next !== undefined && next !== w.blocked
      w.blocked = next
      w.permission = next !== undefined && kind === 'permission'
      if (left) this.d.closed(tabId, state)
      if (drawn && kind === 'permission') this.d.permissionDrawn(tabId)
    }
  }

  showsDialogsClosing(tabId: string): boolean {
    const w = this.tabs.get(tabId)
    return !!w?.reporting && w.process === this.d.watchedProcess(tabId)
  }

  showsPermission(tabId: string): boolean {
    const w = this.tabs.get(tabId)
    return !!w?.permission && w.process === this.d.watchedProcess(tabId)
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }
}
