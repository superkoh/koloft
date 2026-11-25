import { BsOpenai } from 'react-icons/bs'
import type { AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import { usage } from './usage'
import './ui.css'

export const ui: AgentUi = {
  id: agent.id,
  mark: BsOpenai,
  usage
}
