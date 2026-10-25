import path from 'path'
import { AGY_APP_DIR } from '../agyStore'
import { CODEX_ROLLOUT_FOLDERS, type UsageHome } from '../usageCache'
import { REMOTE_CODEX_HOME } from './codexMachine'
import { mirrorAgyGemini, mirrorCodexHome, mirrorMuseHome } from './paths'
import type { ExtraPull } from './sync'

const IN_HOME = /^\$HOME\//

const filesNamed = (name: string): string[] => [
  '--inplace',
  '-m',
  '--delete',
  '--include=*/',
  `--include=${name}`,
  '--exclude=*'
]

// AGY§8
const CONVERSATION_DB_FLAGS = ['--delete', '--include=*.db', '--exclude=*']

export function machineUsageDirs(userData: string, host: string): UsageHome {
  return {
    host,
    codexHome: mirrorCodexHome(userData, host),
    museHome: mirrorMuseHome(userData, host),
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
  const pulls: ExtraPull[] = [
    ...(uses.codex
      ? CODEX_ROLLOUT_FOLDERS.map((folder) => ({
          from: `${codexHome}/${folder}`,
          to: path.join(dirs.codexHome, folder),
          // CODEX§13 CODEX§16
          flags: filesNamed('rollout-*.jsonl')
        }))
      : []),
    ...(uses.muse
      ? [
          {
            from: '.local/share/muse/sessions',
            to: path.join(dirs.museHome, 'sessions'),
            // MUSE§2
            flags: filesNamed('session.jsonl')
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
  return pulls.map((p) => ({ ...p, failsQuietly: true }))
}
