import { GenIcon, type IconType } from 'react-icons'
import type { AgentAccountsUiOf, AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import './ui.css'

const AntigravityMark: IconType = GenIcon({
  tag: 'svg',
  attr: { viewBox: '0 0 24 24', fill: 'currentColor' },
  child: [
    {
      tag: 'path',
      attr: {
        d: 'M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z'
      },
      child: []
    }
  ]
})

const accounts = {
  emptyLine: `No ${agent.name} accounts yet — ${agent.name} sessions start only once there is one. Each account here is its own Google sign-in or Gemini API key. Every ${agent.name} session picks the least-used sign-in, and a Gemini API key only when every sign-in is at its limit.`,
  ownSettingRows: [],
  signIn: {
    button: 'Sign in with Google',
    buttonTitle: `Runs ${agent.signInCommand} in a terminal tab for a new ${agent.name} account`,
    pasteButton: 'Paste Gemini API key',
    inATab: true,
    hintEnd: `Sign in, then pick a colour scheme and answer Google’s Terms and data-use screen yourself, then type /exit. Your ${agent.name} conversations, rules, plugins and MCP servers are shared by every account.`
  },
  pasteForms: {
    'agy-home': {
      title: 'Add Gemini API key',
      placeholder: 'Gemini API key',
      hint: `The key goes into your Keychain and is handed to ${agent.command} when a session starts. Saving opens ${agent.command} in a terminal tab once: pick a colour scheme and answer Google’s Terms screen there, then type /exit, and the account is ready.`
    }
  },
  baseUrlPlaceholders: {}
} as const satisfies AgentAccountsUiOf<typeof agent>

export const ui: AgentUi = {
  id: agent.id,
  mark: AntigravityMark,
  accounts
}
