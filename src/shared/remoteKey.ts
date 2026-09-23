/**
 * A remote workspace's key is `ssh://<machine>/<absolute path>`, stored in the layout's
 * `path` field like any local one. Everything that only treats the key as a string
 * (sidebar grouping, the note folder, tab ownership) works unchanged; everything that
 * touches a disk has to ask `parseRemoteKey` first. `<machine>` is handed to ssh
 * verbatim — an alias from ~/.ssh/config, `user@host`, whatever ssh accepts.
 */
export interface RemoteKey {
  host: string
  /** absolute path on the machine */
  path: string
}

const PREFIX = 'ssh://'

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

/** `machine:/path` — what "Copy path" hands over for a remote row. */
export function remoteCopyText(host: string, path: string): string {
  return `${host}:${path}`
}

/** The per-machine folder name under `<userData>/remote/`. ssh hosts are already
 *  limited to the characters the parser admits, so only `@` needs taming. */
export function remoteHostDirName(host: string): string {
  return host.replace(/@/g, '-at-')
}
