// ADR-0054
import type { IconType } from 'react-icons'
import type { AgentId } from './registry'
import type { AgentUsageUi } from './usageShape'

export interface AgentUi {
  id: AgentId
  mark: IconType
  usage: AgentUsageUi
}
