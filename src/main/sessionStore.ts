import fs from 'fs'
import type { LaunchPermission } from '@shared/types'
import { isAbsoluteOnHost, parseRemoteKey } from '@shared/remoteKey'
import { sessionKey } from '@shared/sessionBackend'
import { BackgroundFile } from './backgroundFile'

export interface StoredMember {
  id: string
  key: string
  workspacePath: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  worktreeResourceId?: string
  permission?: LaunchPermission
}

export interface WorktreeResource {
  id: string
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch: string | null
  originalHeadCommit: string
  state: 'creating' | 'ready' | 'failed'
  managed: boolean
  error?: string
}

interface SessionStoreData {
  version: 1
  members: Record<string, StoredMember>
  resources: Record<string, WorktreeResource>
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const sessionKeyOn =
  (backend: 'codex' | 'muse' | 'agy', label: string) =>
  (id: string, host?: string): string => {
    if (!UUID.test(id)) throw new Error(`Invalid ${label} session ID`)
    return sessionKey({ backendId: backend, sourceId: host ?? 'local', nativeSessionId: id })
  }

export const codexSessionKey = sessionKeyOn('codex', 'Codex')
export const museSessionKey = sessionKeyOn('muse', 'Muse')
export const agySessionKey = sessionKeyOn('agy', 'Antigravity')

export type KeyOf = (id: string, host?: string) => string

export const hostOfPath = (p: string): string | undefined => parseRemoteKey(p)?.host

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && isAbsoluteOnHost(value)
}

function validMember(value: unknown, key: string, keyOf: KeyOf): value is StoredMember {
  if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false
  return (
    value.key === key &&
    absolute(value.cwd) &&
    key === keyOf(value.id, hostOfPath(value.cwd)) &&
    absolute(value.workspacePath) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    (value.worktreeResourceId === undefined || typeof value.worktreeResourceId === 'string') &&
    (value.permission === undefined ||
      value.permission === 'acceptEdits' ||
      value.permission === 'bypass')
  )
}

function validResource(value: unknown, id: string): value is WorktreeResource {
  if (!record(value)) return false
  return (
    value.id === id &&
    UUID.test(id) &&
    absolute(value.originalCwd) &&
    absolute(value.worktreePath) &&
    typeof value.worktreeName === 'string' &&
    value.worktreeName.length > 0 &&
    (value.worktreeBranch === null ||
      (typeof value.worktreeBranch === 'string' && value.worktreeBranch.length > 0)) &&
    typeof value.originalHeadCommit === 'string' &&
    /^[0-9a-f]{40,64}$/i.test(value.originalHeadCommit) &&
    ['creating', 'ready', 'failed'].includes(value.state as string) &&
    typeof value.managed === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

function parseData(value: unknown, keyOf: KeyOf): SessionStoreData {
  // ADR-0025
  if (!record(value) || value.version !== 1) throw new Error('Unsupported session store version')
  if (!record(value.members) || !record(value.resources)) throw new Error('Invalid session store')
  for (const [id, resource] of Object.entries(value.resources)) {
    if (!validResource(resource, id)) throw new Error(`Invalid worktree resource: ${id}`)
  }
  for (const [key, member] of Object.entries(value.members)) {
    if (!validMember(member, key, keyOf)) throw new Error(`Invalid session member: ${key}`)
    if (member.worktreeResourceId && !Object.hasOwn(value.resources, member.worktreeResourceId)) {
      throw new Error(`Missing worktree resource for session: ${key}`)
    }
  }
  return value as unknown as SessionStoreData
}

export class SessionStore {
  private data: SessionStoreData
  private disk: BackgroundFile

  constructor(
    readonly filePath: string,
    private keyOf: KeyOf = codexSessionKey
  ) {
    try {
      this.data = parseData(JSON.parse(fs.readFileSync(filePath, 'utf8')), keyOf)
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`, fs.constants.COPYFILE_EXCL)
      } catch {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.data = { version: 1, members: {}, resources: {} }
    }
    this.disk = new BackgroundFile(() => filePath, 0o600)
  }

  flushSync(): void {
    this.disk.flushSync()
  }

  listMembers(workspacePath?: string): StoredMember[] {
    return structuredClone(
      Object.values(this.data.members).filter(
        (member) => workspacePath === undefined || member.workspacePath === workspacePath
      )
    )
  }

  getMember(key: string): StoredMember | undefined {
    return Object.hasOwn(this.data.members, key)
      ? structuredClone(this.data.members[key])
      : undefined
  }

  upsertMember(member: StoredMember): void {
    const next = structuredClone(this.data)
    next.members[member.key] = structuredClone(member)
    this.commit(next)
  }

  updateMember(key: string, patch: Partial<Omit<StoredMember, 'id' | 'key'>>): StoredMember {
    const member = this.getMember(key)
    if (!member) throw new Error(`Session member not found: ${key}`)
    const updated = { ...member, ...patch }
    this.upsertMember(updated)
    return updated
  }

  removeMember(key: string): boolean {
    if (!Object.hasOwn(this.data.members, key)) return false
    const next = structuredClone(this.data)
    delete next.members[key]
    this.commit(next)
    return true
  }

  listResources(): WorktreeResource[] {
    return structuredClone(Object.values(this.data.resources))
  }

  getResource(id: string): WorktreeResource | undefined {
    return Object.hasOwn(this.data.resources, id)
      ? structuredClone(this.data.resources[id])
      : undefined
  }

  removeUnusedResourcesAt(worktreePath: string): void {
    const used = new Set(Object.values(this.data.members).map((m) => m.worktreeResourceId))
    const gone = Object.values(this.data.resources).filter(
      (r) => r.worktreePath === worktreePath && !used.has(r.id)
    )
    if (gone.length === 0) return
    const next = structuredClone(this.data)
    for (const r of gone) delete next.resources[r.id]
    this.commit(next)
  }

  putResource(resource: WorktreeResource): void {
    const next = structuredClone(this.data)
    next.resources[resource.id] = structuredClone(resource)
    this.commit(next)
  }

  private commit(next: SessionStoreData): void {
    parseData(next, this.keyOf)
    this.data = next
    this.disk.write(JSON.stringify(next, null, 2) + '\n')
  }
}
