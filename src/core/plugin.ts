// ADR-0051
import type { BackendId } from '@shared/types'

export const PLUGIN_FORMAT_VERSION = 1

export type TextReader = 'butler' | 'helper' | 'session' | 'skill'

export interface TextVariants {
  byAgent?: Partial<Record<BackendId, string>>
  byModel?: Readonly<Record<string, string>>
}

export interface TextBlock {
  reader: TextReader
  slot: string
  text: string
  variants?: TextVariants
}

export interface PluginCommand {
  verb: string
  summary: string
}

export interface PluginMoments {
  announces?: readonly string[]
  listens?: readonly string[]
}

export interface PluginSettings {
  page: string
  keys: readonly string[]
}

export type UiPlace = 'sidebar-row' | 'centre-page' | 'dialog' | 'palette-item'

export interface UiEntry {
  place: UiPlace
  id: string
}

export interface PluginAssistJob {
  id: string
  name: string
}

export interface PluginMcpServer {
  name: string
  command: string
  args: readonly string[]
}

export interface PluginManifest {
  formatVersion: typeof PLUGIN_FORMAT_VERSION
  id: string
  name: string
  mandatory: boolean
  needs: readonly string[]
  text?: readonly TextBlock[]
  skills?: readonly string[]
  commands?: readonly PluginCommand[]
  channels?: readonly string[]
  moments?: PluginMoments
  settings?: PluginSettings
  ui?: readonly UiEntry[]
  assistJobs?: readonly PluginAssistJob[]
  mcp?: PluginMcpServer
}
