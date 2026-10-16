import fs from 'fs'
import path from 'path'
import type { BackendId, UsageRead, UsageRow } from '@shared/types'
import type { UsageRecord } from './usageScan'
import { PrivateRecordFile } from './privateFile'
import { mapAtMost } from './mapAtMost'

export interface UsageFile {
  file: string
  backend: BackendId
  workspace: string
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

interface CachedFile extends FileStat {
  backend: BackendId
  workspace: string
  cwd?: string
  records: UsageRecord[]
}

export interface UsageCacheDeps {
  cacheFile: () => string
  listFiles: () => Promise<UsageFile[]>
  stat: (file: string) => Promise<FileStat | undefined>
  scan: (files: UsageFile[], scanned: (file: ScannedFile) => void, ended: () => void) => void
  codexWorkspaces: (cwds: string[]) => string[]
  changed: () => void
}

const FILES_AT_ONCE = 16
const CODEX_ROLLOUT_FOLDERS = ['sessions', 'archived_sessions']

export class UsageCache {
  private reading = false
  private readonly cached: PrivateRecordFile<CachedFile>

  constructor(private readonly deps: UsageCacheDeps) {
    this.cached = new PrivateRecordFile(deps.cacheFile)
  }

  async read(): Promise<UsageRead> {
    if (!this.reading) await this.refresh()
    return { rows: this.rows(), reading: this.reading }
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

  private rows(): UsageRow[] {
    const entries = Object.values(this.cached.get())
    const codex = entries.filter((e) => e.backend === 'codex' && e.records.length)
    const workspaces = this.deps.codexWorkspaces(codex.map((e) => e.cwd ?? ''))
    const codexWorkspace = new Map(codex.map((e, i) => [e, workspaces[i]]))
    return entries.flatMap((e) =>
      e.records.map((r) => ({
        ...r,
        backend: e.backend,
        workspace: codexWorkspace.get(e) ?? e.workspace
      }))
    )
  }
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
  codexHome: string
): Promise<UsageFile[]> {
  const claude = await mapAtMost(transcripts, FILES_AT_ONCE, async ({ file, workspace }) => {
    const subagents = path.join(file.slice(0, -'.jsonl'.length), 'subagents')
    return [file, ...(await jsonlUnder(subagents, ''))].map((f) => ({
      file: f,
      backend: 'claude' as const,
      workspace
    }))
  })
  const codex = await Promise.all(
    CODEX_ROLLOUT_FOLDERS.map((folder) => jsonlUnder(path.join(codexHome, folder), 'rollout-'))
  )
  return [
    ...claude.flat(),
    ...codex.flat().map((file) => ({ file, backend: 'codex' as const, workspace: '' }))
  ]
}

export async function statOf(file: string): Promise<FileStat | undefined> {
  try {
    const { mtimeMs, size } = await fs.promises.stat(file)
    return { mtimeMs, size }
  } catch {
    return undefined
  }
}
