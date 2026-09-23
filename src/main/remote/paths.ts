import path from 'path'
import { remoteHostDirName } from '@shared/remoteKey'

export function remoteBase(userData: string, host: string): string {
  return path.join(userData, 'remote', remoteHostDirName(host))
}

export function mirrorProjectsRoot(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'projects')
}

export function mirrorHookDir(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'hook-sessions')
}

export function machinePackageBase(userData: string): string {
  return path.join(userData, 'remote', 'pkg')
}

export function tabPackageDir(userData: string, tabId: string): string {
  return path.join(userData, 'remote', 'tabs', tabId)
}

export const REMOTE_HOME = '$HOME/.koloft'
export function remoteMachineDir(machineName: string): string {
  return `${REMOTE_HOME}/${machineName}`
}
export const REMOTE_HOOK_DIR = `${REMOTE_HOME}/hook-sessions`
export const dq = (s: string): string => `"${s}"`
