import path from 'path'
import { AGY_APP_DIR } from '../agyStore'
import { CODEX_ROLLOUT_FOLDERS, type UsageHome } from '../usageCache'
import { REMOTE_CODEX_HOME } from './codexMachine'
import { mirrorAgyGemini, remoteBase } from './paths'

export interface ExtraPull {
  from: string
  to: string
  flags: string[]
}

const IN_HOME = /^\$HOME\//

// CODEX§13 CODEX§16
const ROLLOUT_FLAGS = [
  '--inplace',
  '-m',
  '--delete',
  '--include=*/',
  '--include=rollout-*.jsonl',
  '--exclude=*'
]
// MUSE§2
const MUSE_FLAGS = [
  '--inplace',
  '-m',
  '--delete',
  '--include=*/',
  '--include=session.jsonl',
  '--exclude=*'
]
// AGY§8
const CONVERSATION_DB_FLAGS = ['--delete', '--include=*.db', '--exclude=*']

export function machineUsageDirs(userData: string, host: string): UsageHome {
  const base = remoteBase(userData, host)
  return {
    host,
    codexHome: path.join(base, 'codex-home'),
    museHome: path.join(base, 'muse'),
    geminiDir: mirrorAgyGemini(userData, host)
  }
}

export function usagePulls(
  userData: string,
  host: string,
  uses: { codex: boolean; muse: boolean; agy: boolean }
): ExtraPull[] {
  const dirs = machineUsageDirs(userData, host)
  const codexHome = REMOTE_CODEX_HOME.replace(IN_HOME, '')
  return [
    ...(uses.codex
      ? CODEX_ROLLOUT_FOLDERS.map((folder) => ({
          from: `${codexHome}/${folder}`,
          to: path.join(dirs.codexHome, folder),
          flags: ROLLOUT_FLAGS
        }))
      : []),
    ...(uses.muse
      ? [
          {
            from: '.local/share/muse/sessions',
            to: path.join(dirs.museHome, 'sessions'),
            flags: MUSE_FLAGS
          }
        ]
      : []),
    ...(uses.agy
      ? [
          {
            from: `.gemini/${AGY_APP_DIR}/conversations`,
            to: path.join(dirs.geminiDir, AGY_APP_DIR, 'conversations'),
            flags: CONVERSATION_DB_FLAGS
          }
        ]
      : [])
  ]
}
