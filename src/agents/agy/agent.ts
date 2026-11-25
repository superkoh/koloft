import type { AgentManifest } from '@core/agent/manifest'
import {
  AGY_ARTIFACT_SIDECAR,
  AGY_LOGS_FOLDER,
  AGY_SCRATCH_FOLDER,
  AGY_UPLOADS_FOLDER
} from './shared/agyBrain'
import { agyEffortsAModelTakes } from './shared/agyEfforts'
import { AGY_INSTALLER_URL } from './shared/agyInstaller'
import { agyInputBoxDraft } from './shared/inputBox'
import { EMPTY_THE_BOX, ESC } from '@shared/lineEditKeys'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'

export const agent = {
  id: 'agy',
  name: 'Antigravity',
  productName: 'Antigravity CLI',
  maker: 'Google',
  command: 'agy',
  // AGY§3
  installCommand: `curl -fsSL ${AGY_INSTALLER_URL} | bash`,
  nodePackageFolderNames: [],
  wordsThatNameMe: {
    anyCase: ['agy', 'antigravity', 'google', 'gemini'],
    wholeWord: [
      'ask_question',
      'run_command',
      'invoke_subagent',
      '--csrf_token',
      '--prompt-interactive',
      '--conversation',
      '--print-timeout'
    ],
    quoted: []
  },
  // AGY§31
  skillPrefix: '/',
  // AGY§13 AGY§14
  questionToolName: 'ask_question',
  // AGY§2 AGY§32
  instructionFileNames: ['AGENTS.md', 'GEMINI.md'],
  // AGY§5
  trustQuestion: 'Do you trust the contents of this project?',
  // AGY§8
  ownLogFolderNames: [AGY_LOGS_FOLDER],
  // AGY§8 AGY§19
  atTopOfSessionFolder: {
    internalNames: [AGY_LOGS_FOLDER, AGY_UPLOADS_FOLDER],
    internalNameEndings: [AGY_ARTIFACT_SIDECAR],
    foldersMadeEmptyAhead: [AGY_SCRATCH_FOLDER]
  },
  // AGY§9 AGY§25
  envOfItsSessionThatMisleadsWhatStartsInside: {
    named: [],
    startingWith: ['ANTIGRAVITY_', 'KOLOFT_AGY_']
  },
  // AGY§21
  normalTaskFamilyEveryAccountHas: 'argon',
  // AGY§21
  namedModels: [
    { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', notOnEveryAccount: true },
    { id: 'gemini-4-neon', label: 'Gemini 4 Neon', notOnEveryAccount: true },
    { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }
  ],
  // AGY§21
  picksByTaskTier: {
    'very simple': { model: 'flash', effort: 'low' },
    normal: { model: 'neon', effort: 'medium' },
    'very hard': { model: 'carbon', effort: 'high' }
  },
  // AGY§21
  smallJobModels: {
    smallAndQuick: { model: 'gemini-3.8-flash', effort: 'low' },
    judgesAReply: { model: 'gemini-4-argon', effort: 'medium' },
    picksFromAList: { model: 'gemini-3.8-flash', effort: 'low' }
  },
  ownSettings: {},
  slotFills: SLOT_FILLS,
  slotAdditions: SLOT_ADDITIONS,
  // AGY§23
  inputBoxKeys: {
    clearALeftoverCommand: [],
    makeEnterRunTheTypedText: [],
    backToAnEmptyBox: [ESC, EMPTY_THE_BOX]
  },
  flags: {
    // AGY§5
    resumeCanWaitOnAQuestionBeforeAnySign: false,
    // AGY§8
    conversationStartsAtFirstPrompt: true,
    // AGY§15
    pasteKeepsItsLastLineFeeds: false,
    // AGY§15 AGY§16
    passedOnMessageShowsAsFromAnotherSession: false,
    // AGY§25
    commandsItRunsCanHaveATerminalOfTheirOwn: true,
    // AGY§25
    runsCommandsInASandboxWhereSudoCannotStart: false,
    // AGY§14
    questionToolTakesNoOptionDescriptions: true,
    turnEndCanComeBeforeItsReplyIsWritten: false
  },
  pureFunctions: {
    effortsAModelTakes: agyEffortsAModelTakes,
    draftInItsInputBox: agyInputBoxDraft
  },
  // AGY§5 AGY§6
  accountKinds: [
    {
      id: 'agy-home',
      keychainServiceSuffix: '-agy-home',
      isASignInFolder: true,
      signsInThroughABrowser: true,
      storesAPastedKeyItself: false,
      takesAnEndpoint: false
    }
  ]
} as const satisfies AgentManifest
