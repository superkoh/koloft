import type { HostId } from './types'

export interface RemoteKey {
  host: string
  path: string
}

const PREFIX = 'ssh://'

// ADR-0025
export function parseRemoteKey(key: string): RemoteKey | null {
  if (typeof key !== 'string' || !key.startsWith(PREFIX)) return null
  const rest = key.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const host = rest.slice(0, slash)
  const path = rest.slice(slash)
  if (!/^[A-Za-z0-9._@-]+$/.test(host) || path.length < 2) return null
  return { host, path }
}

export function formatRemoteKey(host: string, path: string): string {
  return `${PREFIX}${host}${path}`
}

export function isRemoteKey(key: string): boolean {
  return parseRemoteKey(key) !== null
}

export function isAbsoluteOnHost(p: string): boolean {
  return isRemoteKey(p) || p.startsWith('/')
}

export function hostOf(cwdOrWorkspacePath: string): HostId {
  return isRemoteKey(cwdOrWorkspacePath) ? 'ssh' : 'local'
}

export function remoteCopyText(host: string, path: string): string {
  return `${host}:${path}`
}

export function remoteHostDirName(host: string): string {
  return host.replace(/@/g, '-at-')
}
