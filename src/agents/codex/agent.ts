import type { AgentManifest } from '@core/agent/manifest'
import { CRON_EFFORTS } from '@shared/efforts'
import { EMPTY_THE_BOX, ESC } from '@shared/lineEditKeys'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'
import { codexComposerDraft } from './shared/inputBox'

// CODEX§21
const CLOSE_PAGER = 'q'

// CODEX§15
const MODEL_EVERY_ACCOUNT_TAKES = 'gpt-6-luna'

export const agent = {
  id: 'codex',
  name: 'Codex',
  productName: 'Codex',
  maker: 'OpenAI',
  command: 'codex',
  // CODEX§22
  installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
  nodePackageFolderNames: ['codex'],
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
  // CODEX§17
  skillFolders: {
    inTheWorkspace: { skills: ['.agents/skills', '.codex/skills'], commands: [] },
    inTheHome: { skills: ['.agents/skills'], commands: [] }
  },
  questionToolName: 'request_user_input',
  // CODEX§17
  instructionFileNames: ['AGENTS.md'],
  // CODEX§14
  trustQuestion: 'do you trust the contents of this directory?',
  ownLogFolderNames: [],
  atTopOfSessionFolder: { internalNames: [], internalNameEndings: [], foldersMadeEmptyAhead: [] },
  // CODEX§10 CODEX§38
  envOfItsSessionThatMisleadsWhatStartsInside: {
    named: [
      'CODEX_APP_TOOLS_PIPE_PATH',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
      'CODEX_MCP_NODE_PATH',
      'CODEX_PERMISSION_PROFILE',
      'CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE',
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'CODEX_SHELL',
      'CODEX_CI',
      'KOLOFT_CODEX_SAID',
      'KOLOFT_CODEX_DISCORD_SAID',
      'KOLOFT_CODEX_REPLY_LANGUAGE'
    ],
    startingWith: []
  },
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
  // CODEX§21
  inputBoxKeys: {
    clearALeftoverCommand: [EMPTY_THE_BOX],
    makeEnterRunTheTypedText: [ESC],
    backToAnEmptyBox: [ESC, CLOSE_PAGER, EMPTY_THE_BOX]
  },
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
    questionToolTakesNoOptionDescriptions: false,
    turnEndCanComeBeforeItsReplyIsWritten: false,
    typesASkillOnlyByTheNameInItsFile: false,
    refusesATypedSkillMarkedNotUserInvocable: true
  },
  pureFunctions: {
    effortsAModelTakes: () => CRON_EFFORTS,
    draftInItsInputBox: codexComposerDraft
  },
  // CODEX§15
  accountKinds: [
    {
      id: 'codex-home',
      keychainServiceSuffix: '-codex-home',
      isASignInFolder: true,
      signsInThroughABrowser: true,
      storesAPastedKeyItself: true,
      takesAnEndpoint: false
    }
  ]
} as const satisfies AgentManifest
