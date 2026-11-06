import { PROGRAM_STATUS_REPLY, ProgramStatusParser } from './programStatus'

export type TerminalDialog = 'on-screen' | 'just-closed'

export interface ClaudeDialogWatchDeps {
  watchedProcess(tabId: string): object | undefined
  reply(tabId: string, text: string): void
  dialogDrawn(tabId: string): void
  closed(tabId: string, stateAfter: string): void
}

interface Watched {
  process: object
  parser: ProgramStatusParser
  reporting: boolean
  blocked?: { msg: string; kind?: string }
  closedAt?: number
}

const STATES_AFTER_A_DIALOG = new Set(['working', 'idle', 'done'])
// CC§12 CC§14
const DIALOG_KINDS = new Set(['permission', 'question'])
export const A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS = 5_000

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
      const was = w.blocked?.msg
      const next = state === 'blocked' ? (msg ?? '') : undefined
      const left =
        was !== undefined &&
        next !== was &&
        (next !== undefined || STATES_AFTER_A_DIALOG.has(state))
      const drawn = next !== undefined && next !== was
      w.blocked = next === undefined ? undefined : { msg: next, kind }
      if (left) {
        w.closedAt = Date.now()
        this.d.closed(tabId, state)
      }
      if (drawn && DIALOG_KINDS.has(kind ?? '')) this.d.dialogDrawn(tabId)
    }
  }

  showsDialogsClosing(tabId: string): boolean {
    return !!this.current(tabId)?.reporting
  }

  dialog(tabId: string): TerminalDialog | undefined {
    const w = this.current(tabId)
    if (!w) return undefined
    if (DIALOG_KINDS.has(w.blocked?.kind ?? '')) return 'on-screen'
    const since = w.closedAt === undefined ? Infinity : Date.now() - w.closedAt
    return since < A_HOOK_LINE_FIRED_BEFORE_THE_ANSWER_LANDS_WITHIN_MS ? 'just-closed' : undefined
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }

  private current(tabId: string): Watched | undefined {
    const w = this.tabs.get(tabId)
    return w?.process === this.d.watchedProcess(tabId) ? w : undefined
  }
}
