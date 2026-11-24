import type { AgentManifest } from '@core/agent/manifest'
import { CRON_EFFORTS } from '@shared/efforts'
import { SLOT_FILLS } from './prompts/text'

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
  // CC§9
  modelEveryAccountTakes: 'haiku',
  namedModels: [
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' }
  ],
  picksByTaskTier: {
    'very simple': { model: 'sonnet', effort: 'low' },
    normal: { model: 'opus', effort: 'medium' },
    'very hard': { model: 'fable', effort: 'high' }
  },
  ownSettings: { fablePriority: { default: true, keptOnReset: true } },
  slotFills: SLOT_FILLS,
  flags: {
    resumeCanWaitOnAQuestionBeforeAnySign: false,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true,
    // CC§13
    passedOnMessageShowsAsFromAnotherSession: true
  },
  pureFunctions: { effortsAModelTakes: () => CRON_EFFORTS }
} as const satisfies AgentManifest
