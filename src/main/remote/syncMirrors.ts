import type { FolderSplitByWorkspace, MirrorFolder } from '@core/agent/mirrorFolders'
import { mirrorHookDir, remoteBase } from './paths'
import type { ExtraPull, RemoteTarget } from './sync'

export function syncMirrorsOf(
  host: string,
  userData: string,
  agents: { foldersToMirrorFrom(host: string, landing: string): MirrorFolder[] }
): Pick<RemoteTarget, 'byWorkspace' | 'mirrorHookDir' | 'extraPulls'> {
  const folders = agents.foldersToMirrorFrom(host, remoteBase(userData, host))
  return {
    byWorkspace: folders.filter((f): f is FolderSplitByWorkspace => !('flags' in f)),
    mirrorHookDir: mirrorHookDir(userData, host),
    extraPulls: folders.flatMap((f): ExtraPull[] =>
      'flags' in f
        ? [{ from: f.from, to: f.to, flags: f.flags, failsQuietly: f.holds === 'usage' }]
        : []
    )
  }
}
