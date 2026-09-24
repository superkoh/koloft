import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'

export const MACHINE_EMPTY = 'Type the machine name — the same one you type after `ssh`.'
export const MACHINE_BAD = 'A machine name can only hold letters, numbers, and . _ @ -'
export const PATH_BAD = 'The path has to start with / — write it out in full.'

export type RemoteFormResult = { ok: true; key: string } | { ok: false; message: string }

export function remoteKeyFromForm(machine: string, path: string): RemoteFormResult {
  const host = machine.trim()
  const dir = path.trim()
  if (!host) return { ok: false, message: MACHINE_EMPTY }
  if (!dir.startsWith('/') || dir.length < 2) return { ok: false, message: PATH_BAD }
  const key = formatRemoteKey(host, dir)
  return parseRemoteKey(key)?.host === host
    ? { ok: true, key }
    : { ok: false, message: MACHINE_BAD }
}

export function workspaceMenuCount(t: {
  missing: boolean
  isGit: boolean
  remote: boolean
}): number {
  if (t.missing) return 1
  if (t.remote) return t.isGit ? 6 : 5
  return t.isGit ? 7 : 5
}
