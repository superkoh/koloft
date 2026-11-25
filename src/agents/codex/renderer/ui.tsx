import { BsOpenai } from 'react-icons/bs'
import type { AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import './ui.css'

export const ui: AgentUi = {
  id: agent.id,
  mark: BsOpenai,
  welcome: {
    howItSignsIn:
      'A terminal tab opens and Codex sends you to your browser. It closes by itself once you are in.',
    // CODEX§11
    whatItsSessionsAsk: {
      asks: 'Codex asks only about some steps, like one that leaves its sandbox.',
      askInstead: 'Ask about some steps instead'
    }
  },
  settings: {
    whatItRunsOn: 'a Codex account'
  }
}
