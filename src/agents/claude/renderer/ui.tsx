import { BsClaude } from 'react-icons/bs'
import type { AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import './ui.css'

export const ui: AgentUi = {
  id: agent.id,
  mark: BsClaude,
  welcome: {
    howItSignsIn:
      'Your browser opens once. Koloft keeps the account: no terminal, nothing to paste.',
    // CC§9 CC§14
    whatItsSessionsAsk: {
      asks: 'Claude Code asks only about risky steps (its auto mode). Press Shift+Tab in a session to be asked every step.',
      askInstead: 'Ask about risky steps instead'
    }
  },
  settings: {
    whatItRunsOn: 'a Claude account'
  }
}
