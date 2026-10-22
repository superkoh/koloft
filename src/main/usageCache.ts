import fs from 'fs'
import path from 'path'
import type { BackendId, UsageRead, UsageRow } from '@shared/types'
import { formatRemoteKey } from '@shared/remoteKey'
import type { UsageRecord } from './usageScan'
import { PrivateRecordFile } from './privateFile'
import { mapAtMost } from './mapAtMost'

export interface UsageFile {
  file: string
  backend: BackendId
  workspace: string
  sessionId?: string
  db?: string
  host?: string
}

export interface SessionPlace {
  workspace: string
  title: string
}

export interface ScannedFile {
  file: string
  records: UsageRecord[]
  cwd?: string
}

interface FileStat {
  mtimeMs: number
  size: number
}

interface CachedFile extends FileStat, UsageFile {
  cwd?: string
  records: UsageRecord[]
}

export interface UsageCacheDeps {
  cacheFile: () => string
  listFiles: () => Promise<UsageFile[]>
  stat: (file: string) => Promise<FileStat | undefined>
  scan: (files: UsageFile[], scanned: (file: ScannedFile) => void, ended: () => void) => void
  codexWorkspaces: (cwds: string[]) => string[]
  sessionPlace: (backend: BackendId, sessionId: string, host?: string) => SessionPlace | undefined
  changed: () => void
}

const FILES_AT_ONCE = 16
const CODEX_ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']
const MUSE_SESSION_FILE_PREFIX = 'session.'
const MUSE_DATE_DEPTH = 3

export class UsageCache {
  private reading = false
  private readonly cached: PrivateRecordFile<CachedFile>

  constructor(private readonly deps: UsageCacheDeps) {
    this.cached = new PrivateRecordFile(deps.cacheFile)
  }

  async read(): Promise<UsageRead> {
    if (!this.reading) await this.refresh()
    return { ...this.rows(), reading: this.reading }
  }

  private async refresh(): Promise<void> {
    this.reading = true
    const listed = await this.deps.listFiles()
    const stats = await mapAtMost(listed, FILES_AT_ONCE, (f) => this.deps.stat(f.file))
    const cached = this.cached.get()
    const present = new Set<string>()
    const stale = new Map<string, UsageFile & FileStat>()
    listed.forEach((f, i) => {
      const stat = stats[i]
      if (!stat) return
      present.add(f.file)
      const entry = cached[f.file]
      if (entry?.mtimeMs === stat.mtimeMs && entry.size === stat.size) entry.workspace = f.workspace
      else stale.set(f.file, { ...f, ...stat })
    })
    const gone = Object.keys(cached).filter((file) => !present.has(file))
    for (const file of gone) delete cached[file]
    if (!stale.size) {
      if (gone.length) this.cached.save()
      this.reading = false
      return
    }
    this.deps.scan(
      [...stale.values()],
      ({ file, records, cwd }) => {
        const f = stale.get(file)
        if (f) cached[file] = { ...f, cwd, records }
      },
      () => {
        this.cached.save()
        this.reading = false
        this.deps.changed()
      }
    )
  }

  private rows(): Pick<UsageRead, 'rows' | 'titles'> {
    const entries = Object.values(this.cached.get()).filter((e) => e.records.length)
    const codex = entries.filter((e) => e.backend === 'codex')
    const workspaces = this.deps.codexWorkspaces(
      codex.map((e) => (e.host && e.cwd ? formatRemoteKey(e.host, e.cwd) : (e.cwd ?? '')))
    )
    const codexWorkspace = new Map(codex.map((e, i) => [e, workspaces[i]]))
    const placeOf = (e: CachedFile, sessionId: string): SessionPlace | undefined =>
      this.deps.sessionPlace(e.backend, sessionId, e.host)
    const titles: Record<string, string> = {}
    const rows = entries.flatMap((e) => {
      const workspace =
        codexWorkspace.get(e) ??
        (e.sessionId ? placeOf(e, e.sessionId)?.workspace : undefined) ??
        e.workspace
      return e.records.map((r): UsageRow => {
        titles[r.sessionId] ??= placeOf(e, r.sessionId)?.title ?? ''
        return { ...r, backend: e.backend, workspace }
      })
    })
    return { rows, titles }
  }
}

export interface UsageHome {
  host?: string
  codexHome: string
  museHome: string
  agyAppDir: string
}

// CODEX§13
async function codexFiles({ host, codexHome }: UsageHome): Promise<UsageFile[]> {
  const found = await Promise.all(
    CODEX_ROLLOUT_FOLDERS.map((folder) => jsonlUnder(path.join(codexHome, folder), 'rollout-'))
  )
  return found.flat().map((file) => ({ file, backend: 'codex' as const, workspace: '', host }))
}

// MUSE§2
async function museFiles({ host, museHome }: UsageHome): Promise<UsageFile[]> {
  const sessions = path.join(museHome, 'sessions')
  return (await jsonlUnder(sessions, MUSE_SESSION_FILE_PREFIX)).map((file) => ({
    file,
    backend: 'muse' as const,
    workspace: '',
    sessionId: path.relative(sessions, file).split(path.sep)[MUSE_DATE_DEPTH],
    host
  }))
}

// AGY§8
async function agyFiles({ host, agyAppDir }: UsageHome): Promise<UsageFile[]> {
  let ids: string[]
  try {
    ids = await fs.promises.readdir(path.join(agyAppDir, 'brain'))
  } catch {
    return []
  }
  return ids.map((id) => ({
    file: path.join(agyAppDir, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'),
    backend: 'agy' as const,
    workspace: '',
    sessionId: id,
    db: path.join(agyAppDir, 'conversations', `${id}.db`),
    host
  }))
}

async function jsonlUnder(dir: string, namePrefix: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = await Promise.all(
    entries.map(async (e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return jsonlUnder(p, namePrefix)
      return e.isFile() && e.name.startsWith(namePrefix) && e.name.endsWith('.jsonl') ? [p] : []
    })
  )
  return found.flat()
}

// CC§2 CODEX§13
export async function listUsageFiles(
  transcripts: { file: string; workspace: string }[],
  homes: UsageHome[]
): Promise<UsageFile[]> {
  const claude = await mapAtMost(transcripts, FILES_AT_ONCE, async ({ file, workspace }) => {
    const subagents = path.join(file.slice(0, -'.jsonl'.length), 'subagents')
    return [file, ...(await jsonlUnder(subagents, ''))].map((f) => ({
      file: f,
      backend: 'claude' as const,
      workspace
    }))
  })
  const others = await Promise.all(
    homes.flatMap((home) => [codexFiles(home), museFiles(home), agyFiles(home)])
  )
  return [...claude.flat(), ...others.flat()]
}

export async function statOf(file: string): Promise<FileStat | undefined> {
  try {
    const { mtimeMs, size } = await fs.promises.stat(file)
    return { mtimeMs, size }
  } catch {
    return undefined
  }
}
