import type { AgentManifest } from '@core/agent/manifest'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'

export const agent = {
  id: 'claude',
  name: 'Claude',
  productName: 'Claude Code',
  maker: 'Anthropic',
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
  // CC§9
  skillPrefix: '/',
  questionToolName: 'AskUserQuestion',
  // CC§30
  instructionFileNames: ['CLAUDE.md', 'AGENTS.md'],
  // CC§9
  trustQuestion: 'do you trust this project?',
  ownLogFolderNames: [],
  // CC§2
  atTopOfSessionFolder: {
    internalNames: ['tasks'],
    internalNameEndings: [],
    foldersMadeEmptyAhead: []
  },
  slotFills: SLOT_FILLS,
  slotAdditions: SLOT_ADDITIONS,
  // CC§9
  smallJobModels: {
    smallAndQuick: { model: 'haiku' },
    judgesAReply: { model: 'haiku' },
    picksFromAList: { model: 'sonnet', effort: 'low' }
  },
  flags: {
    resumeCanWaitOnAQuestionBeforeAnySign: false,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true,
    // CC§13
    passedOnMessageShowsAsFromAnotherSession: true,
    // PLATFORM§58
    commandsItRunsCanHaveATerminalOfTheirOwn: false,
    // PLATFORM§58
    runsCommandsInASandboxWhereSudoCannotStart: false,
    // CC§14
    questionToolTakesNoOptionDescriptions: false
  }
} as const satisfies AgentManifest
