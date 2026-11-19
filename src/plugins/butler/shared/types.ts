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

export type KnownBy = `knows${string}`

export const isKnownBy = (key: string): key is KnownBy => key.startsWith('knows')

export interface OldConversationNews {
  knownBy: KnownBy
  text: string
}

export interface ButlerSession {
  sessionIds: string[]
  lastSessionKey?: string
  [knownBy: KnownBy]: string[] | undefined
  // CC§3 CODEX§11
  carried?: OwnPick
}
