// ADR-0054
import type { IconType } from 'react-icons'
import type { AgentId } from './registry'

export interface WhatItsSessionsAsk {
  asks: string
  askInstead: string
}

export interface AgentWelcomeWords {
  howItSignsIn: string
  whatItsSessionsAsk: WhatItsSessionsAsk
}

export interface AgentSettingsWords {
  whatItRunsOn: string
}

export interface AgentUi {
  id: AgentId
  mark: IconType
  welcome: AgentWelcomeWords
  settings: AgentSettingsWords
}
