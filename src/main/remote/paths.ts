import path from 'path'
import { remoteHostDirName } from '@shared/remoteKey'

// Where a remote machine's things live under userData. The mirror is what the sidebar
// reads instead of ~/.claude/projects; the hook mirror is watched beside the local
// hook-sessions dir and never pruned or cleared by it (three deletions there would
// otherwise fight rsync and replay every transition).

export function remoteBase(userData: string, host: string): string {
  return path.join(userData, 'remote', remoteHostDirName(host))
}

export function mirrorProjectsRoot(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'projects')
}

export function mirrorHookDir(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'hook-sessions')
}

/** local staging of the machine package (`m-<hash>/…`), built once per app start */
export function machinePackageBase(userData: string): string {
  return path.join(userData, 'remote', 'pkg')
}

/** local staging of one tab's package; the launch line removes it once pushed */
export function tabPackageDir(userData: string, tabId: string): string {
  return path.join(userData, 'remote', 'tabs', tabId)
}

/** what the hook settings and the tab script call things ON the machine — spelt with
 *  `$HOME` because the machine's home is unknown here; always double-quoted there */
export const REMOTE_HOME = '$HOME/.koloft'
export function remoteMachineDir(machineName: string): string {
  return `${REMOTE_HOME}/${machineName}`
}
export const REMOTE_HOOK_DIR = `${REMOTE_HOME}/hook-sessions`
export const dq = (s: string): string => `"${s}"`
