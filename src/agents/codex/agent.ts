import type { AgentManifest } from '@core/agent/manifest'
import { CRON_EFFORTS } from '@shared/efforts'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'

// CODEX§15
const MODEL_EVERY_ACCOUNT_TAKES = 'gpt-6-luna'

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
  modelEveryAccountTakes: MODEL_EVERY_ACCOUNT_TAKES,
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
  // CODEX§15
  smallJobModels: {
    smallAndQuick: { model: MODEL_EVERY_ACCOUNT_TAKES, effort: 'low' },
    judgesAReply: { model: 'gpt-6.1-sol', effort: 'medium' },
    picksFromAList: { model: 'gpt-6.1-sol', effort: 'low' }
  },
  ownSettings: {},
  slotFills: SLOT_FILLS,
  slotAdditions: SLOT_ADDITIONS,
  flags: {
    // CODEX§9
    resumeCanWaitOnAQuestionBeforeAnySign: true,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true,
    // CODEX§17
    passedOnMessageShowsAsFromAnotherSession: false,
    // CODEX§12
    commandsItRunsCanHaveATerminalOfTheirOwn: true,
    // CODEX§12
    runsCommandsInASandboxWhereSudoCannotStart: true,
    // CODEX§20
    questionToolTakesNoOptionDescriptions: false
  },
  pureFunctions: { effortsAModelTakes: () => CRON_EFFORTS }
} as const satisfies AgentManifest
