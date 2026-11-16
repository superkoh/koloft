// ADR-0051
import type { BackendId } from '@shared/types'
import { SESSION_BACKENDS, byBackend } from '@shared/sessionBackend'

export const PLUGIN_FORMAT_VERSION = 1

export interface TextBlock {
  slot: string
  text: string
  byAgent?: Partial<Record<BackendId, string>>
  byModel?: Readonly<Record<string, string>>
  when?: string
}

export const eachAgent = (slot: string, textOf: (agent: BackendId) => string): TextBlock => ({
  slot,
  text: textOf(SESSION_BACKENDS[0]),
  byAgent: byBackend(textOf)
})

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
  mcpServers?: readonly PluginMcpServer[]
}
