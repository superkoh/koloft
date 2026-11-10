import fs from 'fs'
import type { UsageSnapshot } from '@shared/types'
import { BackgroundFile } from './backgroundFile'

function readSnapshots(file: string): [string, UsageSnapshot][] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return Object.entries(raw).filter(
      (e): e is [string, UsageSnapshot] =>
        !!e[1] && typeof e[1] === 'object' && typeof (e[1] as UsageSnapshot).at === 'number'
    )
  } catch {
    return []
  }
}

export class SavedUsage {
  private readonly byKey: Map<string, UsageSnapshot>
  private readonly disk: BackgroundFile

  constructor(file: string) {
    this.byKey = new Map(readSnapshots(file))
    this.disk = new BackgroundFile(() => file)
  }

  get(key: string): UsageSnapshot | undefined {
    return this.byKey.get(key)
  }

  set(key: string, usage: UsageSnapshot): void {
    this.byKey.set(key, usage)
    this.save()
  }

  delete(key: string): void {
    if (this.byKey.delete(key)) this.save()
  }

  flushSync(): void {
    this.disk.flushSync()
  }

  private save(): void {
    this.disk.write(JSON.stringify(Object.fromEntries(this.byKey)))
  }
}
