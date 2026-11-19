// ADR-0051
import type { BackendId } from '@shared/types'
import { SESSION_BACKENDS, byBackend } from '@shared/sessionBackend'
import type { ModelAndEffort } from './assistModels'

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
}

export interface PluginMoments {
  announces?: readonly string[]
  listens?: readonly string[]
}

export interface SettingsPage {
  label: string
  words: readonly string[]
}

export interface PluginSettings {
  page?: SettingsPage
  keys: readonly string[]
}

export type UiPlace =
  | 'sidebar-head'
  | 'sidebar-row'
  | 'sidebar-foot'
  | 'centre-page'
  | 'below-terminal'
  | 'dialog'
  | 'palette-item'
  | 'settings-page'

export interface UiEntry {
  place: UiPlace
  id: string
}

export interface PluginAssistJob {
  id: string
  name: string
  does: string
  defaults: Record<BackendId, ModelAndEffort>
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
  does: string
  mandatory: boolean
  needs: readonly string[]
  offUntilSetUp?: string
  text?: readonly TextBlock[]
  skills?: readonly string[]
  commands?: readonly PluginCommand[]
  channels?: readonly string[]
  moments?: PluginMoments
  settings?: PluginSettings
  ui?: readonly UiEntry[]
  hints?: readonly string[]
  assistJobs?: readonly PluginAssistJob[]
  mcpServers?: readonly PluginMcpServer[]
}
