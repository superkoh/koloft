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

export function mirrorAgyGemini(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'agy-gemini')
}

export function mirrorCodexHome(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'codex-home')
}

export function mirrorMuseHome(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'muse')
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
export function remotePtsFile(tabId: string): string {
  return `${REMOTE_HOME}/tabs/${tabId}.pts`
}
export const REMOTE_TABS_DIR = `${REMOTE_HOME}/tabs`
export function remoteShellPidFile(tabId: string): string {
  return `${REMOTE_TABS_DIR}/${tabId}.shell`
}
export function remoteBrowserAddressFile(tabId: string): string {
  return `${REMOTE_TABS_DIR}/${tabId}.cdp`
}
export function browserForwardFile(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'browser-forward.json')
}
export function pageForwardsFile(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'page-forwards.json')
}
export const dq = (s: string): string => `"${s}"`
