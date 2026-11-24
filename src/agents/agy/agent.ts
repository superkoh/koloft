import type { AgentManifest } from '@core/agent/manifest'

export const agent = {
  id: 'agy',
  wordsThatNameMe: {
    anyCase: ['agy', 'antigravity', 'google', 'gemini'],
    wholeWord: [
      'ask_question',
      'run_command',
      'invoke_subagent',
      '--csrf_token',
      '--prompt-interactive',
      '--conversation',
      '--print-timeout'
    ],
    quoted: ['agy-home']
  }
} as const satisfies AgentManifest
