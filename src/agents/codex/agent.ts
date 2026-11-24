import type { AgentManifest } from '@core/agent/manifest'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'

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
  }
} as const satisfies AgentManifest
