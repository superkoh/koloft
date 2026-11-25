import type { AccountView } from '@shared/types'

export type Closeness = '' | 'warn' | 'bad'

export interface UsageLine {
  text: string
  spoken: string
  tone: 'faint' | 'amber' | 'red'
}

export interface UsageColumn {
  id: string
  label: string
}

export interface UsageBar {
  column: string
  label: string
  used: number | null
  closeness: Closeness
  under: UsageLine
}

export interface UsageBadge {
  means: 'apiKey' | 'endpoint' | 'planIncludes' | 'planLacks'
  text: string
  title: string | null
}

export type UsageText = readonly string[]

export interface UsageAction {
  id: string
  offered: boolean
  label: string
  ask: { before: UsageText; name: string; after: string }
  go: string
  going: string
  outcomes: Readonly<Record<string, string | null>>
}

export interface UsageBody {
  instead: UsageText | null
  after: UsageText[]
}

export interface PillLayers {
  used: number
  second: { used: number; spent: boolean } | null
}

export interface UsageAccount {
  metered: boolean
  badges: UsageBadge[]
  walled: boolean
  ageShownFrom: number | null
  pill: PillLayers | null
  bars: UsageBar[]
  pane: UsageBody
  topBar: UsageBody
  failureBesideBars: string | null
  action: UsageAction | null
}

export interface UsageTotalCell {
  used: number
  closeness: Closeness
}

export interface UsageTotal extends PillLayers {
  measured: number
  usable: number
  walled: number
  cells: (UsageTotalCell | null)[]
  earliestBack: number | null
  oldestAt: number | null
}

export interface UsageGroup {
  columns: UsageColumn[]
  rows: readonly AccountView[]
  total: UsageTotal | null
  spoken: string
  fallbackBarLit: boolean
  pillBarsGrouped: boolean
}

export interface AgentUsageUi {
  account(a: AccountView, nowMs: number): UsageAccount
  group(accounts: readonly AccountView[], nowMs: number): UsageGroup
}
