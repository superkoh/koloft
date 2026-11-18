import type { OwnPick } from '@shared/types'

export interface ButlerSetting {
  name: string
  formerNames: string[]
}

export const DEFAULT_BUTLER_NAME = 'Alfred'

export interface ButlerSession {
  sessionIds: string[]
  lastSessionKey?: string
  knowsTodo?: string[]
  // CC§3 CODEX§11
  carried?: OwnPick
}
