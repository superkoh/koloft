// ADR-0054
import type { IconType } from 'react-icons'
import type { AgentId } from './registry'

export interface AgentUi {
  id: AgentId
  mark: IconType
}
