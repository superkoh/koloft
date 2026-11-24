import type { AgentManifest } from '@core/agent/manifest'
import { CRON_EFFORTS } from '@shared/efforts'
import { SLOT_FILLS } from './prompts/text'

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
  // CODEX§15
  modelEveryAccountTakes: 'gpt-6-luna',
  // CODEX§14
  namedModels: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna' }
  ],
  // CODEX§14
  picksByTaskTier: {
    'very simple': { model: 'luna', effort: 'low' },
    normal: { model: 'sol', effort: 'medium' },
    'very hard': { model: 'astra', effort: 'high' }
  },
  ownSettings: {},
  slotFills: SLOT_FILLS,
  flags: {
    // CODEX§9
    resumeCanWaitOnAQuestionBeforeAnySign: true,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true,
    // CODEX§17
    passedOnMessageShowsAsFromAnotherSession: false
  },
  pureFunctions: { effortsAModelTakes: () => CRON_EFFORTS }
} as const satisfies AgentManifest
