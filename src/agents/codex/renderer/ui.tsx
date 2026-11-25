import { BsOpenai } from 'react-icons/bs'
import type { AgentAccountsUiOf, AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import './ui.css'

const accounts = {
  emptyLine: `No ${agent.name} accounts yet — ${agent.name} sessions start only once there is one. Each account here is its own ${agent.name} sign-in or API key. Every ${agent.name} session picks the least-used sign-in, and an API key only when every sign-in is at its limit.`,
  ownSettingRows: [],
  signIn: {
    button: `Sign in to ${agent.name}`,
    buttonTitle: `Runs ${agent.signInCommand} in a terminal tab for a new ${agent.name} account`,
    pasteButton: 'Paste API key',
    inATab: true,
    hintEnd: `Your ${agent.name} settings and trusted folders are shared by every account.`
  },
  pasteForms: {
    'codex-home': {
      title: 'Add OpenAI API key',
      placeholder: 'sk-proj-… (OpenAI API key)',
      hint: `Koloft hands the key to ${agent.signInCommand}, which keeps it in this account’s own sign-in folder; Koloft itself never echoes or stores it. ${agent.name} does not check the key here: a wrong one shows as signed in and fails at the first message a session sends.`
    }
  },
  baseUrlPlaceholders: {}
} as const satisfies AgentAccountsUiOf<typeof agent>

export const ui: AgentUi = {
  id: agent.id,
  mark: BsOpenai,
  accounts,
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
