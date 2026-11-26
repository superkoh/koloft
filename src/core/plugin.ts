// ADR-0051
import type { AgentFlags, SmallJobKind } from './agent/manifest'
import type { HookMomentRule } from './hookMoments'

export const PLUGIN_FORMAT_VERSION = 2

export interface TextBlock {
  slot: string
  text: string
  when?: string
  whenAgentFlag?: keyof AgentFlags
}

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

export type UiEntry =
  | { place: Exclude<UiPlace, 'palette-item'>; id: string }
  | {
      place: 'palette-item'
      id: string
      label: string
      words: readonly string[]
      actsOnCurrent?: true
    }

export interface PluginAssistJob {
  id: string
  name: string
  does: string
  kind: SmallJobKind
}

export interface PluginSkill {
  name: string
  group: string
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
  slotsEachAgentFills?: readonly string[]
  slotsAnyAgentAddsTo?: readonly string[]
  skills?: readonly PluginSkill[]
  commands?: readonly PluginCommand[]
  channels?: readonly string[]
  moments?: PluginMoments
  settings?: PluginSettings
  ui?: readonly UiEntry[]
  hints?: readonly string[]
  assistJobs?: readonly PluginAssistJob[]
  mcpServers?: readonly PluginMcpServer[]
  hookMomentRules?: readonly HookMomentRule[]
}
