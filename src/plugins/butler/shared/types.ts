import type { OwnPick } from '@shared/types'

export interface InstructionsVersion {
  text: string
  at: number
  by: string
}

export interface ButlerSetting {
  name: string
  formerNames: string[]
  instructions?: InstructionsVersion[]
}

export const DEFAULT_BUTLER_NAME = 'Alfred'

export interface ButlerSession {
  sessionIds: string[]
  lastSessionKey?: string
  knowsTodo?: string[]
  // CC§3 CODEX§11
  carried?: OwnPick
}
