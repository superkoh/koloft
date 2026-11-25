import { BsClaude } from 'react-icons/bs'
import type { AgentAccountsUiOf, AgentUi } from '@core/agent/agentUi'
import { agent } from '../agent'
import { usage } from './usage'
import './ui.css'

const VERIFIED_IN_THE_KEYCHAIN =
  'What you paste is used only to verify and to write the Keychain entry — never echoed, never written to a file. A failed check still saves the account, marked UNVERIFIED.'

const accounts = {
  emptyLine: `No accounts yet — add one below. ${agent.name} sessions start only once there is one.`,
  ownSettingRows: [
    {
      setting: 'fablePriority',
      title: 'Prefer accounts with fable allowance',
      note: 'Off, accounts are picked by weekly use alone, skipping any near its 5-hour limit — use that when fable is nearly spent and one account is taking every session.'
    }
  ],
  signIn: {
    button: 'Sign in',
    buttonTitle: `Runs ${agent.signInCommand} in the background and stores the token for you`,
    pasteButton: 'Paste token',
    inATab: false
  },
  pasteForms: {
    oauth: {
      title: 'Paste token',
      placeholder: `sk-ant-oat01-… (from ${agent.signInCommand})`,
      hint: VERIFIED_IN_THE_KEYCHAIN
    },
    apikey: { title: 'Add API key', placeholder: 'sk-ant-api03-…', hint: VERIFIED_IN_THE_KEYCHAIN },
    custom: {
      title: 'Add custom endpoint',
      placeholder: 'Key issued by that endpoint',
      hint: VERIFIED_IN_THE_KEYCHAIN
    }
  },
  baseUrlPlaceholders: { custom: 'Base URL (e.g. https://example.com/api/anthropic)' }
} as const satisfies AgentAccountsUiOf<typeof agent>

export const ui: AgentUi = {
  id: agent.id,
  mark: BsClaude,
  accounts,
  usage
}
