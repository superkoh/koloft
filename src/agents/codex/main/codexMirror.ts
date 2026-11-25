import path from 'path'
import type { MirrorFolder } from '@core/agent/mirrorFolders'
import { remoteBase } from '../../../main/remote/paths'
import { REMOTE_CODEX_HOME } from './codexMachine'

export const CODEX_ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']
const IN_HOME = /^\$HOME\//
const CODEX_HOME_MIRROR = 'codex-home'

const filesNamed = (name: string): string[] => [
  '--inplace',
  '-m',
  '--delete',
  '--include=*/',
  `--include=${name}`,
  '--exclude=*'
]

export function mirrorCodexHome(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), CODEX_HOME_MIRROR)
}

export function codexUsageFolders(landing: string): MirrorFolder[] {
  const codexHome = REMOTE_CODEX_HOME.replace(IN_HOME, '')
  return CODEX_ROLLOUT_FOLDERS.map((folder) => ({
    from: `${codexHome}/${folder}`,
    to: path.join(landing, CODEX_HOME_MIRROR, folder),
    // CODEX§13 CODEX§16
    flags: filesNamed('rollout-*.jsonl'),
    holds: 'usage'
  }))
}
