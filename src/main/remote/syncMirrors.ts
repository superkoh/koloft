import path from 'path'
import { AGY_APP_DIR } from '@agents/agy/main/agyStore'
import { AGY_BRAIN_FLAGS, AGY_REMOTE_BRAIN } from '@agents/agy/main/agyTab'
import { mirrorAgyGemini, mirrorHookDir, mirrorProjectsRoot } from './paths'
import type { RemoteTarget } from './sync'
import { usagePulls } from './usageMirror'

export function syncMirrorsOf(
  t: { host: string },
  userData: string,
  codexMachines: Set<string>,
  codexSessions: { hasHistoryOn(host: string): boolean } | null,
  agySessions: { usesHost(host: string): boolean } | null
): Pick<RemoteTarget, 'mirrorProjectsRoot' | 'mirrorHookDir' | 'extraPulls'> {
  return {
    mirrorProjectsRoot: mirrorProjectsRoot(userData, t.host),
    mirrorHookDir: mirrorHookDir(userData, t.host),
    extraPulls: [
      ...(agySessions?.usesHost(t.host)
        ? [
            {
              from: AGY_REMOTE_BRAIN,
              to: path.join(mirrorAgyGemini(userData, t.host), AGY_APP_DIR, 'brain'),
              flags: AGY_BRAIN_FLAGS
            }
          ]
        : []),
      ...usagePulls(userData, t.host, {
        codex: codexMachines.has(t.host) || !!codexSessions?.hasHistoryOn(t.host),
        agy: !!agySessions?.usesHost(t.host)
      })
    ]
  }
}
