import path from 'path'
import { remoteHostDirName } from '@shared/remoteKey'

export function remoteBase(userData: string, host: string): string {
  return path.join(userData, 'remote', remoteHostDirName(host))
}

export function mirrorHookDir(userData: string, host: string): string {
  return path.join(remoteBase(userData, host), 'hook-sessions')
}

export function machinePackageBase(userData: string): string {
  return path.join(userData, 'remote', 'pkg')
}

export function tabPackagesBase(userData: string): string {
  return path.join(userData, 'remote', 'tabs')
}

export function tabPackageDir(userData: string, tabId: string): string {
  return path.join(tabPackagesBase(userData), tabId)
}

export const REMOTE_HOME = '$HOME/.koloft'
export function remoteMachineDir(machineName: string): string {
  return `${REMOTE_HOME}/${machineName}`
}
export const UTIL_BIN_DIR = 'util-bin/'
export const SESSION_BIN_DIR = 'bin/'
export const STATUS_LINE_DIR = 'statusline/'
export const REMOTE_HOOK_DIR = `${REMOTE_HOME}/hook-sessions`
export const REMOTE_COMPILE_CACHE = `${REMOTE_HOME}/vcache`
export function remotePtsFile(tabId: string): string {
  return `${REMOTE_HOME}/tabs/${tabId}.pts`
}
export const REMOTE_TABS_DIR = `${REMOTE_HOME}/tabs`
export function remoteTabPath(tabId: string): string {
  return `${REMOTE_TABS_DIR}/${tabId}`
}
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
