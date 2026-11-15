import { ACCOUNT_KINDS_OF } from './accountUsage'
import { basename } from './preview'
import { parseRemoteKey } from './remoteKey'
import type { AccountKind, BackendId } from './types'

export type WorkspaceAccountLists = Record<string, string[]>

export interface WorkspaceLimit {
  workspace: string
  ids: ReadonlySet<string>
}

export const accountId = (a: { kind: AccountKind; name: string }): string =>
  `${a.kind}:${a.name.toLowerCase()}`

const kindOfId = (id: string): string => id.slice(0, id.indexOf(':'))

export function workspaceLimit(
  lists: WorkspaceAccountLists,
  workspace: string | undefined,
  backend: BackendId
): WorkspaceLimit | undefined {
  if (!workspace) return undefined
  const kinds: readonly string[] = ACCOUNT_KINDS_OF[backend]
  const ids = (lists[workspace] ?? []).filter((id) => kinds.includes(kindOfId(id)))
  return ids.length > 0 ? { workspace, ids: new Set(ids) } : undefined
}

export function withinLimit<A extends { kind: AccountKind; name: string }>(
  accounts: readonly A[],
  limit: WorkspaceLimit | undefined
): A[] {
  return limit ? accounts.filter((a) => limit.ids.has(accountId(a))) : [...accounts]
}

export function workspaceShortName(workspace: string): string {
  const remote = parseRemoteKey(workspace)
  const folder = remote?.path ?? workspace
  const name = basename(folder) || folder
  return remote ? `${remote.host}:${name}` : name
}

export function allowedBy(limit: WorkspaceLimit): string {
  return `${workspaceShortName(limit.workspace)} may use`
}

export function limitNote(limit: WorkspaceLimit | undefined, usable: number): string {
  if (!limit) return ''
  return usable === 1
    ? ` · the only account ${allowedBy(limit)}`
    : ` · one of ${usable} accounts ${allowedBy(limit)}`
}

export function everyAllowedAccountWalled(limit: WorkspaceLimit): string {
  return `every account ${allowedBy(limit)} is at its limit`
}

export function noAllowedAccountMessage(limit: WorkspaceLimit): string {
  return `No account ${allowedBy(limit)} can run this session. Change its list (right-click the workspace ▸ Accounts…) or fix the account in Settings ▸ Accounts.`
}

export function sanitizeWorkspaceAccounts(raw: unknown): WorkspaceAccountLists {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: WorkspaceAccountLists = {}
  for (const [workspace, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue
    const kept = [...new Set(ids.filter((id): id is string => typeof id === 'string'))]
    if (kept.length > 0) out[workspace] = kept
  }
  return out
}

export function workspacesLimitedTo(
  lists: WorkspaceAccountLists,
  account: { kind: AccountKind; name: string }
): string[] {
  const id = accountId(account)
  return Object.entries(lists)
    .filter(([, ids]) => ids.includes(id))
    .map(([workspace]) => workspaceShortName(workspace))
}
