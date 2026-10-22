import path from 'path'
import { AGY_APP_DIR } from '../agyStore'
import { mirrorAgyGemini, remoteBase } from './paths'

export interface ExtraPull {
  from: string
  to: string
  flags: string[]
}

export interface MachineUsageDirs {
  codexHome: string
  museHome: string
  agyAppDir: string
}

const CODEX_ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']

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

export function machineUsageDirs(userData: string, host: string): MachineUsageDirs {
  const base = remoteBase(userData, host)
  return {
    codexHome: path.join(base, 'codex-home'),
    museHome: path.join(base, 'muse'),
    agyAppDir: path.join(mirrorAgyGemini(userData, host), AGY_APP_DIR)
  }
}

export function usagePulls(
  userData: string,
  host: string,
  uses: { codex: boolean; muse: boolean; agy: boolean }
): ExtraPull[] {
  const dirs = machineUsageDirs(userData, host)
  return [
    ...(uses.codex
      ? CODEX_ROLLOUT_FOLDERS.map((folder) => ({
          from: `.koloft/codex-home/${folder}`,
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
            to: path.join(dirs.agyAppDir, 'conversations'),
            flags: CONVERSATION_DB_FLAGS
          }
        ]
      : [])
  ]
}
