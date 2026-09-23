import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'

/**
 * The renderer's two pieces of remote-workspace logic that are worth deciding away from
 * a component: what the Add-remote form accepts, and how many items its workspace menu
 * draws (the fly-out is positioned from that count, so a wrong number puts the menu off
 * the screen edge).
 */

export const MACHINE_EMPTY = 'Type the machine name — the same one you type after `ssh`.'
export const MACHINE_BAD = 'A machine name can only hold letters, numbers, and . _ @ -'
export const PATH_BAD = 'The path has to start with / — write it out in full.'

export type RemoteFormResult = { ok: true; key: string } | { ok: false; message: string }

/** Both fields → the workspace key, or the one line to show under the inputs. Nothing
 *  is checked against the machine itself: the first connection happens when a session
 *  starts, not here. */
export function remoteKeyFromForm(machine: string, path: string): RemoteFormResult {
  const host = machine.trim()
  const dir = path.trim()
  if (!host) return { ok: false, message: MACHINE_EMPTY }
  if (!dir.startsWith('/') || dir.length < 2) return { ok: false, message: PATH_BAD }
  const key = formatRemoteKey(host, dir)
  // the parser owns the machine-name rule. Round-trip rather than re-testing it: a
  // `/` in the machine field parses fine, it just splits somewhere else than typed.
  return parseRemoteKey(key)?.host === host
    ? { ok: true, key }
    : { ok: false, message: MACHINE_BAD }
}

/** How many rows the workspace fly-out draws. A remote workspace has no scheduled
 *  jobs and no Fetch origin (both need a local disk), so it keeps New session +
 *  Restore + separator + Remove — plus New worktree session when the machine says
 *  the folder is a git checkout. */
export function workspaceMenuCount(t: {
  missing: boolean
  isGit: boolean
  remote: boolean
}): number {
  if (t.missing) return 1
  if (t.remote) return t.isGit ? 5 : 4
  return t.isGit ? 7 : 5
}
