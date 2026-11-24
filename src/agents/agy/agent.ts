import type { AgentManifest } from '@core/agent/manifest'
import {
  AGY_ARTIFACT_SIDECAR,
  AGY_LOGS_FOLDER,
  AGY_SCRATCH_FOLDER,
  AGY_UPLOADS_FOLDER
} from './shared/agyBrain'

export const agent = {
  id: 'agy',
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
  // AGY§8
  ownLogFolderNames: [AGY_LOGS_FOLDER],
  // AGY§8 AGY§19
  atTopOfSessionFolder: {
    internalNames: [AGY_LOGS_FOLDER, AGY_UPLOADS_FOLDER],
    internalNameEndings: [AGY_ARTIFACT_SIDECAR],
    foldersMadeEmptyAhead: [AGY_SCRATCH_FOLDER]
  }
} as const satisfies AgentManifest
