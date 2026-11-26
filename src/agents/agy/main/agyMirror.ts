import path from 'path'
import type { MirrorFolder } from '@core/agent/mirrorFolders'
import { remoteBase } from '../../../main/remote/paths'
import { AGY_APP_DIR } from './agyStore'
import { AGY_BRAIN_FLAGS, AGY_REMOTE_BRAIN } from './agyTab'

const GEMINI_MIRROR = 'agy-gemini'

// AGY§8
const CONVERSATION_DB_FLAGS = ['--delete', '--include=*.db', '--exclude=*']

export function mirrorAgyGemini(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), GEMINI_MIRROR)
}

export function agyFoldersToMirror(landing: string): MirrorFolder[] {
  const geminiDir = path.join(landing, GEMINI_MIRROR)
  return [
    {
      from: AGY_REMOTE_BRAIN,
      to: path.join(geminiDir, AGY_APP_DIR, 'brain'),
      flags: AGY_BRAIN_FLAGS,
      holds: 'records'
    },
    {
      from: `.gemini/${AGY_APP_DIR}/conversations`,
      to: path.join(geminiDir, AGY_APP_DIR, 'conversations'),
      flags: CONVERSATION_DB_FLAGS,
      holds: 'usage'
    }
  ]
}
