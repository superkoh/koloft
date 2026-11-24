import type { AgentManifest } from '@core/agent/manifest'

export const agent = {
  id: 'codex',
  wordsThatNameMe: {
    anyCase: ['codex', 'openai', 'gpt'],
    wholeWord: [
      'request_user_input',
      'spawn_agent',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ask-for-approval',
      '--sandbox',
      '--ignore-user-config',
      '--ignore-rules'
    ],
    quoted: []
  },
  folderNamesNotWatched: [],
  hiddenAtTopOfScratchpad: { named: [], nameEndingIn: [], foldersWhileEmpty: [] }
} as const satisfies AgentManifest
