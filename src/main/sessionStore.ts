import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export interface CodexMember {
  id: string
  key: string
  workspacePath: string
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
  worktreeResourceId?: string
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
  members: Record<string, CodexMember>
  resources: Record<string, WorktreeResource>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function codexSessionKey(id: string): string {
  if (!UUID.test(id)) throw new Error('Invalid Codex session ID')
  return `codex:local:${id}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value)
}

function validMember(value: unknown, key: string): value is CodexMember {
  if (!record(value) || typeof value.id !== 'string' || !UUID.test(value.id)) return false
  return (
    value.key === key &&
    key === codexSessionKey(value.id) &&
    absolute(value.workspacePath) &&
    absolute(value.cwd) &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    (value.worktreeResourceId === undefined || typeof value.worktreeResourceId === 'string')
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

function parseData(value: unknown): SessionStoreData {
  if (!record(value) || value.version !== 1) throw new Error('Unsupported session store version')
  if (!record(value.members) || !record(value.resources)) throw new Error('Invalid session store')
  for (const [id, resource] of Object.entries(value.resources)) {
    if (!validResource(resource, id)) throw new Error(`Invalid worktree resource: ${id}`)
  }
  for (const [key, member] of Object.entries(value.members)) {
    if (!validMember(member, key)) throw new Error(`Invalid session member: ${key}`)
    if (member.worktreeResourceId && !Object.hasOwn(value.resources, member.worktreeResourceId)) {
      throw new Error(`Missing worktree resource for session: ${key}`)
    }
  }
  return value as unknown as SessionStoreData
}

export class SessionStore {
  private data: SessionStoreData

  constructor(readonly filePath: string) {
    try {
      this.data = parseData(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.data = { version: 1, members: {}, resources: {} }
    }
  }

  listMembers(workspacePath?: string): CodexMember[] {
    return structuredClone(
      Object.values(this.data.members).filter(
        (member) => workspacePath === undefined || member.workspacePath === workspacePath
      )
    )
  }

  getMember(key: string): CodexMember | undefined {
    return Object.hasOwn(this.data.members, key)
      ? structuredClone(this.data.members[key])
      : undefined
  }

  upsertMember(member: CodexMember): void {
    const next = structuredClone(this.data)
    next.members[member.key] = structuredClone(member)
    this.commit(next)
  }

  updateMember(key: string, patch: Partial<Omit<CodexMember, 'id' | 'key'>>): CodexMember {
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

  putResource(resource: WorktreeResource): void {
    const next = structuredClone(this.data)
    next.resources[resource.id] = structuredClone(resource)
    this.commit(next)
  }

  private commit(next: SessionStoreData): void {
    parseData(next)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (fs.existsSync(this.filePath) && !fs.existsSync(`${this.filePath}.bak`)) {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`, fs.constants.COPYFILE_EXCL)
      }
      fs.renameSync(temporary, this.filePath)
      this.data = next
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    }
  }
}
