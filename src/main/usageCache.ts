import fs from 'fs'
import type { BackendId, UsageRead, UsageRecord, UsageRow } from '@shared/types'
import { PrivateRecordFile } from '@core/privateFile'
import { mapAtMost } from '@core/mapAtMost'
import type {
  AgentUsage,
  CachedUsageFile,
  FileStat,
  ScannedFile,
  UsageFile
} from '@core/agent/usage'

export interface AgentWithUsage {
  id: BackendId
  usage: AgentUsage
}

export interface UsageCacheDeps {
  cacheFile: () => string
  listFiles: () => Promise<UsageFile[]>
  stat: (file: string) => Promise<FileStat | undefined>
  scan: (files: UsageFile[], scanned: (file: ScannedFile) => void, ended: () => void) => void
  agents: () => readonly AgentWithUsage[]
  changed: (read: UsageRead) => void
}

const FILES_AT_ONCE = 16
export class UsageCache {
  private reading = false
  private readonly cached: PrivateRecordFile<CachedUsageFile>
  private readonly generations = new Map<BackendId, number>()

  constructor(private readonly deps: UsageCacheDeps) {
    this.cached = new PrivateRecordFile(deps.cacheFile)
  }

  async read(): Promise<UsageRead> {
    if (!this.reading) await this.refresh()
    return this.snapshot()
  }

  private snapshot(): UsageRead {
    return { ...this.rows(), reading: this.reading }
  }

  private changedFilesOf(backend: BackendId): void {
    this.generations.set(backend, (this.generations.get(backend) ?? 0) + 1)
  }

  private async refresh(): Promise<void> {
    this.reading = true
    const ended = (): void => {
      this.reading = false
      this.deps.changed(this.snapshot())
    }
    try {
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
        if (entry?.mtimeMs === stat.mtimeMs && entry.size === stat.size)
          entry.workspace = f.workspace
        else stale.set(f.file, { ...f, ...stat })
      })
      const gone = Object.keys(cached).filter((file) => !present.has(file))
      for (const file of gone) {
        this.changedFilesOf(cached[file].backend)
        delete cached[file]
      }
      if (!stale.size) {
        if (gone.length) this.cached.save()
        return ended()
      }
      this.deps.scan(
        [...stale.values()],
        ({ file, ...scanned }) => {
          const f = stale.get(file)
          if (!f) return
          this.changedFilesOf(f.backend)
          cached[file] = { ...f, ...scanned }
        },
        () => {
          this.cached.save()
          ended()
        }
      )
    } catch (error) {
      this.reading = false
      throw error
    }
  }

  private rows(): Pick<UsageRead, 'rows' | 'titles'> {
    const files = Object.values(this.cached.get())
    const agents = this.deps.agents()
    const recordsByFile = new Map<string, UsageRecord[]>()
    for (const { id, usage } of agents) {
      const own = files.filter((e) => e.backend === id)
      for (const [file, records] of usage.recordsOf(own, this.generations.get(id) ?? 0))
        recordsByFile.set(file, records)
    }
    const entries = files
      .map((e) => {
        const records = recordsByFile.get(e.file)
        return records && records !== e.records ? { ...e, records } : e
      })
      .filter((e) => e.records.length)
    const places = new Map(agents.map(({ id, usage }) => [id, usage.placesNow()]))
    const titles: Record<string, string> = {}
    const rows = entries.flatMap((e) => {
      const placesOfItsAgent = places.get(e.backend)
      const workspace = placesOfItsAgent?.workspaceOf(e) ?? e.workspace
      return e.records.map((r): UsageRow => {
        titles[r.sessionId] ??= placesOfItsAgent?.titleOf(r.sessionId, e.host) ?? ''
        return { ...r, backend: e.backend, workspace }
      })
    })
    return { rows, titles }
  }
}

export async function usageFilesOf(
  agents: readonly AgentWithUsage[],
  machines: readonly string[]
): Promise<UsageFile[]> {
  const found = await Promise.all(
    [undefined, ...machines].flatMap((machine) => agents.map(({ usage }) => usage.filesIn(machine)))
  )
  return found.flat()
}

export async function statOf(file: string): Promise<FileStat | undefined> {
  try {
    const { mtimeMs, size } = await fs.promises.stat(file)
    return { mtimeMs, size }
  } catch {
    return undefined
  }
}
