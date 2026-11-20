import type { OwnPick } from '@shared/types'
import type { InstructionsVersion } from '@core/ownerInstructions'

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
  on: () => boolean
}

export type PluginsOn = Readonly<Record<string, boolean>>

export interface PluginsSeen {
  key: string
  on: PluginsOn
}

export interface ButlerSession {
  sessionIds: string[]
  lastSessionKey?: string
  pluginsSeen?: PluginsSeen
  [knownBy: KnownBy]: string[] | undefined
  // CC§3 CODEX§11
  carried?: OwnPick
}
