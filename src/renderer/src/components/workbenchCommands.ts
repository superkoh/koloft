import type { BrowserCommand } from '@shared/types'

type MenuCommand = Exclude<BrowserCommand, 'toggle-browser' | 'toggle-focus-mode'>

export type WorkbenchCommand =
  MenuCommand | 'find' | 'cycle-next' | 'cycle-prev' | 'find-files' | 'save' | 'escape'

export interface WorkbenchCommandSignal {
  id: WorkbenchCommand
  nonce: number
}

export type EscapeOutcome = 'consumed' | 'fell-through'
