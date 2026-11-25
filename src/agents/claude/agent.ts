import type { AgentManifest } from '@core/agent/manifest'
import { CRON_EFFORTS } from '@shared/efforts'
import { ESC } from '@shared/lineEditKeys'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'
import { inputBoxDraft } from './shared/inputBox'

// CC§9
const MODEL_EVERY_ACCOUNT_TAKES = 'haiku'

export const agent = {
  id: 'claude',
  name: 'Claude',
  productName: 'Claude Code',
  maker: 'Anthropic',
  command: 'claude',
  // CC§10
  installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
  nodePackageFolderNames: ['claude-code'],
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
  // CC§9
  skillFolders: {
    inTheWorkspace: { skills: ['.claude/skills'], commands: ['.claude/commands'] },
    inTheHome: { skills: ['.claude/skills'], commands: ['.claude/commands'] }
  },
  questionToolName: 'AskUserQuestion',
  // CC§30
  instructionFileNames: ['CLAUDE.md', 'AGENTS.md'],
  // CC§9
  trustQuestion: 'do you trust this project?',
  // CC§13
  textItsMessagesCannotHold: '</cross-session-message>',
  ownLogFolderNames: [],
  // CC§2
  atTopOfSessionFolder: {
    internalNames: ['tasks'],
    internalNameEndings: [],
    foldersMadeEmptyAhead: []
  },
  // CC§9
  envOfItsSessionThatMisleadsWhatStartsInside: {
    named: ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_JOB_DIR', 'CLAUDE_PID', 'AI_AGENT'],
    startingWith: ['CLAUDE_CODE_']
  },
  modelEveryAccountTakes: MODEL_EVERY_ACCOUNT_TAKES,
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
  // CC§9
  smallJobModels: {
    smallAndQuick: { model: MODEL_EVERY_ACCOUNT_TAKES },
    judgesAReply: { model: 'haiku' },
    picksFromAList: { model: 'sonnet', effort: 'low' }
  },
  ownSettings: { fablePriority: { default: true, keptOnReset: true } },
  slotFills: SLOT_FILLS,
  slotAdditions: SLOT_ADDITIONS,
  // CC§12
  inputBoxKeys: {
    clearALeftoverCommand: [],
    makeEnterRunTheTypedText: [ESC],
    backToAnEmptyBox: [ESC]
  },
  // CC§12
  commandWithItsChoiceAfterIt: '/model haiku',
  howToStopItsBackgroundTasks:
    'Stop them in the session (ctrl+b lists background tasks) to free the resources.',
  flags: {
    resumeCanWaitOnAQuestionBeforeAnySign: false,
    conversationStartsAtFirstPrompt: false,
    pasteKeepsItsLastLineFeeds: true,
    // CC§13
    passedOnMessageShowsAsFromAnotherSession: true,
    // CC§13
    sessionsOfItsKindOnOneMachineTalkWithTheirOwnTool: true,
    // CC§13
    mightNotTakeAMessageWhileItsTurnRuns: false,
    // PLATFORM§58
    commandsItRunsCanHaveATerminalOfTheirOwn: false,
    // PLATFORM§58
    runsCommandsInASandboxWhereSudoCannotStart: false,
    // CC§14
    questionToolTakesNoOptionDescriptions: false,
    // CC§4
    removesItsWorktreeAsItExits: true,
    // CC§2
    turnEndCanComeBeforeItsReplyIsWritten: true,
    // CC§9
    typesASkillOnlyByTheNameInItsFile: false,
    // CC§20
    refusesATypedSkillMarkedNotUserInvocable: true
  },
  pureFunctions: { effortsAModelTakes: () => CRON_EFFORTS, draftInItsInputBox: inputBoxDraft },
  // CC§7
  accountKinds: [
    {
      id: 'oauth',
      keychainServiceSuffix: '-claude-oauth',
      isASignInFolder: false,
      signsInThroughABrowser: true,
      storesAPastedKeyItself: false,
      takesAnEndpoint: false
    },
    {
      id: 'apikey',
      keychainServiceSuffix: '-anthropic-api',
      isASignInFolder: false,
      signsInThroughABrowser: false,
      storesAPastedKeyItself: false,
      takesAnEndpoint: false
    },
    {
      id: 'custom',
      keychainServiceSuffix: '-custom-endpoint',
      isASignInFolder: false,
      signsInThroughABrowser: false,
      storesAPastedKeyItself: false,
      takesAnEndpoint: true
    }
  ]
} as const satisfies AgentManifest
