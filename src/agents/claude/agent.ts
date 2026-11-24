import type { AgentManifest } from '@core/agent/manifest'

export const agent = {
  id: 'claude',
  wordsThatNameMe: {
    anyCase: ['claude', 'anthropic', 'fable', 'opus', 'sonnet', 'haiku', 'sk-ant'],
    wholeWord: [
      'AskUserQuestion',
      'ExitPlanMode',
      'SendMessage',
      '--permission-mode',
      '--append-system-prompt',
      '--session-id',
      '--setting-sources',
      '--strict-mcp-config',
      '--mcp-config',
      '--no-session-persistence',
      '--fallback-model'
    ],
    quoted: ['oauth', 'custom']
  },
  ownLogFolderNames: [],
  // CC§2
  atTopOfSessionFolder: {
    internalNames: ['tasks'],
    internalNameEndings: [],
    foldersMadeEmptyAhead: []
  }
} as const satisfies AgentManifest
