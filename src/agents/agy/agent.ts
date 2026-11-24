import type { AgentManifest } from '@core/agent/manifest'
import {
  AGY_ARTIFACT_SIDECAR,
  AGY_LOGS_FOLDER,
  AGY_SCRATCH_FOLDER,
  AGY_UPLOADS_FOLDER
} from './shared/agyBrain'
import { SLOT_ADDITIONS, SLOT_FILLS } from './prompts/text'

export const agent = {
  id: 'agy',
  name: 'Antigravity',
  productName: 'Antigravity CLI',
  maker: 'Google',
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
  slotFills: SLOT_FILLS,
  slotAdditions: SLOT_ADDITIONS,
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
    questionToolTakesNoOptionDescriptions: true
  }
} as const satisfies AgentManifest
