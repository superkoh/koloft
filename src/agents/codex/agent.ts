import type { AgentManifest } from '@core/agent/manifest'

export const agent = {
  id: 'codex',
  name: 'Codex',
  productName: 'Codex',
  maker: 'OpenAI',
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
  // CODEX§17
  skillPrefix: '$',
  questionToolName: 'request_user_input',
  // CODEX§17
  instructionFileNames: ['AGENTS.md'],
  // CODEX§14
  trustQuestion: 'do you trust the contents of this directory?',
  ownLogFolderNames: [],
  atTopOfSessionFolder: { internalNames: [], internalNameEndings: [], foldersMadeEmptyAhead: [] },
  flags: {
    // CODEX§9
    resumeCanWaitOnAQuestionBeforeAnySign: true,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true
  }
} as const satisfies AgentManifest
