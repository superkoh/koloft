import { PROGRAM_STATUS_REPLY, ProgramStatusParser } from './programStatus'

export interface ClaudeDialogWatchDeps {
  watchedProcess(tabId: string): object | undefined
  reply(tabId: string, text: string): void
  dialogShown(tabId: string, onScreen: boolean): void
  closed(tabId: string, stateAfter: string): void
}

interface Watched {
  process: object
  parser: ProgramStatusParser
  reporting: boolean
  blocked?: string
  dialog: boolean
  dialogLeftAt?: number
}

const STATES_AFTER_A_DIALOG = new Set(['working', 'idle', 'done'])
// CC§12 CC§14
const DIALOG_KINDS = new Set(['permission', 'question'])
export const A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS = 10_000

// CC§12 CC§14
export class ClaudeDialogWatch {
  private tabs = new Map<string, Watched>()

  constructor(private d: ClaudeDialogWatchDeps) {}

  data(tabId: string, chunk: string): void {
    const process = this.d.watchedProcess(tabId)
    if (!process) return
    let w = this.tabs.get(tabId)
    if (w?.process !== process) {
      if (w?.dialog) this.d.dialogShown(tabId, false)
      w = { process, parser: new ProgramStatusParser(), reporting: false, dialog: false }
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
      const dialog = next !== undefined && DIALOG_KINDS.has(kind ?? '')
      if (w.dialog && (left || !dialog)) w.dialogLeftAt = Date.now()
      w.blocked = next
      if (dialog !== w.dialog) {
        w.dialog = dialog
        this.d.dialogShown(tabId, dialog)
      }
      if (left) this.d.closed(tabId, state)
    }
  }

  showsDialogsClosing(tabId: string): boolean {
    return !!this.current(tabId)?.reporting
  }

  justClosedADialog(tabId: string): boolean {
    const w = this.current(tabId)
    if (!w || w.dialog || w.dialogLeftAt === undefined) return false
    return Date.now() - w.dialogLeftAt < A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS
  }

  forget(tabId: string): void {
    if (this.tabs.get(tabId)?.dialog) this.d.dialogShown(tabId, false)
    this.tabs.delete(tabId)
  }

  private current(tabId: string): Watched | undefined {
    const w = this.tabs.get(tabId)
    return w?.process === this.d.watchedProcess(tabId) ? w : undefined
  }
}
